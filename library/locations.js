// library/locations.js — Library location paths: normalising them, refusing
// overlaps, and checking whether one is reachable right now.
//
// Pure path logic takes `platform` so the Windows rules (UNC shares,
// case-insensitive names, either slash) are testable on any machine.
"use strict";
const fs = require("fs");
const path = require("path");

function pathApi(platform) { return platform === "win32" ? path.win32 : path.posix; }

// An absolute, tidy path: relative input resolves against baseDir (as the
// G-code folder setting does); on Windows either slash is accepted and UNC
// shares keep their leading \\; trailing separators go, except on a root.
function normalizeLocation(input, { baseDir, platform = process.platform }) {
  const p = pathApi(platform);
  let s = String(input == null ? "" : input).trim().replace(/^"(.*)"$/, "$1");
  if (!s) return "";
  if (platform === "win32") s = s.replace(/\//g, "\\");
  s = p.resolve(baseDir, s);
  const root = p.parse(s).root;
  while (s.length > root.length && (s.endsWith(p.sep))) s = s.slice(0, -1);
  // A UNC share root parses with its trailing separator as part of the root
  // (\\host\share\); stored and shown without it, like every other location.
  if (platform === "win32" && /^\\\\[^\\]+\\[^\\]+\\$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Compared case-insensitively on Windows, where C:\Models and c:\models are
// the same folder.
function comparisonKey(absPath, platform = process.platform) {
  return platform === "win32" ? absPath.toLowerCase() : absPath;
}

// Two locations overlap when they are the same folder or one contains the
// other. Overlapping locations would index the same file twice and double
// every print count (§4, §6), so they are refused.
function overlaps(a, b, platform = process.platform) {
  const sep = pathApi(platform).sep;
  const ka = comparisonKey(a, platform), kb = comparisonKey(b, platform);
  const withSep = k => (k.endsWith(sep) ? k : k + sep);
  return ka === kb || ka.startsWith(withSep(kb)) || kb.startsWith(withSep(ka));
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error(`${what} did not answer within ${ms / 1000} s`); e.code = "ETIMEDOUT"; reject(e); }, ms); }),
  ]);
}

// Is the folder there and readable, right now?
//   ok       a readable directory
//   error    it answers but is wrong: missing while its parent exists, not a
//            folder, or unreadable. Needs an admin, not a retry.
//   offline  neither it nor its parent answers: a share or drive that is not
//            there at the moment. Retried with backoff; nothing is purged.
// A share that hangs is cut off at timeoutMs. The operating system may keep
// the underlying request running a while longer, so callers never start a
// second check of the same location while one is still in flight.
async function checkReachable(absPath, { timeoutMs = 10000, fsp = fs.promises } = {}) {
  const t0 = Date.now();
  const done = (status, extra = {}) => ({ status, ms: Date.now() - t0, ...extra });
  try {
    const st = await withTimeout(fsp.stat(absPath), timeoutMs, absPath);
    if (!st.isDirectory()) return done("error", { error: "not a folder", code: "ENOTDIR" });
    const d = await withTimeout(fsp.opendir(absPath), timeoutMs, absPath);
    await d.close();
    let realPath = absPath;
    try { realPath = await withTimeout(fsp.realpath(absPath), timeoutMs, absPath); } catch { /* keep the given path */ }
    return done("ok", { realPath });
  } catch (e) {
    if (e.code === "ETIMEDOUT") return done("offline", { error: e.message, code: e.code });
    if (e.code === "EACCES" || e.code === "EPERM") return done("error", { error: "not readable (" + e.code + ")", code: e.code });
    if (e.code === "ENOENT" || e.code === "ENOTDIR") {
      const parent = path.dirname(absPath);
      if (parent !== absPath) {
        try {
          const ps = await withTimeout(fsp.stat(parent), timeoutMs, parent);
          if (ps.isDirectory()) return done("error", { error: "folder not found", code: e.code });
        } catch { /* parent does not answer either: offline */ }
      }
    }
    return done("offline", { error: e.message, code: e.code || null });
  }
}

module.exports = { normalizeLocation, comparisonKey, overlaps, checkReachable, withTimeout };
