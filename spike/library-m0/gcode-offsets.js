// spike/library-m0/gcode-offsets.js — M0: how far into a real G-code file does
// the indexer have to read? READ-ONLY.
//
//   node spike/library-m0/gcode-offsets.js <root>
//
// The design reads 3 MB from the head and 3 MB from the tail. Over SMB that is
// ~0.3 s per file. This measures where the things we extract actually sit:
// the end of the thumbnail blocks, the object definitions, and the start of the
// trailing config block (distance from the end).
"use strict";
const fs = require("fs");
const path = require("path");
const HEAD = 3 << 20, TAIL = 3 << 20;

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name.startsWith("@")) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.gcode$/i.test(e.name)) out.push(p);
  }
  return out;
}
const rows = [];
for (const f of walk(process.argv[2])) {
  const fd = fs.openSync(f, "r");
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(Math.min(HEAD, size)); fs.readSync(fd, head, 0, head.length, 0);
  const tail = Buffer.alloc(Math.min(TAIL, size)); fs.readSync(fd, tail, 0, tail.length, size - tail.length);
  fs.closeSync(fd);
  const h = head.toString("latin1"), t = tail.toString("latin1");
  const lastThumbEnd = h.lastIndexOf("thumbnail end");
  const firstObj = h.indexOf("EXCLUDE_OBJECT_DEFINE"), lastObjDef = h.lastIndexOf("EXCLUDE_OBJECT_DEFINE");
  const objEnd = lastObjDef >= 0 ? h.indexOf("\n", lastObjDef) : -1;
  const cfgStart = Math.max(t.lastIndexOf("; CONFIG_BLOCK_START"), -1);
  const pm = t.lastIndexOf("; printer_model =");
  rows.push({ file: path.relative(process.argv[2], f), mb: +(size / 1048576).toFixed(1),
    head_needed_kb: Math.round(Math.max(lastThumbEnd, objEnd) / 1024),
    obj_defs: (h.match(/EXCLUDE_OBJECT_DEFINE/g) || []).length,
    tail_needed_kb: cfgStart >= 0 ? Math.round((t.length - cfgStart) / 1024) : (pm >= 0 ? Math.round((t.length - pm) / 1024) + "*" : null) });
}
rows.sort((a, b) => b.head_needed_kb - a.head_needed_kb);
const maxHead = Math.max(...rows.map(r => r.head_needed_kb));
const tails = rows.map(r => parseInt(r.tail_needed_kb, 10)).filter(Number.isFinite);
console.log(JSON.stringify({ files: rows.length, max_head_needed_kb: maxHead, max_tail_needed_kb: Math.max(...tails),
  no_tail_block: rows.filter(r => r.tail_needed_kb == null).length, worst: rows.slice(0, 6) }, null, 2));
