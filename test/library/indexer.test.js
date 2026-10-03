// test/library/indexer.test.js — the M2 indexer end to end (§6.1): a real
// location in a temp folder, real netfs (worker threads, breaker), the real
// Library worker thread and database. Covers what the M2 checkpoint is
// judged on: counts, unchanged files costing one stat, moves, missing vs
// offline, the pause during uploads, restart/resume, the adaptive window and
// its streamed fallback, printer Claims through the resolver (never folders),
// the full hash and its re-key, Decisions, and rebuild survival.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createLibraryService, GCODE_ROOT } = require("../../library/LibraryService");
const { createNetFs } = require("../../netfs/NetFs");
const { gcodeFile } = require("./helpers/gcode");

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-idx-"));
const put = (dir, rel, data) => { const p = path.join(dir, ...rel.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };

async function make(t, { files = {}, svc = {}, netfsOpts = {} } = {}) {
  const base = tmp();
  const gcode = path.join(base, "gcode");
  fs.mkdirSync(gcode);
  for (const [rel, data] of Object.entries(files)) put(gcode, rel, data);
  const nf = createNetFs({ log: quiet, opTimeoutMs: 5000, probeEveryMs: 60000, ...netfsOpts });
  const lib = createLibraryService({ baseDir: base, getGcodeFolder: () => gcode, log: quiet, netfs: nf, scanBudget: 1024 * 1024 * 1024, workerOptions: { log: quiet }, ...svc });
  t.after(async () => { await lib.stop(); await nf.stop(); });
  lib.start();
  return { lib, nf, base, gcode };
}
// Waits for a finished scan of `id` newer than `after`.
async function scanDone(lib, id = GCODE_ROOT, after = 0) {
  for (let i = 0; i < 600; i++) {
    const s = lib.scanReport().scans[id];
    if (s && s.finishedAt && s.finishedAt > after) { await lib._idle(); return lib.scanReport().scans[id]; }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("scan did not finish");
}
async function rescan(lib, id = GCODE_ROOT) {
  const before = (lib.scanReport().scans[id] || {}).finishedAt || 0;
  await new Promise(r => setTimeout(r, 5));
  await lib.rescan(id);
  return scanDone(lib, id, before);
}
const fileOf = (lib, rel) => lib.diagnosticsRaw({}).files.find(f => f.path === rel);

const U1 = gcodeFile({ printerModel: "Snapmaker U1", settingsId: "PixelPrints U1 (0.4mm)", objects: [["Kitty.stl", 2]] });
const FIVE_M = gcodeFile({ generic: true, settingsId: "Flashforge Adventurer 5M Pro 0.4 Nozzle benchy", objects: [] });
// A printer the resolver does not know (the KE was the example until it was added).
const KE = gcodeFile({ printerModel: "Creality Ender-5 S1", settingsId: "Creality Ender-5 S1 0.4 nozzle" });

test("first scan: every file indexed; printer from the file's own fields, never its folder", async t => {
  const { lib } = await make(t, { files: {
    "AD5X/Cinderwin3D/kitty.gcode": U1,            // a U1 file in an AD5X folder
    "5M PRO/skelly.gcode": FIVE_M,
    "U1/Cinderwin 3D/trex.gcode": KE,
    "U1/Cinderwin 3D/part.stl": "solid x\nendsolid x\n",
    ".thumbs/hidden.gcode": U1,                     // dot folders are skipped
  } });
  const s = await scanDone(lib);
  assert.equal(s.outcome, "ok");
  assert.equal(s.seen, 4);
  assert.equal(s.added, 4);
  assert.equal(s.extracted, 3);
  assert.equal(s.thumbs, 3);

  const kitty = fileOf(lib, "AD5X/Cinderwin3D/kitty.gcode");
  assert.equal(kitty.printer.family, "snapmaker-u1");
  assert.equal(kitty.printer.confidence, "high");
  assert.equal(kitty.printer.state, "applied");
  assert.ok(kitty.printer.evidence.every(e => e.source === "gcode:config"), "Evidence is the file's config block only");
  assert.deepEqual(kitty.folderDisagrees, { folder: "AD5X", folderFamilies: ["flashforge-ad5x"], fileFamily: "snapmaker-u1", fileConfidence: "high" });
  assert.equal(kitty.copies, 2);

  const skelly = fileOf(lib, "5M PRO/skelly.gcode");
  assert.equal(skelly.printer.family, "flashforge-5m-pro");
  assert.equal(skelly.printer.state, "suggested");
  assert.match(skelly.printer.missing, /generic/);

  const trex = fileOf(lib, "U1/Cinderwin 3D/trex.gcode");
  assert.equal(trex.printer.state, "unknown");
  assert.match(trex.printer.missing, /no known printer family/);
  assert.equal(trex.folderDisagrees, null, "an unknown printer is not a disagreement");

  const stl = fileOf(lib, "U1/Cinderwin 3D/part.stl");
  assert.equal(stl.role, "source");
  assert.equal(stl.printer, null);

  const t1 = lib.thumbFile(kitty.thumb);
  assert.ok(t1 && fs.existsSync(t1.file));
  const folders = Object.fromEntries(lib.diagnosticsRaw({}).folders.map(f => [f.rel_path, f.class]));
  assert.equal(folders["AD5X"], "printer_family_like");
  assert.equal(folders["AD5X/Cinderwin3D"], "designer");
  assert.equal(folders[".thumbs"], undefined);
});

test("a rescan of unchanged files reads nothing but the listings", async t => {
  const { lib } = await make(t, { files: { "a.gcode": U1, "b/c.gcode": FIVE_M } });
  await scanDone(lib);
  const keysBefore = lib.diagnosticsRaw({}).files.map(f => f.printer && f.printer.claimKey);
  const s = await rescan(lib);
  assert.equal(s.unchanged, 2);
  assert.equal(s.bytesRead, 0);
  assert.equal(s.readOps + s.fpOps, 0);
  assert.deepEqual(lib.diagnosticsRaw({}).files.map(f => f.printer && f.printer.claimKey), keysBefore);
});

test("changed content is re-read and its Claims re-derived; a touched mtime is not re-read", async t => {
  const { lib, gcode } = await make(t, { files: { "a.gcode": U1, "b.gcode": U1 } });
  await scanDone(lib);
  const oldKey = fileOf(lib, "a.gcode").contentKey;
  put(gcode, "a.gcode", gcodeFile({ printerModel: "Flashforge AD5X", settingsId: "AD5X (PixelPrints, 0.4)" }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(gcode, "b.gcode"), later, later);
  const s = await rescan(lib);
  assert.equal(s.changed, 1);
  assert.equal(s.restat, 1, "same fingerprint, new mtime: one fingerprint read, no extraction");
  assert.equal(s.extracted, 1);
  const a = fileOf(lib, "a.gcode");
  assert.notEqual(a.contentKey, oldKey);
  assert.equal(a.printer.family, "flashforge-ad5x");
});

test("a move is recognised by fingerprint, keeps everything, and is not re-read", async t => {
  const { lib, gcode } = await make(t, { files: { "5M PRO/skelly.gcode": FIVE_M, "other.gcode": U1 } });
  await scanDone(lib);
  const before = fileOf(lib, "5M PRO/skelly.gcode");
  fs.mkdirSync(path.join(gcode, "Archive"));
  fs.renameSync(path.join(gcode, "5M PRO", "skelly.gcode"), path.join(gcode, "Archive", "skelly.gcode"));
  const s = await rescan(lib);
  assert.equal(s.moved, 1);
  assert.equal(s.extracted, 0);
  assert.equal(s.missing, 0);
  const after = fileOf(lib, "Archive/skelly.gcode");
  assert.equal(after.contentKey, before.contentKey);
  assert.equal(after.printer.claimKey, before.printer.claimKey);
  assert.deepEqual(after.moved, [{ from: "gcode:5M PRO/skelly.gcode", confidence: "exact" }]);
  assert.equal(fileOf(lib, "5M PRO/skelly.gcode"), undefined);
});

test("two identical files appearing for one that vanished is ambiguous: missing + new, never a guessed move", async t => {
  const { lib, gcode } = await make(t, { files: { "a.gcode": U1 } });
  await scanDone(lib);
  fs.renameSync(path.join(gcode, "a.gcode"), path.join(gcode, "b.gcode"));
  fs.copyFileSync(path.join(gcode, "b.gcode"), path.join(gcode, "c.gcode"));
  const s = await rescan(lib);
  assert.equal(s.moved, 0);
  assert.equal(s.missing, 1);
  assert.equal(s.added, 2);
});

test("missing vs offline: a deleted file goes missing; an unreachable location changes no rows", async t => {
  const { lib, nf, gcode } = await make(t, { files: { "a.gcode": U1, "b.gcode": FIVE_M } });
  await scanDone(lib);
  fs.rmSync(path.join(gcode, "a.gcode"));
  const s = await rescan(lib);
  assert.equal(s.missing, 1);
  assert.equal(fileOf(lib, "a.gcode").state, "missing");
  // Gone mid-walk: the share stops answering.
  fs.rmSync(path.join(gcode, "b.gcode"));
  nf._setFault((op, p) => (p.startsWith(gcode) && op === "listDir" ? "UNKNOWN" : null));
  t.after(() => nf._setFault(null));
  const before = lib.scanReport().scans.gcode.finishedAt;
  lib._requestScan(GCODE_ROOT);
  const off = await scanDone(lib, GCODE_ROOT, before);
  assert.equal(off.outcome, "offline");
  assert.equal(fileOf(lib, "b.gcode").state, "present", "an offline scan marks nothing missing");
  assert.equal(lib.listRoots().find(r => r.id === GCODE_ROOT).status, "offline");
});

test("reads pause while SnapCon uploads to a printer, then the scan finishes", async t => {
  let uploading = true;
  const { lib } = await make(t, { files: { "a.gcode": U1 }, svc: { uploadsActive: () => uploading } });
  setTimeout(() => { uploading = false; }, 600);
  const s = await scanDone(lib);
  assert.equal(s.outcome, "ok");
  assert.ok(s.pauses >= 1);
  assert.ok(s.pausedMs >= 300, `paused ${s.pausedMs} ms`);
  assert.equal(s.extracted, 1);
});

test("restart: a scan the server never finished is closed as interrupted, and the next one resumes cheaply", async t => {
  const base = tmp();
  const gcode = path.join(base, "gcode");
  for (let i = 0; i < 6; i++) put(gcode, `f${i}.gcode`, gcodeFile({ printerModel: "Snapmaker U1", bodyBytes: 200000 + i }));
  const nf = createNetFs({ log: quiet, probeEveryMs: 60000 });
  t.after(() => nf.stop());
  // A slow budget so the first run is stopped part-way.
  const first = createLibraryService({ baseDir: base, getGcodeFolder: () => gcode, log: quiet, netfs: nf, scanBudget: 600 * 1024, workerOptions: { log: quiet } });
  first.start();
  for (let i = 0; i < 400 && !(first.status().indexer.scanning && first.status().indexer.scanning.done >= 2); i++) await new Promise(r => setTimeout(r, 25));
  await first.stop();
  const db1 = new (require("node:sqlite").DatabaseSync)(path.join(base, "library-data", "library.db"));
  const done1 = db1.prepare("SELECT count(*) AS n FROM files").get().n;
  assert.ok(done1 >= 1 && done1 < 6, `${done1} files indexed before the stop`);
  assert.equal(db1.prepare("SELECT outcome FROM scan_runs ORDER BY id DESC LIMIT 1").get().outcome, "stopped");
  // As if the process had died mid-scan: an open run.
  db1.prepare("INSERT INTO scan_runs (root_id, started_at) VALUES ('gcode', 1)").run();
  db1.close();

  const second = createLibraryService({ baseDir: base, getGcodeFolder: () => gcode, log: quiet, netfs: nf, scanBudget: 1024 * 1024 * 1024, workerOptions: { log: quiet } });
  t.after(() => second.stop());
  second.start();
  const s = await scanDone(second);
  assert.equal(s.outcome, "ok");
  assert.equal(s.interruptedBefore, 1);
  assert.equal(s.unchanged, done1, "what the first run finished is not read again");
  assert.equal(s.added, 6 - done1);
});

test("the adaptive window grows the tail for a far config block, and streams a file with none", async t => {
  // The config block starts beyond the 512 KB head and ends beyond the 256 KB tail.
  const far = gcodeFile({ printerModel: "Snapmaker U1", bodyBytes: 800000, extraConfig: Array.from({ length: 12000 }, (_, i) => `; long_setting_${i} = ${"x".repeat(40)}`) });
  const none = gcodeFile({ printerModel: "Snapmaker U1", bodyBytes: 7 * 1024 * 1024, config: false });
  const { lib } = await make(t, { files: { "far.gcode": far, "none.gcode": none } });
  const s = await scanDone(lib);
  const exp = Object.fromEntries(s.expansions.map(e => [e.rel, e]));
  assert.ok(exp["far.gcode"].grew.some(g => g.startsWith("tail:")), JSON.stringify(exp["far.gcode"]));
  assert.ok(!exp["far.gcode"].streamed);
  assert.equal(fileOf(lib, "far.gcode").printer.family, "snapmaker-u1");
  assert.equal(exp["none.gcode"].streamed, true);
  assert.equal(s.streamed, 1);
  const n = fileOf(lib, "none.gcode");
  assert.equal(n.configBlock, false);
  assert.equal(n.printer.family, null, "no config block: no guess");
  assert.equal(n.printer.state, "unknown");
  assert.equal(n.printer.missing, "the file carries no printer fields");
  assert.ok(s.bytesRead >= none.length, "the streamed file was read whole");
});

test("full hash at idle: the content key becomes the sha256 and everything keyed on the quick key follows", async t => {
  const { lib, nf, gcode } = await make(t, { files: { "a.gcode": U1 } });
  await scanDone(lib);
  assert.equal(fileOf(lib, "a.gcode").fullHash, true, "hashed once the scan queue was empty");
  // A new file, and a Decision about it made before its hash arrives — keyed,
  // as it has to be, on its quick key.
  put(gcode, "b.gcode", FIVE_M);
  const qk = "q:" + (await nf.quickFp(path.join(gcode, "b.gcode"))).fp;
  lib._store.db.prepare("INSERT INTO decisions (subject_type, subject_key, relation, object_type, object_key, created_at) VALUES ('file', ?, 'hidden', NULL, NULL, 1)").run(qk);
  await rescan(lib);
  const b = fileOf(lib, "b.gcode");
  const sha = crypto.createHash("sha256").update(FIVE_M).digest("hex");
  assert.equal(b.contentKey, sha);
  assert.equal(b.printer.state, "suggested", "the Claim followed the new key");
  const db = lib._store.db;
  assert.equal(db.prepare("SELECT content_key FROM content_aliases WHERE alias = ?").get(qk).content_key, sha);
  assert.equal(db.prepare("SELECT subject_key FROM decisions").get().subject_key, sha, "authored rows are re-keyed in place");
  assert.equal(db.prepare("SELECT count(*) AS n FROM claims WHERE subject_key = ?").get(qk).n, 0);
});

test("a Decision on the printer wins over the Claims, and survives a rebuild", async t => {
  const { lib, nf, gcode } = await make(t, { files: { "skelly.gcode": FIVE_M }, svc: {} });
  const qk = "q:" + (await nf.quickFp(path.join(gcode, "skelly.gcode"))).fp;
  // Set by hand before the first scan; full hashing is turned off so the key stays the quick one.
  lib._store.db.prepare("UPDATE roots SET full_hash = 'off'").run();
  lib._store.db.prepare(`INSERT INTO decisions (subject_type, subject_key, relation, polarity, object_type, object_key, value_json, created_at)
    VALUES ('variant', ?, 'targets_printer', 'affirm', 'printer_family', 'flashforge-5m', '{"printer_family":"flashforge-5m"}', 1)`).run(qk);
  lib._store.db.prepare(`INSERT INTO decisions (subject_type, subject_key, relation, polarity, object_type, object_key, created_at)
    VALUES ('variant', ?, 'targets_printer', 'reject', 'printer_family', 'flashforge-5m-pro', 2)`).run(qk);
  await scanDone(lib);
  let f = fileOf(lib, "skelly.gcode");
  assert.equal(f.printer.family, "flashforge-5m");
  assert.equal(f.printer.state, "decision");
  const claim = lib._store.db.prepare("SELECT state FROM claims WHERE subject_key = ? AND object_key = 'flashforge-5m-pro'").get(qk);
  assert.equal(claim.state, "overridden");

  const before = lib.scanReport().scans.gcode.finishedAt;
  await lib.rebuildDerived();
  assert.equal(lib._store.db.prepare("SELECT count(*) AS n FROM decisions").get().n, 2, "authored rows survive the rebuild");
  await scanDone(lib, GCODE_ROOT, before);
  f = fileOf(lib, "skelly.gcode");
  assert.equal(f.printer.family, "flashforge-5m", "and are re-applied to the rebuilt index");
});

test("removing a location while it is being scanned stops the scan first", async t => {
  const { lib, base } = await make(t, { svc: { scanBudget: 300 * 1024 } });
  const loc = path.join(base, "lib");
  for (let i = 0; i < 5; i++) put(loc, `m${i}/x.gcode`, gcodeFile({ bodyBytes: 150000 + i }));
  await scanDone(lib);
  const r = await lib.addRoot({ path: loc, grouping: "folders" });
  for (let i = 0; i < 400 && !(lib.status().indexer.scanning && lib.status().indexer.scanning.rootId === r.id && lib.status().indexer.scanning.done >= 1); i++) await new Promise(res => setTimeout(res, 25));
  await lib.removeRoot(r.id);
  await lib._idle();
  assert.equal(lib._store.db.prepare("SELECT count(*) AS n FROM files WHERE root_id = ?").get(r.id).n, 0);
  assert.equal(lib.listRoots().find(x => x.id === r.id), undefined);
});

test("after a restart the full hash resumes by itself, and files indexed under an older rule are re-read at once", async t => {
  const base = tmp();
  const gcode = path.join(base, "gcode");
  put(gcode, "a.gcode", U1); put(gcode, "b.gcode", FIVE_M);
  const nf = createNetFs({ log: quiet, probeEveryMs: 60000 });
  t.after(() => nf.stop());
  const opts = { baseDir: base, getGcodeFolder: () => gcode, log: quiet, netfs: nf, scanBudget: 1024 * 1024 * 1024, workerOptions: { log: quiet } };
  const dbAt = () => new (require("node:sqlite").DatabaseSync)(path.join(base, "library-data", "library.db"));
  const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

  // A: indexed, nothing hashed.
  const a = createLibraryService(opts);
  a.start();
  a._store.db.prepare("UPDATE roots SET full_hash = 'off'").run();
  await scanDone(a);
  await a.stop();
  let db = dbAt();
  assert.equal(count(db, "SELECT count(*) AS n FROM files WHERE sha256 IS NOT NULL"), 0);
  db.prepare("UPDATE roots SET full_hash = 'idle'").run();
  const runsBefore = count(db, "SELECT count(*) AS n FROM scan_runs");
  db.close();

  // B: nothing due, nothing queued — the hash resumes on its own.
  const b = createLibraryService(opts);
  b.start();
  for (let i = 0; i < 200 && count(b._store.db, "SELECT count(*) AS n FROM files WHERE sha256 IS NULL"); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(count(b._store.db, "SELECT count(*) AS n FROM files WHERE sha256 IS NULL"), 0, "hashed without a scan to start it");
  assert.equal(count(b._store.db, "SELECT count(*) AS n FROM scan_runs"), runsBefore, "no scan ran");
  await b.stop();

  // C: as if indexed by an older SnapCon: re-read at start, though not due.
  db = dbAt();
  db.prepare("UPDATE files SET meta_version = 1 WHERE role = 'sliced'").run();
  db.close();
  const c = createLibraryService(opts);
  t.after(() => c.stop());
  c.start();
  const s = await scanDone(c);
  assert.equal(s.extracted, 2);
  assert.equal(count(c._store.db, "SELECT count(*) AS n FROM files WHERE meta_version < ?", require("../../library/indexStore").GCODE_META_VERSION), 0);
});

test("a move of one of two identical files is shown on that file only", async t => {
  const { lib, gcode } = await make(t, { files: { "5M PRO/skelly.gcode": FIVE_M, "5M PRO/boat.gcode": FIVE_M } });
  await scanDone(lib);
  fs.mkdirSync(path.join(gcode, "Archive"));
  fs.renameSync(path.join(gcode, "5M PRO", "boat.gcode"), path.join(gcode, "Archive", "boat.gcode"));
  const s = await rescan(lib);
  assert.equal(s.moved, 1);
  assert.deepEqual(fileOf(lib, "Archive/boat.gcode").moved, [{ from: "gcode:5M PRO/boat.gcode", confidence: "exact" }]);
  assert.deepEqual(fileOf(lib, "5M PRO/skelly.gcode").moved, [], "the identical file that stayed put did not move");
});

test("a thumbnail nothing refers to any more is removed, row and file", async t => {
  const { PNG_1x1 } = require("./helpers/gcode");
  const { lib, gcode } = await make(t, { files: { "a.gcode": gcodeFile({ thumbData: Buffer.concat([PNG_1x1, Buffer.from([1])]) }) } });
  await scanDone(lib);
  const old = lib.thumbFile(fileOf(lib, "a.gcode").thumb);
  assert.ok(fs.existsSync(old.file));
  put(gcode, "a.gcode", gcodeFile({ thumbData: Buffer.concat([PNG_1x1, Buffer.from([2])]) }));
  const s = await rescan(lib);
  assert.equal(s.changed, 1);
  assert.equal(s.thumbsRemoved, 1);
  assert.equal(fs.existsSync(old.file), false);
  assert.ok(fs.existsSync(lib.thumbFile(fileOf(lib, "a.gcode").thumb).file));
});

// ---- regressions from the M2 review ----

test("Rebuild and Remove location stop the idle full hash instead of waiting for it to finish", async t => {
  // ~3 MB to hash at 200 KB/s: about 15 s if nothing stops it.
  const files = {};
  for (let i = 0; i < 3; i++) files[`big${i}.gcode`] = gcodeFile({ bodyBytes: 1024 * 1024 + i });
  const { lib, base } = await make(t, { files, svc: { scanBudget: 200 * 1024 } });
  // Halted mid-scan: the loop must not go on to the idle hash afterwards.
  const scanningNow = () => { const x = lib.status().indexer.scanning; return x && x.phase === "indexing" && x.done >= 3; };   // two files written, the third being read
  for (let i = 0; i < 1600 && !scanningNow(); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(scanningNow(), "a scan is running");
  let t0 = Date.now();
  await lib.rebuildDerived();
  assert.ok(Date.now() - t0 < 4000, `Rebuild waited ${Date.now() - t0} ms`);

  const loc = path.join(base, "other"); put(loc, "x.gcode", gcodeFile({ bodyBytes: 1024 * 1024 }));
  const r = await lib.addRoot({ path: loc });
  for (let i = 0; i < 400 && !lib.status().indexer.hashing; i++) await new Promise(res => setTimeout(res, 25));
  t0 = Date.now();
  await lib.removeRoot(r.id);
  assert.ok(Date.now() - t0 < 4000, `Remove location waited ${Date.now() - t0} ms`);
});

test("a file that cannot be hashed is skipped, and the hash goes on with the rest", async t => {
  const { lib, nf, gcode } = await make(t, { files: { "a.gcode": U1, "bad.gcode": FIVE_M, "c.gcode": KE }, svc: {} });
  // Hold the hash back until the fault is in place.
  lib._store.db.prepare("UPDATE roots SET full_hash = 'off'").run();
  await scanDone(lib);
  nf._setFault((op, p) => (op === "read" && p.endsWith("bad.gcode") ? "EACCES" : null));
  t.after(() => nf._setFault(null));
  lib._store.db.prepare("UPDATE roots SET full_hash = 'idle'").run();
  lib._tick();
  for (let i = 0; i < 200 && lib._store.db.prepare("SELECT count(*) AS n FROM files WHERE sha256 IS NOT NULL").get().n < 2; i++) await new Promise(r => setTimeout(r, 25));
  await lib._idle();
  const db = lib._store.db;
  assert.equal(db.prepare("SELECT count(*) AS n FROM files WHERE sha256 IS NOT NULL").get().n, 2, "the others were hashed");
  assert.equal(db.prepare("SELECT sha256 FROM files WHERE rel_path = 'bad.gcode'").get().sha256, null);
  assert.equal(lib.status().indexer.lastHash.outcome, "done");
});

test("a known file that cannot be read this time, or sits in a folder that cannot be listed, is not marked missing", async t => {
  const { lib, nf, gcode } = await make(t, { files: { "a.gcode": U1, "locked/b.gcode": FIVE_M, "c.gcode": KE } });
  await scanDone(lib);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(gcode, "a.gcode"), later, later);   // changed: needs a fingerprint read
  nf._setFault((op, p) => (op === "quickFp" && p.endsWith("a.gcode") ? "EACCES" : op === "listDir" && p.endsWith("locked") ? "EPERM" : null));
  t.after(() => nf._setFault(null));
  const s = await rescan(lib);
  assert.equal(s.outcome, "ok", "the rest of the location was indexed");
  assert.equal(s.missing, 0);
  assert.equal(fileOf(lib, "a.gcode").state, "present");
  assert.equal(fileOf(lib, "locked/b.gcode").state, "present");
  assert.ok(s.errors >= 2);
});

test("no single read is larger than 1 MB, so a slow link can't time out a whole window", async t => {
  const sizes = [];
  const nf = createNetFs({ log: quiet, probeEveryMs: 60000 });
  t.after(() => nf.stop());
  const spy = new Proxy(nf, { get: (o, k) => (k === "read" ? (p, pos, len, opt) => { sizes.push(len); return o.read(p, pos, len, opt); } : o[k]) });
  // No config block and ~1.2 MB: the tail grows until head + tail cover the file.
  const { lib } = await make(t, { files: { "a.gcode": gcodeFile({ bodyBytes: 1200 * 1024, config: false }) }, svc: { netfs: spy } });
  await scanDone(lib);
  assert.ok(sizes.length > 0);
  assert.ok(Math.max(...sizes) <= 1024 * 1024, `largest read ${Math.max(...sizes)}`);
});

test("a thumbnail still used by an identical file is kept when the other copy changes", async t => {
  const { lib, gcode } = await make(t, { files: { "a.gcode": U1, "b.gcode": U1 } });
  await scanDone(lib);
  const key = fileOf(lib, "a.gcode").thumb;
  put(gcode, "a.gcode", gcodeFile({ thumbData: Buffer.concat([require("./helpers/gcode").PNG_1x1, Buffer.from([7])]) }));
  const s = await rescan(lib);
  assert.equal(s.thumbsRemoved, 0);
  assert.ok(fs.existsSync(lib.thumbFile(key).file), "b.gcode still shows it");
});

// ---- a printer-family folder is what the folder says, never evidence for the file ----

test("HollowLog: a K1C folder is recognised as a K1C folder, the file targets the V3 Plus from its own metadata, and they disagree", async t => {
  const V3PLUS = gcodeFile({ printerModel: "Creality Ender-3 V3 Plus", settingsId: "Creality Ender-3 V3 Plus 0.4 nozzle", compatible: "Creality Ender-3 V3 Plus 0.4 nozzle", objects: [["HollowLog.stl", 1]] });
  // The same bytes in a K1C folder and in a folder that says nothing.
  const { lib } = await make(t, { files: { "K1C/HollowLog (5h42m).gcode": V3PLUS, "misc/HollowLog copy.gcode": V3PLUS } });
  await scanDone(lib);
  const inK1C = fileOf(lib, "K1C/HollowLog (5h42m).gcode"), neutral = fileOf(lib, "misc/HollowLog copy.gcode");

  assert.deepEqual(inK1C.folders, [{ path: "K1C", class: "printer_family_like", method: "resolver_family_name", families: ["creality-k1c"] }]);
  assert.equal(inK1C.printer.family, "creality-ender3-v3-plus");
  assert.equal(inK1C.printer.confidence, "high");
  assert.equal(inK1C.printer.state, "applied");
  assert.ok(inK1C.printer.evidence.every(e => e.source === "gcode:config"), "Evidence is the file's own config, nothing from its folder");
  assert.ok(!JSON.stringify(inK1C.printer.evidence).includes("K1C"), "the folder name appears nowhere in the Claim's Evidence");
  assert.deepEqual(inK1C.folderDisagrees, { folder: "K1C", folderFamilies: ["creality-k1c"], fileFamily: "creality-ender3-v3-plus", fileConfidence: "high" });

  // The K1C folder neither raised nor lowered anything: the Claim is the very
  // same one the file gets in a folder that says nothing.
  assert.equal(inK1C.printer.claimKey, neutral.printer.claimKey);
  const claims = lib._store.db.prepare("SELECT * FROM claims WHERE relation = 'targets_printer'").all();
  assert.equal(claims.length, 1, "one Claim for the content, wherever it sits");
  assert.equal(neutral.folderDisagrees, null);
});

test("a printer folder that agrees with a weak file does not strengthen it", async t => {
  // Generic printer_model; only the settings name the 5M Pro: medium, suggested.
  const { lib } = await make(t, { files: { "5M PRO/skelly.gcode": FIVE_M, "misc/skelly.gcode": FIVE_M } });
  await scanDone(lib);
  for (const p of ["5M PRO/skelly.gcode", "misc/skelly.gcode"]) {
    const f = fileOf(lib, p);
    assert.equal(f.printer.family, "flashforge-5m-pro", p);
    assert.equal(f.printer.confidence, "medium", p);
    assert.equal(f.printer.state, "suggested", `${p}: the agreeing folder is no corroboration`);
  }
  assert.equal(fileOf(lib, "5M PRO/skelly.gcode").folderDisagrees, null);
});
