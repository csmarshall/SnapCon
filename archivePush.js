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
  const ext = path.extname(base);
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
  const existing = await fsApi.readFile(target, bytes.length + 1);
  return crypto.createHash("sha256").update(existing).digest("hex") === sha256;
}

// One archive operation at a time per folder. A write to a share is not atomic:
// a second push arriving while the first is still being written would see a
// half-written file, decide it is different content, and store the same bytes
// again. Only this process writes the archive, so an in-process queue is enough.
const folderQueues = new Map();
function inFolderQueue(dir, fn) {
  const prev = folderQueues.get(dir) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  folderQueues.set(dir, tail);
  tail.then(() => { if (folderQueues.get(dir) === tail) folderQueues.delete(dir); });
  return run;
}

// Write `bytes` to `target` without ever leaving a partial file under that name:
// the bytes go to a hidden, uniquely named ".partial" file first (exclusive
// create; the Library skips dot-files), and only a complete file is renamed into
// place. A write that fails or times out part-way leaves just that hidden file.
// The caller has checked that `target` is free, under the folder queue above.
async function writeStaged(fsApi, target, bytes) {
  const partial = path.join(path.dirname(target), "." + path.basename(target) + "." + crypto.randomBytes(4).toString("hex") + ".partial");
  await fsApi.writeFileExclusive(partial, bytes);
  await fsApi.rename(partial, target);
}

/**
 * @param {object} o
 * @param {object} o.fsApi    { mkdir, exists, stat, readFile, writeFileExclusive, rename } — netfs in the server
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
    return await inFolderQueue(dir, async () => {
      await fsApi.mkdir(dir, { recursive: true });
      for (const candidate of candidateNames(name, sha256)) {
        const target = path.join(dir, candidate);
        if (!(await fsApi.exists(target))) {
          await writeStaged(fsApi, target, bytes);
          return { status: "archived", path: target };
        }
        // Name taken. Exactly these bytes: nothing to do. Anything else: try the
        // next name — an existing file is never overwritten.
        if (await sameContent(fsApi, target, bytes, sha256)) return { status: "duplicate", path: target };
      }
      return { status: "error", error: "every archive name for " + safeFileName(name) + " is taken by different content" };
    });
  } catch (e) {
    return { status: "error", error: e && e.message ? e.message : String(e) };
  }
}
module.exports = { archivePush, safeSegment, safeFileName, dateStamp, candidateNames, replayRootFor };
