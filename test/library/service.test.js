// test/library/service.test.js — Library locations through LibraryService:
// adding, refusing overlaps, the G-code folder, status, offline and
// reconnect, backoff, serialised checks, removal, and backups via the worker.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibraryService, GCODE_ROOT } = require("../../library/LibraryService");

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-svc-"));

function make(opts = {}) {
  const base = tmp();
  const gcode = path.join(base, "gcode"); fs.mkdirSync(gcode);
  let clock = 1_000_000;
  const svc = createLibraryService({
    baseDir: base, getGcodeFolder: () => opts.gcode || gcode, log: quiet, now: () => clock,
    checkTimeoutMs: 2000, workerOptions: { log: quiet, ...(opts.workerOptions || {}) }, ...opts.svc,
  });
  svc.start();
  return { svc, base, gcode, advance: ms => (clock += ms) };
}

test("the G-code folder is always a location, grouping individual files, and can't be removed", async () => {
  const { svc, gcode } = make();
  const g = svc.listRoots().find(r => r.id === GCODE_ROOT);
  assert.ok(g);
  assert.equal(g.isGcodeFolder, true);
  assert.equal(g.grouping, "files", "D8");
  assert.equal(path.resolve(g.path).toLowerCase(), path.resolve(gcode).toLowerCase());
  assert.throws(() => svc.removeRoot(GCODE_ROOT), { code: "gcode_fixed" });
  assert.throws(() => svc.updateRoot(GCODE_ROOT, { grouping: "folders" }), { code: "gcode_grouping_fixed" });
  await svc.stop();
});

test("adding a location: validated, reachable, stored with its status", async () => {
  const { svc, base } = make();
  const models = path.join(base, "Models"); fs.mkdirSync(models);
  const r = await svc.addRoot({ path: models + path.sep, grouping: "folders" }, { userId: "u-a" });
  assert.equal(r.name, "Models", "the folder name is the default name");
  assert.equal(r.status, "ok");
  assert.equal(r.path, models, "stored normalised");
  await assert.rejects(svc.addRoot({ path: "" }), { code: "path_required" });
  await assert.rejects(svc.addRoot({ path: models + "2", grouping: "zip" }), { code: "bad_grouping" });
  await assert.rejects(svc.addRoot({ path: path.join(base, "nope") }), { code: "not_a_folder" });
  fs.mkdirSync(models + "3");
  await assert.rejects(svc.addRoot({ path: models + "3", name: "x".repeat(61) }), { code: "name_too_long" });
  await assert.rejects(svc.addRoot({ path: models + "3", scanEveryMin: 1 }), { code: "bad_interval" });
  await svc.stop();
});

test("overlapping locations are refused: same, inside, containing, the G-code folder, and through a junction", async () => {
  const { svc, base, gcode } = make();
  const models = path.join(base, "Models"); fs.mkdirSync(path.join(models, "Dragons"), { recursive: true });
  await svc.addRoot({ path: models });
  await assert.rejects(svc.addRoot({ path: models }), { code: "overlap" });
  await assert.rejects(svc.addRoot({ path: path.join(models, "Dragons") }), { code: "overlap" });
  await assert.rejects(svc.addRoot({ path: base }), { code: "overlap" }, "contains both Models and the G-code folder");
  await assert.rejects(svc.addRoot({ path: path.join(gcode) }), { code: "overlap" });
  if (process.platform === "win32") await assert.rejects(svc.addRoot({ path: models.toUpperCase() }), { code: "overlap" });
  const link = path.join(base, "alias");
  let linked = true;
  try { fs.symlinkSync(path.join(models, "Dragons"), link, "junction"); } catch { linked = false; }
  if (linked) await assert.rejects(svc.addRoot({ path: link }), { code: "overlap" }, "a junction into an existing location is the same place");
  await svc.stop();
});

test("removing a location drops only its derived rows; decisions and prints stay (§4.6 rule 6)", async () => {
  const { svc, base } = make();
  const models = path.join(base, "Models"); fs.mkdirSync(models);
  const r = await svc.addRoot({ path: models });
  const db = svc._store.db;
  db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, content_key, first_seen, last_seen)
    VALUES (?, 'a.stl', 'a.stl', 'stl', 'source', 1, 1, 'fp', 'q:fp', 1, 1)`).run(r.id);
  db.prepare("INSERT INTO decisions (subject_type, subject_key, relation, created_at) VALUES ('file', 'q:fp', 'hidden', 1)").run();
  db.prepare("INSERT INTO prints (content_key, printer_id, remote_name, source, link_method, link_confidence) VALUES ('q:fp', 'p', 'a.gcode', 'library', 'content_fp', 'high')").run();
  svc.removeRoot(r.id, {});
  assert.equal(db.prepare("SELECT count(*) AS n FROM files").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM decisions").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prints").get().n, 1);
  assert.ok(!svc.listRoots().some(x => x.id === r.id));
  await svc.stop();
});

test("offline and reconnect: a share that goes away is offline, retried with backoff, and comes back ok", async () => {
  const { svc, base, advance } = make();
  const share = path.join(base, "share"), models = path.join(share, "models");
  fs.mkdirSync(models, { recursive: true });
  const r = await svc.addRoot({ path: models });
  fs.renameSync(share, share + "-away");                      // the share disappears: neither folder nor parent answers
  assert.equal((await svc.rescan(r.id)).status, "offline");
  assert.equal((await svc.rescan(r.id)).status, "offline");
  fs.renameSync(share + "-away", share);                      // it comes back
  const back = await svc.rescan(r.id);
  assert.equal(back.status, "ok");
  assert.equal(back.lastError, null);
  // The folder alone disappearing (its parent still answering) needs an admin: error, not offline.
  fs.renameSync(models, models + "-renamed");
  const err = await svc.rescan(r.id);
  assert.equal(err.status, "error");
  assert.match(err.lastError, /not found/);
  await svc.stop();
});

test("offline checks back off: 1 min, 5 min, then the location's own interval", async () => {
  let online = true, calls = 0;
  // Only this location's checks are counted; the G-code folder has its own schedule.
  const checkFn = async p => { if (!p.endsWith("nas")) return { status: "ok", realPath: p }; calls++; return online ? { status: "ok", realPath: p } : { status: "offline", error: "gone" }; };
  const { svc, base, advance } = make({ svc: { checkFn } });
  const d = path.join(base, "nas"); fs.mkdirSync(d);
  const r = await svc.addRoot({ path: d, scanEveryMin: 30 });
  online = false;
  const settle = () => new Promise(s => setTimeout(s, 5));
  const due = async ms => { advance(ms); const before = calls; svc._tick(); await settle(); return calls > before; };
  await svc.rescan(r.id);                                   // failure 1
  assert.equal(await due(59 * 1000), false, "not retried before a minute");
  assert.equal(await due(2 * 1000), true, "retried after a minute");       // failure 2
  assert.equal(await due(4 * 60 * 1000), false, "not retried before five minutes");
  assert.equal(await due(61 * 1000), true, "retried after five minutes");  // failure 3
  assert.equal(await due(29 * 60 * 1000), false, "then not before the location's 30 minutes");
  online = true;
  assert.equal(await due(61 * 1000), true);
  assert.equal(svc.listRoots().find(x => x.id === r.id).status, "ok");
  await svc.stop();
});

test("reachability checks run one at a time across all locations", async () => {
  let running = 0, maxRunning = 0;
  const checkFn = async p => { running++; maxRunning = Math.max(maxRunning, running); await new Promise(s => setTimeout(s, 30)); running--; return { status: "ok", realPath: p }; };
  const { svc, base } = make({ svc: { checkFn } });
  const ids = [];
  for (const n of ["a", "b", "c"]) { const d = path.join(base, n); fs.mkdirSync(d); ids.push((await svc.addRoot({ path: d })).id); }
  maxRunning = 0;
  await Promise.all([...ids, GCODE_ROOT].map(id => svc.rescan(id)));
  assert.equal(maxRunning, 1, "an unreachable host can tie up at most one of libuv's shared threads");
  await svc.stop();
});

test("changing the G-code folder in Settings moves the location, and an overlap shows as an error", async () => {
  const base = tmp();
  let folder = path.join(base, "gcode"); fs.mkdirSync(folder);
  const svc = createLibraryService({ baseDir: base, getGcodeFolder: () => folder, log: quiet, checkTimeoutMs: 2000, workerOptions: { log: quiet } });
  svc.start();
  const models = path.join(base, "Models"); fs.mkdirSync(path.join(models, "gcode2"), { recursive: true });
  await svc.addRoot({ path: models });
  folder = path.join(models, "gcode2");                 // now inside another location
  svc.syncGcodeRoot();
  const g = await svc.rescan(GCODE_ROOT);
  assert.equal(path.resolve(g.path).toLowerCase(), path.resolve(folder).toLowerCase());
  assert.equal(g.status, "error");
  assert.match(g.lastError, /overlaps the location "Models"/);
  await svc.stop();
});

test("a backup runs in the worker thread and shows in the status", async () => {
  const { svc } = make();
  assert.equal(svc.status().worker, "thread");
  const res = await svc.backupNow("manual");
  assert.ok(res.bytes > 0);
  const st = svc.status();
  assert.equal(st.backups.count, 1);
  assert.equal(st.backups.newest.file, res.file);
  await svc.stop();
});

test("an unavailable Library refuses changes with a 503-shaped error and lists nothing", async () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, "library-data", "library.db"), { recursive: true });
  const svc = createLibraryService({ baseDir: base, getGcodeFolder: () => base, log: quiet });
  svc.start();
  assert.equal(svc.available, false);
  assert.deepEqual(svc.listRoots(), []);
  await assert.rejects(svc.addRoot({ path: base }), e => e.status === 503 && e.code === "library_unavailable");
  await svc.stop();
});
