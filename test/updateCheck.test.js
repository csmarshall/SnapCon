// test/updateCheck.test.js — the "update available" check (updateCheck.js):
// version comparison, when to check, reading GitHub's answer, the cache
// file, and the checker's timers. No test touches the network: fetch is a
// stub, and timers are injected.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const u = require("../updateCheck");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-update-"));
const quiet = { warn() {}, log() {}, error() {} };
const NOW = Date.parse("2026-10-05T18:00:00Z");
const iso = t => new Date(t).toISOString();

// ---- compareVersions ----

test("compareVersions: numeric parts, v prefix, pre-releases, unparsable", () => {
  assert.ok(u.compareVersions("0.10.0", "0.9.0") > 0, "0.10.0 is newer than 0.9.0");
  assert.equal(u.compareVersions("v0.9.0", "0.9.0"), 0);
  assert.ok(u.compareVersions("0.9.0-beta.1", "0.9.0") < 0, "a pre-release is lower than its release");
  assert.ok(u.compareVersions("0.9.0-beta.2", "0.9.0-beta.1") > 0);
  assert.equal(u.compareVersions("0.9.0", "0.9.0"), 0);
  assert.equal(u.compareVersions("latest", "0.9.0"), null);
  assert.equal(u.isNewer("latest", "0.8.0"), false, "unparsable is not newer");
  assert.equal(u.isNewer("0.7.2", "0.8.0"), false, "a dev build ahead of the latest release shows nothing");
  assert.equal(u.isNewer("0.9.0", "0.8.0"), true);
});

// ---- shouldCheck ----

test("shouldCheck: scheduled checks need the setting on and a stale or missing result", () => {
  assert.equal(u.shouldCheck({ enabled: false, now: NOW }), false, "off: no scheduled check");
  assert.equal(u.shouldCheck({ enabled: true, now: NOW }), true, "never checked");
  assert.equal(u.shouldCheck({ enabled: true, now: NOW, lastSuccessAt: iso(NOW - 3600e3) }), false, "fresh cache");
  assert.equal(u.shouldCheck({ enabled: true, now: NOW, lastSuccessAt: iso(NOW - 25 * 3600e3) }), true, "stale cache");
});

test("shouldCheck: Check now skips freshness and the setting, but not the 60 s limit or a rate limit", () => {
  assert.equal(u.shouldCheck({ manual: true, enabled: false, now: NOW, lastSuccessAt: iso(NOW - 1000) }), true);
  assert.equal(u.shouldCheck({ manual: true, now: NOW, lastManualAt: NOW - 30e3 }), false, "within 60 s of the last Check now");
  assert.equal(u.shouldCheck({ manual: true, now: NOW, lastManualAt: NOW - 61e3 }), true);
  assert.equal(u.shouldCheck({ manual: true, now: NOW, retryAfter: iso(NOW + 600e3) }), false, "GitHub said not before then");
  assert.equal(u.shouldCheck({ enabled: true, now: NOW, retryAfter: iso(NOW + 600e3) }), false);
  assert.equal(u.shouldCheck({ enabled: true, now: NOW, retryAfter: iso(NOW - 1) }), true, "an expired retry time no longer blocks");
});

// ---- reading GitHub's answer ----

const release = { tag_name: "v0.9.0", html_url: "https://github.com/ezeitoun/SnapCon/releases/tag/v0.9.0", name: "SnapCon 0.9.0", published_at: "2026-10-02T14:00:00Z" };
const at = iso(NOW);

test("200: reads the release, stores the ETag, records a success", () => {
  const s = u.nextState({ lastError: "unreachable", retryAfter: iso(NOW - 1) }, { status: 200, etag: '"abc"', body: JSON.stringify(release) }, at);
  assert.equal(s.latestVersion, "0.9.0");
  assert.equal(s.releaseUrl, release.html_url);
  assert.equal(s.releaseName, "SnapCon 0.9.0");
  assert.equal(s.etag, '"abc"');
  assert.equal(s.checkedAt, at);
  assert.equal(s.lastSuccessAt, at);
  assert.equal(s.lastError, null);
  assert.equal(s.retryAfter, null, "a success clears an obsolete retry time");
});

test("304: keeps the cached release and counts as a success", () => {
  const prev = { latestVersion: "0.9.0", releaseUrl: release.html_url, etag: '"abc"', lastSuccessAt: iso(NOW - 2 * 86400e3), lastError: "unreachable" };
  const s = u.nextState(prev, { status: 304 }, at);
  assert.equal(s.latestVersion, "0.9.0");
  assert.equal(s.etag, '"abc"');
  assert.equal(s.lastSuccessAt, at);
  assert.equal(s.lastError, null);
});

test("404: no releases yet is a success, not an error", () => {
  const s = u.nextState({ latestVersion: "0.9.0" }, { status: 404 }, at);
  assert.equal(s.noRelease, true);
  assert.equal(s.latestVersion, null);
  assert.equal(s.lastError, null);
  assert.equal(s.lastSuccessAt, at);
});

test("403/429: rate limited — keeps the last good result and the reset time", () => {
  const prev = { latestVersion: "0.9.0", lastSuccessAt: iso(NOW - 3600e3) };
  const reset = Math.floor(NOW / 1000) + 900;
  const s = u.nextState(prev, { status: 403, rateLimitReset: String(reset) }, at);
  assert.equal(s.lastError, "rate_limited");
  assert.equal(s.retryAfter, iso(reset * 1000));
  assert.equal(s.latestVersion, "0.9.0");
  assert.equal(s.lastSuccessAt, prev.lastSuccessAt, "an attempt is not a success");
  assert.equal(s.checkedAt, at);
  assert.equal(u.nextState(prev, { status: 429 }, at).lastError, "rate_limited");
});

test("network failure, timeout, odd status, bad JSON or tag: quiet error, last good result kept", () => {
  const prev = { latestVersion: "0.9.0", lastSuccessAt: iso(NOW - 3600e3) };
  for (const outcome of [{ error: true }, { status: 500 }, { status: 200, body: "<html>" }, { status: 200, body: JSON.stringify({ ...release, tag_name: "nightly" }) }]) {
    const s = u.nextState(prev, outcome, at);
    assert.ok(s.lastError, JSON.stringify(outcome));
    assert.equal(s.latestVersion, "0.9.0");
    assert.equal(s.lastSuccessAt, prev.lastSuccessAt);
  }
  assert.equal(u.nextState(prev, { error: true }, at).lastError, "unreachable");
});

test("a release link that isn't this repo's releases page falls back to the releases page", () => {
  const s = u.nextState({}, { status: 200, body: JSON.stringify({ ...release, html_url: "https://evil.example/releases/tag/v0.9.0" }) }, at);
  assert.equal(s.releaseUrl, "https://github.com/ezeitoun/SnapCon/releases");
});

// ---- the cache file ----

test("a missing or corrupt cache file means never checked", () => {
  const d = tmpDir();
  assert.deepEqual(u.loadCache(d, quiet), {}, "missing");
  fs.mkdirSync(path.join(d, "data"));
  fs.writeFileSync(path.join(d, "data", "update-check.json"), "{not json");
  assert.deepEqual(u.loadCache(d, quiet), {}, "corrupt");
  u.saveCache(d, { latestVersion: "0.9.0" }, quiet);
  assert.equal(u.loadCache(d, quiet).latestVersion, "0.9.0", "round trip");
});

// ---- the checker, with a stub fetch and fake timers ----

function fakeTimers() {
  const live = new Set();
  return {
    live,
    setTimer(fn, delay) { const t = { fn, delay }; live.add(t); return t; },
    clearTimer(t) { live.delete(t); },
    async fire() { const [t] = live; live.delete(t); await t.fn(); },
  };
}
function stubFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { status: r.status, headers: { get: h => (r.headers || {})[h.toLowerCase()] ?? null }, text: async () => r.body ?? "" };
  };
  return { fn, calls };
}

test("Check now asks GitHub once, sends only the standard headers, and reuses the ETag", async () => {
  const d = tmpDir(), timers = fakeTimers();
  const f = stubFetch([{ status: 200, headers: { etag: '"e1"' }, body: JSON.stringify(release) }, { status: 304 }]);
  let now = NOW;
  const c = u.createUpdateChecker({ baseDir: d, version: "0.8.0", isEnabled: () => true, fetchFn: f.fn, now: () => now, log: quiet, ...timers });
  const s = await c.checkNow();
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest, "0.9.0");
  assert.equal(f.calls[0].url, "https://api.github.com/repos/ezeitoun/SnapCon/releases/latest");
  assert.deepEqual(Object.keys(f.calls[0].headers).sort(), ["Accept", "User-Agent", "X-GitHub-Api-Version"]);
  assert.equal(f.calls[0].headers["User-Agent"], "SnapCon/0.8.0");
  await c.checkNow();
  assert.equal(f.calls.length, 1, "a second Check now within 60 s returns the cached result");
  now += 61e3;
  await c.checkNow();
  assert.equal(f.calls[1].headers["If-None-Match"], '"e1"');
  assert.equal(c.status().lastSuccessAt, iso(now), "the 304 counts as a success");
  assert.equal(u.loadCache(d, quiet).latestVersion, "0.9.0", "persisted");
});

test("with the setting off, no timer runs at all — Check now still works", async () => {
  const d = tmpDir(), timers = fakeTimers();
  let enabled = false;
  const f = stubFetch([{ status: 200, body: JSON.stringify(release) }]);
  const c = u.createUpdateChecker({ baseDir: d, version: "0.8.0", isEnabled: () => enabled, fetchFn: f.fn, now: () => NOW, log: quiet, ...timers });
  c.start();
  assert.equal(timers.live.size, 0, "start() with the setting off schedules nothing");
  assert.equal(c.hasTimer(), false);
  await c.checkNow();
  assert.equal(f.calls.length, 1);
  enabled = true; c.reschedule();
  assert.equal(timers.live.size, 1, "turning it on schedules the next look");
  enabled = false; c.reschedule();
  assert.equal(timers.live.size, 0, "turning it off clears the timer");
});

test("scheduled: first look after 30 s only if stale, then daily with jitter; a failure is quiet", async () => {
  const d = tmpDir(), timers = fakeTimers();
  const f = stubFetch([new Error("ENOTFOUND")]);
  const c = u.createUpdateChecker({ baseDir: d, version: "0.8.0", isEnabled: () => true, fetchFn: f.fn, now: () => NOW, random: () => 1, log: quiet, ...timers });
  c.start();
  assert.equal([...timers.live][0].delay, 30e3);
  await timers.fire();
  assert.equal(f.calls.length, 1, "never checked → checks");
  assert.equal(c.status().lastError, "unreachable");
  assert.equal([...timers.live][0].delay, 24 * 3600e3 + 30 * 60e3, "next look a day later, jittered");
  c.stop();
  assert.equal(timers.live.size, 0);
});

test("scheduled: a fresh cache from a previous run means no request at startup", async () => {
  const d = tmpDir(), timers = fakeTimers();
  u.saveCache(d, { latestVersion: "0.9.0", lastSuccessAt: iso(NOW - 3600e3), checkedAt: iso(NOW - 3600e3) }, quiet);
  const f = stubFetch([]);
  const c = u.createUpdateChecker({ baseDir: d, version: "0.8.0", isEnabled: () => true, fetchFn: f.fn, now: () => NOW, log: quiet, ...timers });
  c.start();
  await timers.fire();
  assert.equal(f.calls.length, 0);
  assert.equal(c.status().updateAvailable, true, "the cached answer is still shown");
});

// ---- review fixes: a bad rate-limit reset, a shared in-flight check, stop() ----

test("a malformed or absurd rate-limit reset never throws and never blocks for long", () => {
  const H = 3600e3;
  assert.equal(u.rateLimitRetryAt(String(Math.floor(NOW / 1000) + 900), NOW), iso(Math.floor(NOW / 1000) * 1000 + 900e3), "a sane reset is honoured");
  for (const bad of ["1e13", "9999999999999999", "253402300799", "abc", "Infinity"]) {
    let at;
    assert.doesNotThrow(() => { at = u.rateLimitRetryAt(bad, NOW); }, bad);
    assert.equal(at, iso(NOW + H), bad + " → a fixed one-hour wait");
  }
  assert.equal(u.rateLimitRetryAt(String(Math.floor(NOW / 1000) - 60), NOW), null, "already reset: no wait");
  assert.equal(u.rateLimitRetryAt(null, NOW), null, "no header: no wait");
  // The reported crash: nextState() with a 1e13 reset used to throw a RangeError.
  assert.doesNotThrow(() => u.nextState({}, { status: 403, rateLimitReset: "1e13" }, iso(NOW)));
  assert.equal(u.nextState({}, { status: 403, rateLimitReset: "1e13" }, iso(NOW)).retryAfter, iso(NOW + H));
});

test("a stored retry time far in the future (e.g. a hand-edited cache) is ignored", () => {
  assert.equal(u.shouldCheck({ manual: true, now: NOW, retryAfter: "9999-12-31T23:59:59.000Z" }), true);
  assert.equal(u.shouldCheck({ enabled: true, now: NOW, retryAfter: iso(NOW + 3 * 3600e3) }), true);
  assert.equal(u.shouldCheck({ manual: true, now: NOW, retryAfter: iso(NOW + 30 * 60e3) }), false, "a sane one still blocks");
});

test("Check now with an absurd rate-limit reset resolves, and checks resume after the fixed wait", async () => {
  const d = tmpDir(), timers = fakeTimers();
  const f = stubFetch([{ status: 403, headers: { "x-ratelimit-reset": "1e13" } }, { status: 200, body: JSON.stringify(release) }]);
  let now = NOW;
  const c = u.createUpdateChecker({ baseDir: d, version: "0.8.0", isEnabled: () => true, fetchFn: f.fn, now: () => now, log: quiet, ...timers });
  const s = await c.checkNow();
  assert.equal(s.lastError, "rate_limited");
  assert.equal(s.retryAfter, iso(NOW + 3600e3));
  now += 61e3;
  await c.checkNow();
  assert.equal(f.calls.length, 1, "still inside the one-hour wait");
  now = NOW + 3600e3 + 1;
  assert.equal((await c.checkNow()).latest, "0.9.0", "after it, Check now works again");
});

test("a throttled Check now while a check is running gets that check's result, not the old state", async () => {
  const d = tmpDir(), timers = fakeTimers();
  let release200;
  const gate = new Promise(r => { release200 = r; });
  const fetchFn = async () => { await gate; return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(release) }; };
  const c = u.createUpdateChecker({ baseDir: d, version: "0.8.0", isEnabled: () => true, fetchFn, now: () => NOW, log: quiet, ...timers });
  const first = c.checkNow();
  const second = c.checkNow(); // within 60 s: throttled, but the first is still running
  release200();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.latest, "0.9.0");
  assert.equal(b.latest, "0.9.0", "the second caller waited for the running check");
});

test("stop() during a running scheduled check: the check finishes but arms no new timer", async () => {
  const d = tmpDir(), timers = fakeTimers();
  let finish;
  const gate = new Promise(r => { finish = r; });
  const fetchFn = async () => { await gate; return { status: 404, headers: { get: () => null }, text: async () => "" }; };
  const c = u.createUpdateChecker({ baseDir: d, version: "0.8.0", isEnabled: () => true, fetchFn, now: () => NOW, log: quiet, ...timers });
  c.start();
  const [t] = timers.live; timers.live.delete(t);
  const running = t.fn(); // the scheduled check starts and waits on GitHub
  c.stop();
  finish();
  await running;
  assert.equal(timers.live.size, 0, "nothing re-armed after stop()");
  assert.equal(c.hasTimer(), false);
  c.reschedule();
  assert.equal(timers.live.size, 0, "a settings save after stop() doesn't re-arm either");
});
