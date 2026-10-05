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

// Folder-name safe version of a display name. Keeps letters, digits, dot, dash
// and underscore; everything else (spaces, slashes, quotes, dots-only names)
// becomes "_" so a user label can never escape the archive folder.
function safeSegment(s, fallback) {
  const cleaned = String(s == null ? "" : s).trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return cleaned || fallback;
}

function dateStamp(now) {
  // Local calendar date, so "today's prints" match the wall clock on the farm.
  const d = new Date(now);
  const pad = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// Candidate file names for one pushed file, in the order they are tried:
//   1. the plain name
//   2. the name with the first 8 hex chars of the content hash before the
//      extension (same name, different content, same user, same day)
function candidateNames(name, sha256) {
  const base = path.basename(String(name || "upload.gcode"));
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return [base, stem + "-" + sha256.slice(0, 8) + ext];
}

// True when `target` already holds exactly `bytes`. Size is compared first, so a
// different file is rejected without reading it; any error counts as "different".
async function sameContent(fsApi, target, bytes, sha256) {
  try {
    const st = await fsApi.stat(target);
    if (!st || st.size !== bytes.length) return false;
    const existing = await fsApi.readFile(target, bytes.length + 1);
    return crypto.createHash("sha256").update(existing).digest("hex") === sha256;
  } catch { return false; }
}

/**
 * @param {object} o
 * @param {object} o.fsApi    { mkdir, writeFileExclusive, stat, readFile } — netfs in the server
 * @param {string} o.root     the replay folder (already resolved)
 * @param {string|null} o.userLabel  who pushed it (actorFromReq(req).userLabel)
 * @param {string} o.name     the file name as pushed
 * @param {Buffer} o.bytes    the file content
 * @param {number} [o.now]    ms since epoch (tests pass a fixed value)
 * @returns {Promise<{status:"archived"|"duplicate"|"error", path?:string, error?:string}>}
 */
async function archivePush({ fsApi, root, userLabel, name, bytes, now = Date.now() }) {
  try {
    if (!Buffer.isBuffer(bytes) || !bytes.length) return { status: "error", error: "empty file" };
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const dir = path.join(root, safeSegment(userLabel, "unknown"), dateStamp(now));
    await fsApi.mkdir(dir, { recursive: true });
    for (const candidate of candidateNames(name, sha256)) {
      const target = path.join(dir, candidate);
      try {
        // Exclusive create: never overwrites something already archived.
        await fsApi.writeFileExclusive(target, bytes);
        return { status: "archived", path: target };
      } catch (e) {
        if (!e || e.code !== "EEXIST") throw e;
        // Name taken. If it already holds exactly these bytes, there is nothing to
        // do; otherwise fall through to the hash-suffixed name (and if THAT is
        // taken, the same bytes were archived under it already).
        if (await sameContent(fsApi, target, bytes, sha256)) return { status: "duplicate", path: target };
      }
    }
    return { status: "duplicate" };
  } catch (e) {
    return { status: "error", error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { archivePush, safeSegment, dateStamp, candidateNames };
