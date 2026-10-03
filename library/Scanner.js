// library/Scanner.js — indexes one Library location (docs/library-design.md
// §6.1): enumerate and stat, quick fingerprints for new or changed files,
// moves, extraction, and at the end missing files and folder classes. Plus
// the full hash of every file, later, at idle.
//
// Division of work:
//   - all file access is here, on the main thread, through netfs's BACKGROUND
//     lane (one operation at a time, never interactive capacity) — so a dead
//     share fails the scan through the shared availability breaker instead of
//     hanging anything (§23);
//   - all parsing and every database write is in the Library worker
//     (indexer-worker.js), so node:sqlite never blocks the server.
//
// Throttling (§6.1): concurrency 1, a bandwidth budget, and a pause while
// SnapCon is uploading to a printer. Unchanged files cost one stat (they come
// with the directory listing).
"use strict";
const path = require("path");
const crypto = require("crypto");
const gcodeExtract = require("./gcodeExtract");
const { GCODE_META_VERSION, THREEMF_META_VERSION } = require("./indexStore");
const { openZipAsync } = require("./zipReader");
const { wantedEntries } = require("./threemfExtract");

const LANE = "background";
const DEFAULT_BUDGET = 16 * 1024 * 1024;   // bytes per second, reads of every kind
const TOUCH_BATCH = 500;
const STREAM_CHUNK = 1024 * 1024;
const READ_MAX = 1024 * 1024;

const ROLES = {
  stl: "source", obj: "source", step: "source", stp: "source", amf: "source", ply: "source", f3d: "source", scad: "source", blend: "source",
  "3mf": "project",
  gcode: "sliced", gco: "sliced", g: "sliced", gx: "sliced", bgcode: "sliced",
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", bmp: "image",
  pdf: "document", txt: "document", md: "document", html: "document", htm: "document",
  zip: "archive", "7z": "archive", rar: "archive",
};
const GCODE_TEXT = new Set(["gcode", "gco", "g", "gx"]);   // read as text; .bgcode is binary (not in 1a)
const SKIP_DIR = /^(?:\.|@eadir$|#recycle$|\$recycle\.bin$|system volume information$)/i;
const SKIP_FILE = /^(?:\.|thumbs\.db$|desktop\.ini$|~\$)/i;

function roleOf(name) {
  const lower = name.toLowerCase();
  if (/\.gcode\.3mf$/.test(lower)) return "sliced";
  const ext = path.extname(lower).slice(1);
  return ROLES[ext] || "other";
}
const extOf = name => path.extname(name).slice(1).toLowerCase();
const wantsGcode = name => GCODE_TEXT.has(extOf(name)) && !/\.gcode\.3mf$/i.test(name);
const is3mf = name => extOf(name) === "3mf";
// The extraction version a file of this kind is read under; 0 = not read at all.
const metaVersionFor = name => (wantsGcode(name) ? GCODE_META_VERSION : is3mf(name) ? THREEMF_META_VERSION : 0);
const needsReading = (name, row) => metaVersionFor(name) > 0 && (!row || row.meta_version < metaVersionFor(name));

class ScanStopped extends Error { constructor(why) { super("scan stopped: " + why); this.code = "SCAN_STOPPED"; this.why = why; } }

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const summarise = arr => ({ n: arr.length, p50: pct(arr, 0.5), p90: pct(arr, 0.9), max: arr.length ? Math.max(...arr) : null });

function createScanner({
  netfs, worker, readDb, dbPath, thumbsDir, log = console, now = Date.now,
  uploadsActive = () => false, budgetBytesPerSec = DEFAULT_BUDGET, sleep = ms => new Promise(r => setTimeout(r, ms)),
}) {
  let budgetFreeAt = 0;
  const hashFailures = new Map();   // file id -> { size, mtime, error }: not retried until the file changes

  // Before every read: wait out an upload to a printer, honour a stop, and
  // keep within the bandwidth budget.
  async function gate(bytes, ctx) {
    let pausedSince = null;
    while (uploadsActive()) {
      if (!pausedSince) { pausedSince = Date.now(); ctx.stats.pauses++; ctx.stats.paused = true; }
      if (ctx.shouldStop()) break;
      await sleep(250);
    }
    if (pausedSince) { ctx.stats.pausedMs += Date.now() - pausedSince; ctx.stats.paused = false; }
    const why = ctx.shouldStop();
    if (why) throw new ScanStopped(why);
    const t = Date.now();
    if (budgetFreeAt > t) await sleep(budgetFreeAt - t);
    budgetFreeAt = Math.max(Date.now(), budgetFreeAt) + (bytes / budgetBytesPerSec) * 1000;
  }

  // Never more than READ_MAX in one operation: a large window read in one go
  // could outlast netfs's per-operation timeout on a slow link and mark the
  // share — which the G-code folder may share — unreachable.
  async function read(abs, pos, len, ctx) {
    const parts = [];
    for (let off = 0; off < len; off += READ_MAX) {
      const n = Math.min(READ_MAX, len - off);
      await gate(n, ctx);
      const t0 = Date.now();
      const buf = await netfs.read(abs, pos + off, n, { lane: LANE });
      ctx.stats.bytesRead += buf.length; ctx.stats.readOps++;
      ctx.fileReadMs += Date.now() - t0;
      parts.push(buf);
      if (buf.length < n) break;   // end of file
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  // The adaptive window (P2): 512 KB head + 256 KB tail, each grown ×4 up to
  // 3 MB while the head ends inside the thumbnails/object definitions or the
  // tail holds no config block.
  async function readWindow(abs, size, ctx) {
    let H = gcodeExtract.HEAD_INITIAL, T = gcodeExtract.TAIL_INITIAL;
    const grew = [];
    for (;;) {
      if (H + T >= size) {
        const whole = await read(abs, 0, size, ctx);
        return { head: whole, tail: null, wholeFile: true, window: { head: size, tail: 0, grew, whole: true } };
      }
      const head = await read(abs, 0, H, ctx);
      const tail = await read(abs, size - T, T, ctx);
      const need = gcodeExtract.windowNeeds(head, tail);
      if (need.growHead && H < gcodeExtract.WINDOW_MAX) { H = Math.min(H * 4, gcodeExtract.WINDOW_MAX); grew.push("head:" + H + (need.openThumbnail ? " (thumbnail)" : " (no print body yet)")); continue; }
      if (need.growTail && T < gcodeExtract.WINDOW_MAX) { T = Math.min(T * 4, gcodeExtract.WINDOW_MAX); grew.push("tail:" + T); continue; }
      return { head, tail, wholeFile: false, window: { head: H, tail: T, grew, whole: false, needStream: need.growTail, headIncomplete: need.growHead } };
    }
  }

  // The fallback for a file whose config block is not in its last 3 MB: the
  // whole file, streamed, parsed in the worker.
  async function streamExtract(abs, size, ctx) {
    const { sid } = await worker.request("index.streamBegin", {});
    let ok = false;
    try {
      for (let pos = 0; pos < size; pos += STREAM_CHUNK) {
        const chunk = await read(abs, pos, Math.min(STREAM_CHUNK, size - pos), ctx);
        if (!chunk.length) break;
        await worker.request("index.streamFeed", { sid, chunk });
      }
      ok = true;
      return await worker.request("index.streamEnd", { sid });
    } finally {
      if (!ok) await worker.request("index.streamEnd", { sid, discard: true }).catch(() => {});
    }
  }

  // A folder that cannot be listed (permissions) or a file that cannot be
  // stat'ed is reported, not fatal: the rest of the location is indexed, and
  // what is known about the unreadable part is kept as seen — never marked
  // missing. An unreachable share still stops the scan (NAS_UNREACHABLE).
  async function enumerate(root, ctx) {
    const files = [], dirs = [], unreadableDirs = [], unstatable = [];
    const queue = [""];
    while (queue.length) {
      const rel = queue.shift();
      await gate(0, ctx);
      let entries;
      try {
        entries = await netfs.listDir(rel ? path.join(root.path, ...rel.split("/")) : root.path, null, { lane: LANE, keepErrors: true });
      } catch (e) {
        if (e.code === "NAS_UNREACHABLE" || e.code === "SCAN_STOPPED" || e.code === "NETFS_BUSY") throw e;
        if (!rel) throw e;   // the location itself
        unreadableDirs.push(rel);
        ctx.stats.errors++; ctx.stats.errorList.push({ rel, error: "folder could not be listed: " + e.message });
        continue;
      }
      ctx.stats.listOps++;
      for (const e of entries) {
        const childRel = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory) { if (!SKIP_DIR.test(e.name)) { dirs.push(childRel); queue.push(childRel); } }
        else if (e.isFile && !SKIP_FILE.test(e.name)) {
          if (e.statError) { unstatable.push(childRel); ctx.stats.errors++; ctx.stats.errorList.push({ rel: childRel, error: "could not be read: " + e.statError }); }
          else files.push({ rel: childRel, name: e.name, size: e.size, mtimeMs: e.mtimeMs });
        }
      }
      ctx.stats.dirs = dirs.length; ctx.stats.seen = files.length;
    }
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { files, dirs, unreadableDirs, unstatable };
  }

  // Index one file that is new or changed: fingerprint known, read if it is
  // G-code, written by the worker.
  async function indexFile(root, f, ctx) {
    const abs = path.join(root.path, ...f.rel.split("/"));
    const role = roleOf(f.name);
    const base = { rootId: root.id, relPath: f.rel, name: f.name, ext: extOf(f.name), role, size: f.size, mtimeMs: f.mtimeMs, quickFp: f.fp };
    ctx.fileReadMs = 0;
    const t0 = Date.now();
    let payload = { file: { ...base, metaVersion: 0 } };
    if (role === "sliced" && wantsGcode(f.name) && f.size > 0) {
      try {
        ctx.stats.current = f.rel;
        const w = await readWindow(abs, f.size, ctx);
        if (w.window.needStream) {
          ctx.stats.streamed++;
          const extract = await streamExtract(abs, f.size, ctx);
          w.window.streamed = true;
          payload = { file: { ...base, metaVersion: GCODE_META_VERSION, window: w.window }, extract };
        } else {
          payload = { file: { ...base, metaVersion: GCODE_META_VERSION, window: w.window }, head: w.head, tail: w.tail, wholeFile: w.wholeFile };
        }
        if (w.window.grew.length || w.window.streamed) ctx.stats.expansions.push({ rel: f.rel, ...w.window });
        ctx.stats.readMs.push(ctx.fileReadMs);
        ctx.stats.extracted++;
      } catch (e) {
        if (e.code === "NAS_UNREACHABLE" || e.code === "SCAN_STOPPED" || e.code === "NETFS_BUSY") throw e;
        if (e.code === "ENOENT") { ctx.stats.vanished++; return; }   // gone between listing and reading
        ctx.stats.errors++; ctx.stats.errorList.push({ rel: f.rel, error: e.message });
        payload = { file: { ...base, metaVersion: 0, error: e.message } };
      }
    } else if (is3mf(f.name) && f.size > 0) {
      // A 3MF: its directory, then only the small entries that hold metadata
      // (settings, plate info, pictures) — never the mesh. Inflating and
      // parsing happen in the worker.
      const bytes0 = ctx.stats.bytesRead, reads0 = ctx.stats.readOps;
      try {
        ctx.stats.current = f.rel;
        const zip = await openZipAsync((pos, len) => read(abs, pos, len, ctx), f.size);
        const directory = [...zip.entries.values()].filter(e => !e.dir).map(e => ({ name: e.name, rawSize: e.rawSize, compSize: e.compSize, method: e.method, crc: e.crc }));
        const raw = {};
        for (const w of wantedEntries(directory)) {
          try { raw[w.name] = await zip.readRaw(w.name, w); }
          catch (e) { if (e.code === "NAS_UNREACHABLE" || e.code === "SCAN_STOPPED" || e.code === "NETFS_BUSY") throw e; /* the extractor reports what it lacks */ }
        }
        const readInfo = { bytes: ctx.stats.bytesRead - bytes0, reads: ctx.stats.readOps - reads0, ms: ctx.fileReadMs, of: f.size };
        payload = { file: { ...base, metaVersion: THREEMF_META_VERSION, window: readInfo }, threemf: { directory, raw, zip64: zip.zip64 } };
        ctx.stats.readMs.push(ctx.fileReadMs);
        ctx.stats.extracted++; ctx.stats.threemf++;
        ctx.stats.threemfBytes.push({ rel: f.rel, ...readInfo });
      } catch (e) {
        if (e.code === "NAS_UNREACHABLE" || e.code === "SCAN_STOPPED" || e.code === "NETFS_BUSY") throw e;
        if (e.code === "ENOENT") { ctx.stats.vanished++; return; }
        // A malformed archive is an unreadable file, never a failed scan.
        ctx.stats.errors++; ctx.stats.errorList.push({ rel: f.rel, error: e.message });
        payload = { file: { ...base, metaVersion: THREEMF_META_VERSION, error: (e.code ? e.code + ": " : "") + e.message } };
      }
    }
    const w0 = Date.now();
    const r = await worker.request("index.file", { dbPath, thumbsDir, now: now(), ...payload });
    ctx.stats.writeMs.push(Date.now() - w0);
    if (r.parseMs != null && (payload.head || payload.threemf)) ctx.stats.parseMs.push(r.parseMs);
    if (r.added) ctx.stats.added++; else if (r.changed) ctx.stats.changed++; else ctx.stats.reread++;
    if (r.thumbKey) ctx.stats.thumbs++;
    for (const k of r.replacedThumbs || []) ctx.stats.thumbCandidates.push(k);
    ctx.stats.fileMs.push(Date.now() - t0);
  }

  async function scanRoot(root, { shouldStop = () => false, stats: external } = {}) {
    const stats = Object.assign(external || {}, {
      rootId: root.id, phase: "listing", startedAt: now(), finishedAt: null, outcome: null, error: null,
      dirs: 0, seen: 0, unchanged: 0, restat: 0, added: 0, changed: 0, reread: 0, moved: 0, missing: 0, purged: 0, vanished: 0,
      extracted: 0, streamed: 0, threemf: 0, threemfBytes: [], thumbs: 0, thumbCandidates: [], errors: 0, errorList: [], expansions: [],
      bytesRead: 0, readOps: 0, listOps: 0, fpOps: 0, pauses: 0, pausedMs: 0, paused: false, current: null, total: 0, done: 0,
      readMs: [], parseMs: [], writeMs: [], fileMs: [], fpMs: [],
    });
    const ctx = { stats, shouldStop, fileReadMs: 0 };
    const { scanId, interrupted } = await worker.request("index.begin", { dbPath, rootId: root.id, now: stats.startedAt });
    stats.interruptedBefore = interrupted;
    let complete = false, dirs = null;
    try {
      const listing = await enumerate(root, ctx);
      dirs = listing.dirs;
      stats.phase = "comparing";
      const manifest = new Map();
      for (const r of readDb().prepare("SELECT id, rel_path, size, mtime_ms, quick_fp, meta_version, state, role FROM files WHERE root_id = ? AND entry_path = ''").all(root.id)) manifest.set(r.rel_path, r);
      const touchIds = [], todo = [];
      // Known files that could not be looked at this time are seen, unchanged.
      const keep = r => listing.unstatable.includes(r.rel_path) || listing.unreadableDirs.some(d => r.rel_path.startsWith(d + "/"));
      for (const [rel, row] of manifest) if (keep(row)) { touchIds.push(row.id); manifest.delete(rel); }
      for (const f of listing.files) {
        const row = manifest.get(f.rel);
        if (row) manifest.delete(f.rel);
        const needsMeta = needsReading(f.name, row);
        if (row && row.size === f.size && row.mtime_ms === Math.floor(f.mtimeMs) && !needsMeta && row.state !== "unreadable") { touchIds.push(row.id); stats.unchanged++; continue; }
        todo.push({ ...f, row });
      }
      stats.total = todo.length;
      // Step 3: quick fingerprints for new or changed files.
      stats.phase = "fingerprinting";
      for (const f of todo) {
        await gate(3 * 64 * 1024, ctx);
        const t0 = Date.now();
        try {
          const q = await netfs.quickFp(path.join(root.path, ...f.rel.split("/")), { lane: LANE });
          f.fp = q.fp; f.size = q.size; f.mtimeMs = q.mtimeMs;
          stats.bytesRead += q.bytes; stats.fpOps++; stats.fpMs.push(Date.now() - t0);
        } catch (e) {
          if (e.code === "NAS_UNREACHABLE" || e.code === "NETFS_BUSY") throw e;
          if (e.code === "ENOENT") { f.gone = true; stats.vanished++; continue; }
          f.error = e.message;
          // A known file that could not be read now is still there: seen,
          // unchanged, not missing.
          if (f.row) { touchIds.push(f.row.id); f.done = true; stats.errors++; stats.errorList.push({ rel: f.rel, error: e.message }); }
        }
      }
      // Step 4: moves — a vanished row and a new file with the same
      // fingerprint, one-to-one within this scan. Anything ambiguous is
      // simply missing + new.
      const gone = [...manifest.values()];
      const byFp = (list, fpOf) => { const m = new Map(); for (const x of list) { const k = fpOf(x); if (k) m.set(k, (m.get(k) || []).concat([x])); } return m; };
      const goneByFp = byFp(gone, r => r.quick_fp);
      const newByFp = byFp(todo.filter(f => !f.row && f.fp), f => f.fp);
      for (const [fp, news] of newByFp) {
        const olds = goneByFp.get(fp);
        if (news.length !== 1 || !olds || olds.length !== 1) continue;
        const f = news[0], old = olds[0];
        await worker.request("index.move", { dbPath, id: old.id, relPath: f.rel, name: f.name, ext: extOf(f.name), now: now(), rootId: root.id, fromRelPath: old.rel_path, quickFp: fp });
        f.moved = true; stats.moved++;
        manifest.delete(old.rel_path);
        if (!needsReading(f.name, old) && Math.floor(f.mtimeMs) === old.mtime_ms) f.done = true;
        else f.row = { ...old, rel_path: f.rel };
      }
      // Step 5: extraction and writes.
      stats.phase = "indexing";
      for (const f of todo) {
        stats.done++;
        if (f.gone || f.done) continue;
        if (f.error && !f.fp) { stats.errors++; stats.errorList.push({ rel: f.rel, error: f.error }); continue; }
        // Same content, only the modification time moved: no read.
        const sameContent = f.row && f.row.quick_fp === f.fp && f.row.size === f.size;
        const needsMeta = !!f.row && needsReading(f.name, f.row);
        if (sameContent && !needsMeta && f.row.state !== "unreadable") {
          await worker.request("index.restat", { dbPath, id: f.row.id, mtimeMs: f.mtimeMs, now: now() });
          stats.restat++; continue;
        }
        await indexFile(root, f, ctx);
      }
      for (let i = 0; i < touchIds.length; i += TOUCH_BATCH) {
        await worker.request("index.touch", { dbPath, ids: touchIds.slice(i, i + TOUCH_BATCH), now: now() });
      }
      complete = true;
      stats.outcome = "ok";
    } catch (e) {
      stats.outcome = e.code === "NAS_UNREACHABLE" ? "offline" : e.code === "SCAN_STOPPED" ? "stopped" : "error";
      stats.error = e.message;
      if (stats.outcome === "error") log.error(`[library] scan of ${root.name} failed: ${e.message}`);
    } finally {
      stats.phase = "finishing"; stats.current = null;
      try {
        const fin = await worker.request("index.finish", {
          dbPath, rootId: root.id, scanId, startedAt: stats.startedAt, now: now(), complete, outcome: stats.outcome,
          stats: { seen: stats.seen, added: stats.added, changed: stats.changed, moved: stats.moved, errors: stats.errors },
          dirs: complete ? dirs : null, error: stats.error, thumbsDir, thumbCandidates: stats.thumbCandidates,
        });
        stats.missing = fin.missing; stats.purged = fin.purged; stats.thumbsRemoved = fin.thumbsRemoved;
      } catch (e) { log.error("[library] could not finish the scan record: " + e.message); }
      stats.finishedAt = now(); stats.phase = "done";
    }
    return stats;
  }

  // The full hash (sha256 + md5) of files that only have a quick
  // fingerprint, smallest first, for locations with full_hash='idle'. Stops
  // as soon as shouldStop() says so (a scan is waiting, the server stops),
  // and writes nothing for a file that changed while it was read.
  async function hashIdle({ shouldStop = () => false, stats: external, roots } = {}) {
    const stats = Object.assign(external || {}, { phase: "hashing", startedAt: now(), hashed: 0, skipped: 0, bytesRead: 0, readOps: 0, pauses: 0, pausedMs: 0, paused: false, current: null, errors: 0, remaining: null, outcome: null });
    const ctx = { stats, shouldStop, fileReadMs: 0 };
    const ids = roots.map(r => r.id);
    if (!ids.length) { stats.outcome = "idle"; return stats; }
    const ph = ids.map(() => "?").join(",");
    const rows = readDb().prepare(`SELECT f.id, f.root_id, f.rel_path, f.size, f.mtime_ms, f.quick_fp FROM files f
      WHERE f.sha256 IS NULL AND f.state = 'present' AND f.entry_path = '' AND f.root_id IN (${ph}) ORDER BY f.size, f.id`).all(...ids);
    // A file that could not be hashed is skipped until it changes or the
    // server restarts, instead of being retried — and failing — every tick.
    const todoRows = rows.filter(r => { const f = hashFailures.get(r.id); return !f || f.size !== r.size || f.mtime !== r.mtime_ms; });
    stats.remaining = todoRows.length;
    const rootById = new Map(roots.map(r => [r.id, r]));
    try {
      for (const r of todoRows) {
        const root = rootById.get(r.root_id);
        const abs = path.join(root.path, ...r.rel_path.split("/"));
        stats.current = r.rel_path;
        await gate(0, ctx);
        let before;
        try { before = await netfs.stat(abs, { lane: LANE }); }
        catch (e) { if (e.code === "NAS_UNREACHABLE") throw e; stats.skipped++; stats.remaining--; continue; }
        if (before.size !== r.size || Math.floor(before.mtimeMs) !== r.mtime_ms) { stats.skipped++; stats.remaining--; continue; }   // the next scan handles it
        const sha = crypto.createHash("sha256"), md5 = crypto.createHash("md5");
        let after;
        try {
          for (let pos = 0; pos < r.size; pos += STREAM_CHUNK) {
            const chunk = await read(abs, pos, Math.min(STREAM_CHUNK, r.size - pos), ctx);
            if (!chunk.length) break;
            sha.update(chunk); md5.update(chunk);
          }
          after = await netfs.stat(abs, { lane: LANE });
        } catch (e) {
          if (e.code === "NAS_UNREACHABLE" || e.code === "SCAN_STOPPED" || e.code === "NETFS_BUSY") throw e;
          hashFailures.set(r.id, { size: r.size, mtime: r.mtime_ms, error: e.message });
          stats.skipped++; stats.errors++; stats.remaining--;
          continue;
        }
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) { stats.skipped++; stats.remaining--; continue; }
        const res = await worker.request("index.hash", { dbPath, id: r.id, sha256: sha.digest("hex"), md5: md5.digest("hex"), expect: { size: r.size, mtime_ms: r.mtime_ms, quick_fp: r.quick_fp }, now: now() });
        if (res && res.ok) stats.hashed++; else stats.skipped++;
        stats.remaining--;
      }
      stats.outcome = "done";
    } catch (e) {
      stats.outcome = e.code === "SCAN_STOPPED" ? "stopped" : e.code === "NAS_UNREACHABLE" ? "offline" : "error";
      stats.error = e.message;
      if (stats.outcome === "error") { stats.errors++; log.error("[library] full hash stopped: " + e.message); }
    }
    stats.current = null; stats.finishedAt = now(); stats.phase = "done";
    return stats;
  }

  return { scanRoot, hashIdle, summarise };
}

module.exports = { createScanner, roleOf, ScanStopped, DEFAULT_BUDGET, summarise };
