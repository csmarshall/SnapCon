// spike/library-m0/zip-check.js — M0: the range-read zip reader against real
// 3MF files. READ-ONLY.
//
//   node spike/library-m0/zip-check.js <file.3mf> [...]
//
// For each file: entry list parity with threemf.js's existing directory reader,
// the bytes (and time) needed to pull the metadata the M3 extractor wants, and
// a full CRC check of every entry (mesh included) to prove the reader is exact.
"use strict";
const fs = require("fs");
const { openZip } = require("./zipRangeReader");
const threemf = require("../../threemf");

const WANT = [/^3D\/3dmodel\.model$/, /^Metadata\/(model_settings|project_settings|slice_info)\.config$/,
  /^Metadata\/plate_\d+(_small)?\.png$/, /^Metadata\/plate_\d+\.gcode\.md5$/, /^Auxiliaries\/\.thumbnails\/thumbnail_3mf\.png$/];

(async () => {
  for (const file of process.argv.slice(2)) {
    const r = { file: file.split(/[\\/]/).pop() };
    // parity with the existing reader
    const fd = fs.openSync(file, "r");
    let old = null;
    try { old = threemf._internal.readDirectory(fd, fs.fstatSync(fd).size); }
    catch (e) { r.threemf_js = "cannot read: " + e.message; }   // e.g. zip64
    finally { fs.closeSync(fd); }
    let t = process.hrtime.bigint();
    const z = await openZip(file);
    r.open_ms = +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1);
    r.size_mb = +(z.size / 1048576).toFixed(2);
    r.entries = z.count;
    if (old) r.parity_with_threemf_js = [...old.keys()].every(n => z.entries.has(n) && z.entries.get(n).rawSize === old.get(n).rawSize) && old.size === z.count;
    // metadata only
    t = process.hrtime.bigint();
    const wanted = [...z.entries.keys()].filter(n => WANT.some(re => re.test(n)));
    for (const n of wanted) await z.read(n);
    r.metadata_entries = wanted.length;
    r.metadata_ms = +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1);
    r.bytes_read_for_metadata_kb = Math.round(z.stats.bytesRead / 1024);
    r.share_of_file = (100 * z.stats.bytesRead / z.size).toFixed(2) + "%";
    r.pictures = [...z.entries.keys()].filter(n => n.startsWith("Auxiliaries/Model Pictures/")).length;
    // exactness: every entry, CRC-verified
    t = process.hrtime.bigint();
    let all = 0;
    for (const e of z.entries.values()) if (!e.dir) { await z.read(e.name); all++; }
    r.all_entries_crc_ok = all;
    r.full_read_ms = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
    await z.close();
    console.log(JSON.stringify(r));
  }
})().catch(e => { console.error(e.code || "", e.message); process.exit(1); });
