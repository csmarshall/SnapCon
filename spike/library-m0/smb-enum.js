// spike/library-m0/smb-enum.js — M0: what does enumerating a Library location
// cost over a network share, the way the indexer would do it?
//
//   node spike/library-m0/smb-enum.js <root> [<root> ...]
//
// READ-ONLY. For each root: an async walk (opendir) with a stat per file, at
// concurrency 1 and 8; then, on a sample of large files, the per-file reads the
// indexer makes: quick fingerprint (size + three 64 KB windows) and the G-code
// head/tail extraction reads (3 MB each). Nothing is written anywhere.
"use strict";
const fs = require("fs");
const path = require("path");

const MAX_FILES = parseInt(process.env.M0_MAX_FILES, 10) || 20000;
const ms = t => Number(process.hrtime.bigint() - t) / 1e6;

async function walk(root, concurrency) {
  const t = process.hrtime.bigint();
  let dirs = 0, files = 0, bytes = 0, statMs = 0, largest = [];
  const queue = [root];
  const statOne = async p => {
    const s0 = process.hrtime.bigint();
    const st = await fs.promises.stat(p);
    statMs += ms(s0);
    files++; bytes += st.size;
    if (st.size > 1e6) { largest.push([st.size, p]); if (largest.length > 200) { largest.sort((a, b) => b[0] - a[0]); largest.length = 100; } }
  };
  while (queue.length && files < MAX_FILES) {
    const dir = queue.shift();
    let d;
    try { d = await fs.promises.opendir(dir); } catch { continue; }
    dirs++;
    const pending = [];
    for await (const e of d) {
      if (e.name.startsWith(".") || e.name.startsWith("@")) continue;   // .thumbs, @Recently-Snapshot
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { queue.push(p); continue; }
      if (!e.isFile()) continue;
      pending.push(p);
      if (pending.length >= concurrency) await Promise.all(pending.splice(0).map(statOne));
      if (files >= MAX_FILES) break;
    }
    await Promise.all(pending.map(statOne));
  }
  const wall = ms(t);
  largest.sort((a, b) => b[0] - a[0]);
  return { concurrency, dirs, files, gb: +(bytes / 1e9).toFixed(2), wall_ms: Math.round(wall),
    per_file_ms: +(wall / Math.max(files, 1)).toFixed(3), files_per_s: Math.round(files / (wall / 1000)),
    capped: files >= MAX_FILES, largest: largest.slice(0, 12).map(x => x[1]) };
}

async function readAt(fd, pos, len) {
  const b = Buffer.allocUnsafe(len);
  const { bytesRead } = await fd.read(b, 0, len, pos);
  return bytesRead;
}
async function fileCosts(p) {
  const fd = await fs.promises.open(p, "r");
  try {
    const size = (await fd.stat()).size;
    let t = process.hrtime.bigint();
    await readAt(fd, 0, 65536); await readAt(fd, Math.max(0, Math.floor(size / 2) - 32768), 65536); await readAt(fd, Math.max(0, size - 65536), 65536);
    const quick = ms(t);
    t = process.hrtime.bigint();
    await readAt(fd, 0, 3 << 20); await readAt(fd, Math.max(0, size - (3 << 20)), 3 << 20);
    const headTail = ms(t);
    return { mb: +(size / 1048576).toFixed(1), quick_fp_ms: +quick.toFixed(1), head_tail_6mb_ms: +headTail.toFixed(1) };
  } finally { await fd.close(); }
}

(async () => {
  const out = [];
  for (const root of process.argv.slice(2)) {
    const r = { root };
    try {
      r.walk_c1 = await walk(root, 1);
      r.walk_c8 = await walk(root, 8);
      const sample = r.walk_c1.largest.slice(0, 8);
      r.reads = [];
      for (const p of sample) r.reads.push(await fileCosts(p));
      delete r.walk_c1.largest; delete r.walk_c8.largest;
    } catch (e) { r.error = e.message; }
    out.push(r);
  }
  console.log(JSON.stringify(out, null, 2));
})();
