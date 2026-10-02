// netfs/netfs-worker.js — filesystem operations on possibly-network paths,
// run synchronously inside a dedicated worker thread.
//
// Why synchronous, in a worker: a call to an unreachable SMB host blocks for
// ~21 s on Windows and cannot be cancelled. Done with fs.promises it would hold
// one of libuv's four process-wide threads (starving every other file
// operation in SnapCon); done synchronously on the main thread it would freeze
// the server. Done synchronously HERE it blocks only this worker. See
// netfs/NetFs.js for the lanes, timeouts and the availability breaker.
//
// Loaded as a Worker (messages { id, op, args } -> { id, ok, result | error })
// or required in-process by NetFs's fallback, through run().
"use strict";
const fs = require("fs");
const path = require("path");
const { isMainThread, parentPort } = require("node:worker_threads");

const statOf = st => ({ size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink() });

const ops = {
  stat: p => statOf(fs.statSync(p)),
  lstat: p => statOf(fs.lstatSync(p)),
  // false only for "not there"; any other failure (an unreachable share) throws.
  exists: p => { try { fs.statSync(p); return true; } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return false; throw e; } },
  realpath: p => fs.realpathSync.native(p),
  // Can the directory be opened for listing? Without reading it all.
  openable: p => { const d = fs.opendirSync(p); d.closeSync(); return true; },
  firmwareInspect: (p, o) => require("../connectors/firmwareImage").inspectFirmwareImage(p, o),
  readdir: p => fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })),
  // A directory listing plus each entry's stat, in one round trip (the file browser).
  listDir: (p, { filter } = {}) => {
    const re = filter ? new RegExp(filter, "i") : null;
    const out = [];
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory()) { out.push({ name: e.name, isDirectory: true }); continue; }
      if (!e.isFile() || (re && !re.test(e.name))) continue;
      try { const st = fs.statSync(path.join(p, e.name)); out.push({ name: e.name, isFile: true, size: st.size, mtimeMs: st.mtimeMs }); }
      catch { /* vanished between readdir and stat */ }
    }
    return out;
  },
  read: (p, pos, len) => {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      return n === len ? buf : buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
  },
  readFile: (p, maxBytes) => {
    const st = fs.statSync(p);
    if (maxBytes && st.size > maxBytes) { const e = new Error(`file is larger than ${maxBytes} bytes`); e.code = "EFBIG"; throw e; }
    return fs.readFileSync(p);
  },
  // Exclusive create: refuses to overwrite (EEXIST), as every caller wants.
  writeFileExclusive: (p, data) => { fs.writeFileSync(p, Buffer.from(data.buffer, data.byteOffset, data.byteLength), { flag: "wx" }); return true; },
  mkdir: (p, { recursive = false } = {}) => { fs.mkdirSync(p, { recursive }); return true; },
  rename: (a, b) => { fs.renameSync(a, b); return true; },
  // File search: a recursive walk matching names, capped. Dot-directories
  // (.thumbs) are skipped, as the file browser's own walk always did.
  walk: (dir, { query, filter, limit = 300 }) => {
    const q = String(query || "").toLowerCase(), re = filter ? new RegExp(filter, "i") : null, results = [];
    const visit = (d, rel) => {
      if (results.length >= limit) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (rel === "") throw e; return; }
      for (const e of entries) {
        if (results.length >= limit) return;
        if (e.name.startsWith(".")) continue;
        const sub = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) { visit(path.join(d, e.name), sub); continue; }
        if (!e.isFile() || (re && !re.test(e.name)) || !e.name.toLowerCase().includes(q)) continue;
        try { const st = fs.statSync(path.join(d, e.name)); results.push({ name: e.name, sub: rel, size: st.size, mtime: st.mtimeMs }); } catch {}
      }
    };
    visit(dir, "");
    return results;
  },
  // 3MF helpers: threemf.js reads synchronously; here that blocks this worker only.
  threemfRead: (p, opts) => require("../threemf").read(p, opts),
  threemfPlateThumbnail: (p, plate) => require("../threemf").plateThumbnail(p, plate),
  threemfPlateGcode: (p, plate) => require("../threemf").plateGcode(p, plate),
  // For tests of NetFs's timeout and breaker: blocks this worker like a hung
  // SMB call would.
  __sleep: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return true; },
  __fail: code => { const e = new Error("simulated " + code); e.code = code; throw e; },
};

function run(op, args) {
  const fn = ops[op];
  if (!fn) { const e = new Error("unknown netfs op: " + op); e.code = "ENOSYS"; throw e; }
  return fn(...(args || []));
}

if (!isMainThread && parentPort) {
  parentPort.on("message", ({ id, op, args }) => {
    try {
      const result = run(op, args);
      // Buffers go back as transferable ArrayBuffers, not copies.
      if (Buffer.isBuffer(result)) {
        const ab = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
        parentPort.postMessage({ id, ok: true, buffer: ab }, [ab]);
      } else parentPort.postMessage({ id, ok: true, result });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: { code: e.code || null, message: e.message } });
    }
  });
}

module.exports = { run };
