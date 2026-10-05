// updateCheck.js — "update available": asks GitHub for SnapCon's latest
// release at startup and once a day, and keeps the answer in
// data/update-check.json so a restart doesn't ask again.
//
// The request carries only what any HTTPS request carries (a User-Agent
// naming the SnapCon version, which GitHub requires) — no token, nothing
// about the farm. GitHub's text (the release name) is untrusted: it goes to
// the browser as plain strings and is rendered as text there.
//
// The decisions are pure functions so they can be tested without timers or
// a network: compareVersions(), shouldCheck(), nextState().
const fs = require("fs");
const path = require("path");

// The project's GitHub repository (also package.json "repository").
const REPO = "ezeitoun/SnapCon";
const RELEASES_PAGE = "https://github.com/" + REPO + "/releases";
const LATEST_URL = "https://api.github.com/repos/" + REPO + "/releases/latest";

const DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
const JITTER_MS = 30 * 60 * 1000;
const MANUAL_MIN_MS = 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
// A rate-limit reset from GitHub is honoured only if it lies within this
// window. A missing one, or one already in the past, means no wait; anything
// malformed or absurd (a broken proxy, a hand-edited cache) becomes a fixed
// short wait. So a bad value can never throw or block checks indefinitely.
const RATE_LIMIT_MAX_MS = 2 * 60 * 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 60 * 60 * 1000;

// ---- versions ----

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v == null ? "" : v).trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null } : null;
}

// >0 when a is newer than b, 0 when equal, <0 when older, null when either
// doesn't parse. A pre-release (0.9.0-beta.1) is lower than its release.
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xa = x.pre.split("."), ya = y.pre.split(".");
  for (let i = 0; i < Math.max(xa.length, ya.length); i++) {
    if (xa[i] === undefined) return -1;
    if (ya[i] === undefined) return 1;
    const xn = /^\d+$/.test(xa[i]), yn = /^\d+$/.test(ya[i]);
    if (xn && yn && Number(xa[i]) !== Number(ya[i])) return Number(xa[i]) - Number(ya[i]);
    if (xn !== yn) return xn ? -1 : 1;
    if (xa[i] !== ya[i]) return xa[i] < ya[i] ? -1 : 1;
  }
  return 0;
}

// Only a strictly newer release counts; anything unparsable is "not newer",
// so a development build ahead of the latest release shows nothing.
function isNewer(latest, current) {
  const c = compareVersions(latest, current);
  return c !== null && c > 0;
}

// ---- when to check ----

const ms = t => (t == null ? null : typeof t === "number" ? t : (Number.isFinite(Date.parse(t)) ? Date.parse(t) : null));

// Pure. A manual "Check now" skips the 24-hour freshness rule and works even
// with the setting off, but still respects the 60-second manual limit and a
// GitHub rate-limit "don't retry before". Scheduled checks need the setting
// on and a result older than a day (or none). Freshness is measured from the
// last successful check, so a failed attempt doesn't count as a fresh answer.
function shouldCheck({ enabled, lastSuccessAt, now, retryAfter, manual, lastManualAt }) {
  // A stored "don't retry before" is honoured only within the rate-limit
  // window, so an absurd value (e.g. a hand-edited cache) can't block forever.
  const retry = ms(retryAfter);
  if (retry !== null && now < retry && retry - now <= RATE_LIMIT_MAX_MS) return false;
  if (manual) {
    const last = ms(lastManualAt);
    return last === null || now - last >= MANUAL_MIN_MS;
  }
  if (!enabled) return false;
  const success = ms(lastSuccessAt);
  return success === null || now - success >= DAY_MS;
}

// ---- reading GitHub's answer ----

// When to try again after a 403/429, from GitHub's X-RateLimit-Reset (epoch
// seconds). Pure, and never throws: see RATE_LIMIT_MAX_MS.
function rateLimitRetryAt(reset, nowMs) {
  if (reset == null || reset === "") return null;
  const at = Number(reset) * 1000;
  if (Number.isFinite(at) && at <= nowMs) return null; // already reset
  const when = Number.isFinite(at) && at - nowMs <= RATE_LIMIT_MAX_MS ? at : nowMs + RATE_LIMIT_FALLBACK_MS;
  return new Date(when).toISOString();
}

function releasePageUrl(url) {
  const s = typeof url === "string" ? url : "";
  return s.startsWith(RELEASES_PAGE + "/") ? s : RELEASES_PAGE;
}

// Pure. The cached state after one attempt. `outcome` is either
// { error: true } (network failure or timeout) or the response's
// { status, etag, rateLimitReset, body } with body as raw text. Successful
// answers (200, 304, 404) record lastSuccessAt and clear lastError and any
// stale retryAfter; failures keep the last good result.
function nextState(prev, outcome, nowIso) {
  const base = { ...prev, checkedAt: nowIso };
  const success = extra => ({ ...base, ...extra, lastSuccessAt: nowIso, lastError: null, retryAfter: null });
  const fail = (code, extra) => ({ ...base, ...extra, lastError: code });
  if (!outcome || outcome.error) return fail("unreachable");
  const { status } = outcome;
  if (status === 304) return success({});
  if (status === 404) return success({ noRelease: true, latestVersion: null, releaseUrl: null, releaseName: null, publishedAt: null, etag: null });
  if (status === 403 || status === 429) {
    return fail("rate_limited", { retryAfter: rateLimitRetryAt(outcome.rateLimitReset, Date.parse(nowIso)) });
  }
  if (status !== 200) return fail("bad_response");
  let rel;
  try { rel = JSON.parse(outcome.body); } catch { return fail("bad_response"); }
  const v = rel && parseVersion(rel.tag_name);
  if (!v) return fail("bad_response");
  const published = typeof rel.published_at === "string" && Number.isFinite(Date.parse(rel.published_at)) ? rel.published_at : null;
  return success({
    noRelease: false,
    latestVersion: String(rel.tag_name).trim().replace(/^v/, ""),
    releaseUrl: releasePageUrl(rel.html_url),
    releaseName: typeof rel.name === "string" ? rel.name.slice(0, 200) : null,
    publishedAt: published,
    etag: outcome.etag || null,
  });
}

// ---- the cache file ----

function cachePath(baseDir) { return path.join(baseDir, "data", "update-check.json"); }

// A missing or unreadable file means "never checked"; it's a cache, so the
// next check simply rewrites it.
function loadCache(baseDir, log = console) {
  let raw;
  try { raw = fs.readFileSync(cachePath(baseDir), "utf8"); }
  catch (e) { if (e.code !== "ENOENT") log.warn("[update-check] could not read the cache:", e.message); return {}; }
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) {
    log.warn("[update-check] cache is not valid JSON; treating it as never checked");
    return {};
  }
}
function saveCache(baseDir, state, log = console) {
  const file = cachePath(baseDir), tmp = file + ".tmp";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) { log.warn("[update-check] could not save the cache:", e.message); }
}

// ---- the checker ----

function createUpdateChecker({
  baseDir, version, isEnabled,
  fetchFn = globalThis.fetch, now = () => Date.now(), random = Math.random,
  setTimer = setTimeout, clearTimer = clearTimeout, log = console,
}) {
  let state = loadCache(baseDir, log);
  let timer = null, inFlight = null, lastManualAt = null;

  function status() {
    const latest = state.latestVersion || null;
    return {
      enabled: !!isEnabled(), current: version, latest,
      updateAvailable: !!latest && isNewer(latest, version),
      noRelease: !!state.noRelease,
      releaseUrl: state.releaseUrl || null, releaseName: state.releaseName || null, publishedAt: state.publishedAt || null,
      checkedAt: state.checkedAt || null, lastSuccessAt: state.lastSuccessAt || null,
      lastError: state.lastError || null, retryAfter: state.retryAfter || null,
    };
  }

  async function attempt() {
    const headers = { "Accept": "application/vnd.github+json", "User-Agent": "SnapCon/" + version, "X-GitHub-Api-Version": "2022-11-28" };
    if (state.etag && (state.latestVersion || state.noRelease)) headers["If-None-Match"] = state.etag;
    let outcome;
    try {
      const res = await fetchFn(LATEST_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      outcome = {
        status: res.status,
        etag: res.headers.get("etag"),
        rateLimitReset: res.headers.get("x-ratelimit-reset"),
        body: res.status === 200 ? await res.text() : null,
      };
    } catch { outcome = { error: true }; }
    const at = new Date(now()).toISOString();
    // nextState() is written not to throw; this is the safety net so the
    // checker can never disrupt SnapCon if it somehow does.
    try { state = nextState(state, outcome, at); }
    catch (e) { log.warn("[update-check] unexpected answer:", e.message); state = { ...state, checkedAt: at, lastError: "bad_response" }; }
    saveCache(baseDir, state, log);
  }
  // One attempt at a time; callers that arrive mid-attempt share its result.
  function run() {
    if (!inFlight) inFlight = attempt().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function checkNow() {
    if (shouldCheck({ manual: true, now: now(), lastManualAt, retryAfter: state.retryAfter })) {
      lastManualAt = now();
      await run();
    } else if (inFlight) {
      // Throttled, but a check is already running: share its result rather
      // than answer with the state from before it.
      await inFlight.catch(() => {});
    }
    return status();
  }

  let stopped = false;
  function clear() { if (timer) { clearTimer(timer); timer = null; } }
  function schedule(delay) {
    clear();
    // stop() wins even over a check that was already running when it was
    // called: that check finishes, but arms nothing afterwards.
    if (stopped || !isEnabled()) return;
    timer = setTimer(async () => {
      timer = null;
      if (shouldCheck({ enabled: isEnabled(), lastSuccessAt: state.lastSuccessAt, now: now(), retryAfter: state.retryAfter })) {
        try { await run(); } catch (e) { log.warn("[update-check]", e.message); }
      }
      schedule(DAY_MS + (random() * 2 - 1) * JITTER_MS);
    }, delay);
    if (timer && timer.unref) timer.unref();
  }

  return {
    status, checkNow,
    // After the server is listening: the first look 30 s later, then daily.
    start() { stopped = false; schedule(STARTUP_DELAY_MS); },
    // After a settings save: off clears the timer; on schedules the next look.
    reschedule() { if (stopped) return; if (!isEnabled()) clear(); else if (!timer) schedule(STARTUP_DELAY_MS); },
    stop() { stopped = true; clear(); },
    hasTimer: () => timer !== null,
  };
}

module.exports = { REPO, RELEASES_PAGE, LATEST_URL, compareVersions, isNewer, shouldCheck, nextState, rateLimitRetryAt, loadCache, saveCache, createUpdateChecker };
