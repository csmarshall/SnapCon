// archivePush.js — keep a copy of every file a slicer pushes to SnapCon.
//
// A slicer push (the --snapcon CLI hook / Orca "Device" plugin, see
// /api/notify-load) lands in a temp file that is deleted as soon as the printer
// has the file. That is fine for the printer, but it means the sliced file —
// and the slicer settings Orca embeds in it — is gone, and nobody can answer
// "what settings did we use for that print three months ago?".
//
// This module writes one extra copy into a replay folder (config "replayFolder";
// by default <gcodeFolder>/Archive, which the Model Library already indexes),
// laid out as
//
//     <replayFolder>/<user>/<YYYY-MM-DD>/<file name>
//
// It is deliberately small and takes its filesystem as an argument (the server
// passes netfs, so a network share that is down is handled the usual way), which
// keeps it testable without a server.
//
// Contract: archiving NEVER blocks or fails a print. archivePush() always
// resolves; the caller decides what to log.

"use strict";

const path = require("path");
const crypto = require("crypto");

// Windows (and SMB/NTFS shares, wherever the server runs) refuse these as a
// file or folder name, with or without an extension.
const RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
// Room for the 64-char content hash that may be added to a file name, inside the
// 255-character limit most filesystems put on one path segment.
const MAX_NAME = 150;
// Longer than any real extension (".gcode", ".3mf", ".bgcode"); anything past
// it is treated as part of the name, so the cap can never cut a name down to a
// bare, hidden ".extension".
const MAX_EXT = 16;
// How many pushes may wait for one archive folder before more are refused. Each
// waiting push holds its file in memory, and each write may take up to
// ARCHIVE_IO_TIMEOUT_MS on a slow share; refusing (an error result, audited)
// bounds that instead of queueing without limit.
const MAX_QUEUED_PER_FOLDER = 8;
// The time a single archive read or write may take: the same budget netfs gives
// an exclusive write. netfs's default per-operation timeout is meant for small
// interactive calls, and a timeout marks the whole share offline, so a large
// duplicate check over a slow link must not run under it.
const ARCHIVE_IO_TIMEOUT_MS = 120000;
// Windows and SMB refuse to rename over a file something else has open
// (antivirus, the search indexer, the Library fingerprinting the new name, a
// person previewing it). That clears in moments, so the final rename is retried
// a few times, 250 ms apart, before the archive is reported as failed.
const RENAME_ATTEMPTS = 4;
const RENAME_RETRY_MS = 250;
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

// Folder-name safe version of a display name. Keeps letters and digits in any
// script, dot, dash and underscore; everything else (spaces, slashes, quotes,
// NTFS-reserved characters) becomes "_", so a user label can never escape the
// archive folder and two people's names don't collapse into the same folder.
// Leading dots (".", "..", hidden names) and trailing dots or spaces (which
// Windows silently drops) are removed; reserved device names get a "_" prefix.
function safeSegment(s, fallback) {
  let cleaned = String(s == null ? "" : s).trim().normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/, "_").replace(/[. ]+$/, "");
  if (RESERVED_NAMES.test(cleaned)) cleaned = "_" + cleaned;
  return cleaned.slice(0, MAX_NAME) || fallback;
}

// The pushed file name, made safe the same way: only its base name is used, the
// stem and extension are cleaned separately (so ".gcode" survives), and the
// total is capped with the extension kept.
function safeFileName(name) {
  const base = path.basename(String(name || "")).trim();
  const rawExt = path.extname(base);
  const ext = rawExt.length <= MAX_EXT + 1 ? rawExt : "";
  const stem = safeSegment(ext ? base.slice(0, -ext.length) : base, "upload");
  const cleanExt = ext ? "." + safeSegment(ext.slice(1), "") : "";
  if (!ext && stem === "upload") return "upload.gcode";
  return stem.slice(0, MAX_NAME - cleanExt.length) + cleanExt;
}

function dateStamp(now) {
  // Local calendar date, so "today's prints" match the wall clock on the farm.
  const d = new Date(now);
  const pad = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// The replay folder: "replayFolder" from config.json (relative to the app's own
// folder, or absolute), else <gcodeFolder>/Archive, which the Library indexes.
// Never throws: a malformed setting gives null, which archivePush() reports as
// an error instead of the push route failing.
function replayRootFor(replayFolder, baseDir, gcodeFolder) {
  if (replayFolder == null || replayFolder === "") return path.join(gcodeFolder, "Archive");
  if (typeof replayFolder !== "string") return null;
  return path.resolve(baseDir, replayFolder);
}

// Candidate file names for one pushed file, in the order they are tried:
//   1. the plain (safe) name
//   2. the name with the first 8 hex chars of the content hash before the
//      extension (same name, different content, same user, same day)
//   3. the name with the whole hash, should 2 also be taken by something else
function candidateNames(name, sha256) {
  const base = safeFileName(name);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return [base, stem + "-" + sha256.slice(0, 8) + ext, stem + "-" + sha256 + ext];
}

// True when `target` already holds exactly `bytes`. Size is compared first, so a
// different file is rejected without reading it. A read error is NOT treated as
// "different": it propagates, so the push is reported as failed instead of
// quietly storing a second copy or, worse, claiming one exists.
async function sameContent(fsApi, target, bytes, sha256) {
  const st = await fsApi.stat(target);
  if (!st || st.size !== bytes.length) return false;
  const existing = await fsApi.readFile(target, bytes.length + 1, { timeoutMs: ARCHIVE_IO_TIMEOUT_MS });
  return crypto.createHash("sha256").update(existing).digest("hex") === sha256;
}

// One archive operation at a time per folder. A write to a share is not atomic:
// a second push arriving while the first is still being written would see a
// half-written file, decide it is different content, and store the same bytes
// again. Only this process writes the archive, so an in-process queue is enough.
// The key ignores case: on APFS, SMB and NTFS "Charles" and "charles" are the
// same folder. Returns null when the folder already has MAX_QUEUED_PER_FOLDER
// pushes waiting.
const folderQueues = new Map();   // folder key -> { tail: Promise, waiting: number }
function inFolderQueue(dir, fn) {
  const key = dir.toLowerCase();
  const q = folderQueues.get(key) || { tail: Promise.resolve(), waiting: 0 };
  if (q.waiting >= MAX_QUEUED_PER_FOLDER) return null;
  q.waiting++;
  const run = q.tail.then(fn, fn);
  q.tail = run.catch(() => {}).then(() => { if (--q.waiting === 0 && folderQueues.get(key) === q) folderQueues.delete(key); });
  folderQueues.set(key, q);
  return run;
}

// Claim `target` and fill it, never overwriting anything and never leaving a
// partial file under that name. Works on every share (no hard links needed):
//   1. reserve the name with an exclusive create of an empty file — atomic, so
//      a name that exists for any reason (another push, a person, another
//      program) is refused with EEXIST rather than replaced;
//   2. write the bytes to a hidden, uniquely named ".partial" beside it
//      (exclusive create; the Library skips dot-files);
//   3. rename the complete file over our own empty placeholder.
// On a failure after step 1 the partial is removed, and our placeholder too
// while it is still empty (if the rename went through after all, the complete
// copy stays). Cleanup is best effort: on a share that has stopped answering it
// cannot run, and an interrupted partial or empty placeholder is removed by
// sweepPartials() at the next start. A failure of step 1 itself (other than
// EEXIST) removes nothing: there is no way to tell that the name is ours.
// Returns false when the name was already taken.
async function claimAndWrite(fsApi, target, bytes) {
  try { await fsApi.writeFileExclusive(target, Buffer.alloc(0)); }
  catch (e) { if (e && e.code === "EEXIST") return false; throw e; }
  const partial = path.join(path.dirname(target), "." + path.basename(target) + "." + crypto.randomBytes(4).toString("hex") + ".partial");
  try {
    await fsApi.writeFileExclusive(partial, bytes);
    await renameWithRetry(fsApi, partial, target);
    return true;
  } catch (e) {
    await fsApi.unlink(partial).catch(() => {});
    await fsApi.stat(target).then(st => st && st.size === 0 ? fsApi.unlink(target) : null).catch(() => {});
    throw e;
  }
}

async function renameWithRetry(fsApi, from, to) {
  for (let attempt = 1; ; attempt++) {
    try { return await fsApi.rename(from, to); }
    catch (e) {
      if (attempt >= RENAME_ATTEMPTS || !(e && RENAME_RETRY_CODES.has(e.code))) throw e;
      await new Promise(r => setTimeout(r, RENAME_RETRY_MS));
    }
  }
}

/**
 * @param {object} o
 * @param {object} o.fsApi    { mkdir, stat, readFile, writeFileExclusive, rename, unlink } — netfs in the server
 * @param {string|null} o.root the replay folder (from replayRootFor; null when misconfigured)
 * @param {string|null} o.userLabel  who pushed it (actorFromReq(req).userLabel)
 * @param {string} o.name     the file name as pushed
 * @param {Buffer} o.bytes    the file content
 * @param {number} [o.now]    ms since epoch (tests pass a fixed value)
 * @returns {Promise<{status:"archived"|"duplicate"|"error", path?:string, error?:string}>}
 */
async function archivePush({ fsApi, root, userLabel, name, bytes, now = Date.now() }) {
  try {
    if (typeof root !== "string" || !root) return { status: "error", error: "replayFolder in config.json must be a folder path" };
    if (!Buffer.isBuffer(bytes) || !bytes.length) return { status: "error", error: "empty file" };
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const dir = path.join(root, safeSegment(userLabel, "unknown"), dateStamp(now));
    const queued = inFolderQueue(dir, async () => {
      await fsApi.mkdir(dir, { recursive: true });
      for (const candidate of candidateNames(name, sha256)) {
        const target = path.join(dir, candidate);
        if (await claimAndWrite(fsApi, target, bytes)) return { status: "archived", path: target };
        // Name taken. Exactly these bytes: nothing to do. Anything else: try the
        // next name — an existing file is never overwritten.
        if (await sameContent(fsApi, target, bytes, sha256)) return { status: "duplicate", path: target };
      }
      return { status: "error", error: "every archive name for " + safeFileName(name) + " is taken by different content" };
    });
    if (!queued) return { status: "error", error: "archive folder busy: " + MAX_QUEUED_PER_FOLDER + " pushes already waiting" };
    return await queued;
  } catch (e) {
    return { status: "error", error: e && e.message ? e.message : String(e) };
  }
}
// Start archivePush() and return at once: nothing for the caller to await, so a
// slow or unreachable share can never hold up the push route. `onDone` receives
// the result; if it throws (say, the audit log is unavailable) that is logged
// rather than left as an unhandled rejection.
function archiveInBackground({ onDone, ...args }) {
  Promise.resolve()
    .then(() => archivePush(args))
    .then(result => onDone(result))
    .catch(e => console.warn("[archive] could not record the archive result for " + args.name + ": " + (e && e.message ? e.message : e)));
}

// The audit-log entry for one archive result: "file-archived" for a kept copy
// (new or already there), "file-archive-failed" otherwise.
function archiveAuditEntry(arch, { actor, printer, name }) {
  const base = { category: "job", ...actor, printerId: printer.id, printerName: printer.name };
  if (arch.status === "error") return { ...base, event: "file-archive-failed", detail: { file: name, error: arch.error } };
  return { ...base, event: "file-archived", detail: { file: name, result: arch.status, archivedAs: arch.path } };
}

// Remove what a failed or interrupted archive could not clean up (a crash
// mid-write, a share that dropped): hidden ".partial" files ("." + name + "." +
// 8 hex + ".partial") and empty placeholders, two levels down (<user>/<date>/).
// Empty files are only removed from folders named like a date (YYYY-MM-DD), the
// archive's own layout. Only files older than `olderThanMs` are touched, so a
// write in progress is never removed. Never throws; returns the paths removed.
const PARTIAL_NAME = /^\..+\.[0-9a-f]{8}\.partial$/;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
async function sweepPartials({ fsApi, root, now, olderThanMs }) {
  const removed = [];
  if (typeof root !== "string" || !root) return removed;
  const dirsIn = async p => { try { return (await fsApi.readdir(p)).filter(e => e.isDirectory).map(e => path.join(p, e.name)); } catch { return []; } };
  for (const userDir of await dirsIn(root)) {
    for (const dateDir of await dirsIn(userDir)) {
      let entries;
      try { entries = await fsApi.readdir(dateDir); } catch { continue; }
      const isDateDir = DATE_DIR.test(path.basename(dateDir));
      for (const e of entries) {
        if (!e.isFile) continue;
        const partial = PARTIAL_NAME.test(e.name);
        if (!partial && (!isDateDir || e.name.startsWith("."))) continue;
        const p = path.join(dateDir, e.name);
        try {
          const st = await fsApi.stat(p);
          if (now - st.mtimeMs < olderThanMs) continue;
          // Besides partials, only empty files: an archive placeholder whose
          // fill never finished. The archive never stores an empty push.
          if (!partial && st.size !== 0) continue;
          await fsApi.unlink(p);
          removed.push(p);
        } catch { /* gone already, or the share dropped: next sweep */ }
      }
    }
  }
  return removed;
}

module.exports = { archivePush, archiveInBackground, archiveAuditEntry, sweepPartials, safeSegment, safeFileName, dateStamp, candidateNames, replayRootFor, MAX_QUEUED_PER_FOLDER, ARCHIVE_IO_TIMEOUT_MS, RENAME_ATTEMPTS };
