// test/deferredLibrarySend.test.js — a Library send that is finished later
// keeps what was sent (M7.1).
//
// Before: a Library Variant sent to a busy printer (deferred until it was
// free), or uploaded now and started later from the printer, lost its
// identity on the way: the eventual Print was linked by file name, or not at
// all. Now the send's Library Variant, verified hash, location and plate ride
// along — pendingLoad → upload → the printer's "ready" file (persisted) →
// started from the printer — and the Print is recorded as exactly that,
// unless the printer's copy is no longer the one SnapCon put there.
//
// The server functions are taken from server.js; the Print is recorded in a
// real Library database through library/prints.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { createLibraryStore } = require("../library/LibraryStore");
const grouping = require("../library/grouping");
const actions = require("../library/actions");
const prints = require("../library/prints");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const SHA = "a".repeat(64);
const quiet = { log() {}, warn() {}, error() {} };

// A Library with the Variant that was sent.
function library(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-defer-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  store.roots.insert({ id: "gcode", name: "G-code folder", path: base, grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
  const db = store.db;
  db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES ('gcode', 1, 2, 'ok')").run();
  const id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, sha256, content_key, first_seen, last_seen)
    VALUES ('gcode', 'AD5X/Beardie (5h41m).gcode', 'Beardie (5h41m).gcode', 'gcode', 'sliced', 10, 1, 'fp', ?, ?, 1, 1)`).run(SHA, SHA).lastInsertRowid);
  db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, 'beardie.stl', 'Beardie.stl', 'exclude_object')").run(id);
  db.prepare("INSERT INTO variants (file_id, plate_no, printer_family) VALUES (?, NULL, 'flashforge-ad5x')").run(id);
  let n = 0;
  const group = () => grouping.run(db, { now: 1000, uuid: () => "00000000-0000-0000-0000-" + String(++n).padStart(12, "0") });
  group();
  const model = () => db.prepare("SELECT m.uuid, m.name, m.id FROM files f JOIN models m ON m.id = f.model_id").get();
  return { db, group, model };
}

// The server side of the send, with a printer whose storage is a Map.
function server(t, { listFiles = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-defer-srv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, "Beardie (5h41m).gcode");
  fs.writeFileSync(src, "0123456789");
  const storage = new Map();   // the printer's files: name -> size
  const recorded = [], audits = [];
  const printer = { id: "ad5x", name: "AD5X White", url: "http://ad5x", connector: "flashforge-ad5x" };
  const connector = {
    uploadFile: async (p, fp, name) => { storage.set(name, fs.statSync(fp).size); },
    startPrintFile: async () => {},
    ...(listFiles ? { listFiles: async () => [...storage].map(([n, s]) => ({ path: n, size: s })) } : {}),
  };
  const hashes = { [src]: SHA };
  const env = {
    console: { log() {}, error() {} }, path, fs, Date, JSON, Promise, Error,
    PRINTERS: [printer], queuedFile: new Map(), pendingLoad: new Map(), QUEUED_FILE_PATH: path.join(dir, "queued-files.json"),
    getConnector: () => connector, assertNotActiveJobFile: async () => {}, whileUploading: fn => fn(), withStartSequence: (p, fn) => fn(),
    printerHasAnyDefaultPref: () => false, wantsAnyPref: () => false, ROUTE_STARTED_PRINT: new Set(),
    netfs: { stat: async p => fs.statSync(p) },
    queueStore: { computeFileHash: async p => ({ sha256: hashes[p] || "other" }) },
    auditLog: { log: e => { audits.push(e); return 7; } },
    library: { recordPrintStart: e => { recorded.push(e); return Promise.resolve(null); } },
  };
  vm.createContext(env);
  vm.runInContext("const libraryAudit = " + serverSrc.slice(serverSrc.indexOf("const libraryAudit = ") + 21, serverSrc.indexOf("\n", serverSrc.indexOf("const libraryAudit = "))), env);
  for (const name of ["function saveQueuedFiles(", "function loadQueuedFiles(", "async function uploadNotifiedFile(", "async function stagedCopyStillOurs(", "async function runPrintFileJob("]) {
    const at = serverSrc.indexOf(name);
    assert.ok(at > 0, name);
    vm.runInContext(serverSrc.slice(at, at + serverSrc.slice(at).search(/\r?\n\}\r?\n/) + 3), env);
  }
  return { env, src, storage, recorded, audits, printer, connector, hashes };
}

// What /api/print stored for a deferred Library send (sendRef + pendingLoad).
const deferred = (src, model, { plate = null } = {}) => ({ file: src, name: path.basename(src), ts: Date.now(), tools: [], map: {}, prefs: {}, actor: { userId: "u", userLabel: "owner" }, plate,
  send: { plate, location: "gcode:AD5X/Beardie (5h41m).gcode", library: { contentKey: SHA, plate: null, model: model.uuid, modelName: model.name, variantKey: SHA, sha256: SHA } } });

// /api/printfile: the staged file's plate and send, after the copy check.
async function startFromPrinter(s, name) {
  const staged = s.env.queuedFile.get(0);
  const isIt = staged && staged.status === "ready" && staged.name === name ? staged : null;
  const send = isIt && isIt.send ? await s.env.stagedCopyStillOurs(s.printer, s.connector, isIt) : null;
  const job = { phase: "starting", done: false };
  await s.env.runPrintFileJob({ p: s.printer, c: s.connector, filename: name, tools: [], map: {}, prefs: {}, actor: { userId: "u", userLabel: "owner" },
    needsMapping: false, job, printerKey: 0, plate: isIt ? isIt.plate : null, send });
  return s.recorded[s.recorded.length - 1];
}
const chain = (L, e) => { prints.recordStart(L.db, e, { now: 5000 }); const p = L.db.prepare("SELECT p.*, pl.model_id, pl.confidence AS eff FROM prints p JOIN print_links pl ON pl.print_id = p.id ORDER BY p.id DESC LIMIT 1").get();
  return { method: p.link_method, confidence: p.link_confidence, model: L.db.prepare("SELECT uuid FROM models WHERE id = ?").get(p.model_id).uuid, location: p.location, evidence: JSON.parse(p.link_evidence_json) }; };

test("deferred Library send → upload when the printer is free → started from the printer: the Print is exact, not by name", async t => {
  const L = library(t), s = server(t), m = L.model();
  await s.env.uploadNotifiedFile(0, deferred(s.src, m));
  const ready = s.env.queuedFile.get(0);
  assert.equal(ready.status, "ready");
  assert.equal(ready.send.library.model, m.uuid);
  const e = await startFromPrinter(s, "Beardie (5h41m).gcode");
  assert.equal(e.source, "library");
  assert.equal(e.library.staged, true);
  assert.equal(e.library.copyChecked, true, "the printer still holds the copy SnapCon sent");
  const c = chain(L, { ...e, jobKey: "printfile:1" });
  assert.deepEqual([c.method, c.confidence, c.model, c.location], ["snapcon_variant", "exact", m.uuid, "gcode:AD5X/Beardie (5h41m).gcode"]);
  assert.equal(c.evidence.basis, "sent from the Library, started later from the printer");
  assert.equal(s.audits.find(a => a.event === "print-started").detail.library.model, m.uuid);
});

test("a restart while the file waits on the printer: what was sent is persisted and comes back", async t => {
  const L = library(t), s = server(t), m = L.model();
  await s.env.uploadNotifiedFile(0, deferred(s.src, m, { plate: 2 }));
  s.env.saveQueuedFiles();
  s.env.queuedFile.clear();
  s.env.loadQueuedFiles();   // the restart
  const back = s.env.queuedFile.get(0);
  assert.equal(back.plate, 2);
  assert.equal(back.send.library.variantKey, SHA);
  assert.equal(back.size, 10);
  const e = await startFromPrinter(s, "Beardie (5h41m).gcode");
  assert.equal(e.library.plate, 2, "the plate that was sent is the plate started");
});

test("the source file gone after it reached the printer: the Print is still exact", async t => {
  const L = library(t), s = server(t), m = L.model();
  await s.env.uploadNotifiedFile(0, deferred(s.src, m));
  fs.rmSync(s.src);
  const c = chain(L, { ...(await startFromPrinter(s, "Beardie (5h41m).gcode")), jobKey: "printfile:2" });
  assert.equal(c.confidence, "exact");
});

test("a file of the same name that is not SnapCon's copy is linked by name like any other", async t => {
  const L = library(t), s = server(t), m = L.model();
  await s.env.uploadNotifiedFile(0, deferred(s.src, m));
  s.storage.set("Beardie (5h41m).gcode", 999);   // replaced on the printer by someone else
  const e = await startFromPrinter(s, "Beardie (5h41m).gcode");
  assert.equal(e.source, "printer_storage");
  assert.equal(e.library, null);
  // and another printer file of a different name never borrows the identity
  const L2 = library(t), s2 = server(t);
  await s2.env.uploadNotifiedFile(0, deferred(s2.src, L2.model()));
  assert.equal((await startFromPrinter(s2, "Other.gcode")).library, null);
});

test("a printer that cannot list its files keeps what SnapCon recorded, and says it was not checked", async t => {
  const L = library(t), s = server(t, { listFiles: false }), m = L.model();
  await s.env.uploadNotifiedFile(0, deferred(s.src, m));
  const e = await startFromPrinter(s, "Beardie (5h41m).gcode");
  assert.equal(e.library.copyChecked, false);
  assert.equal(chain(L, { ...e, jobKey: "printfile:3" }).evidence.printerCopyChecked, false);
});

test("the Variant changed before the deferred upload: it is not sent as that Variant", async t => {
  const L = library(t), s = server(t), m = L.model();
  s.hashes[s.src] = "b".repeat(64);
  await s.env.uploadNotifiedFile(0, deferred(s.src, m));
  assert.equal(s.env.queuedFile.get(0).status, "error");
  assert.match(s.env.queuedFile.get(0).error, /changed since it was sent from the Library/);
  assert.equal(s.storage.size, 0, "nothing reached the printer");
});

test("a Model renamed or merged while the send waits: the Print still lands on the Model that holds the Variant", async t => {
  const L = library(t), s = server(t), m = L.model();
  await s.env.uploadNotifiedFile(0, deferred(s.src, m));
  actions.apply(L.db, { kind: "rename", model: m.uuid, name: "Bearded Dragon" }, { actor: {}, now: 2000 }); L.group();
  const c = chain(L, { ...(await startFromPrinter(s, "Beardie (5h41m).gcode")), jobKey: "printfile:4" });
  assert.equal(c.model, m.uuid);
  assert.equal(L.db.prepare("SELECT name FROM models WHERE uuid = ?").get(m.uuid).name, "Bearded Dragon");
});

test("a Model merged while the send waits: the Print lands on the survivor, and says which Model it was sent as", async t => {
  const L = library(t), s = server(t), m = L.model();
  const id = Number(L.db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, sha256, content_key, first_seen, last_seen)
    VALUES ('gcode', 'Lizards/Bearded Dragon.gcode', 'Bearded Dragon.gcode', 'gcode', 'sliced', 20, 1, 'fp2', ?, ?, 1, 1)`).run("c".repeat(64), "c".repeat(64)).lastInsertRowid);
  L.db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, 'lizard.stl', 'Lizard.stl', 'exclude_object')").run(id);
  L.db.prepare("INSERT INTO variants (file_id, plate_no, printer_family) VALUES (?, NULL, 'flashforge-ad5x')").run(id);
  L.group();
  const other = L.db.prepare("SELECT m.uuid FROM files f JOIN models m ON m.id = f.model_id WHERE f.rel_path = 'Lizards/Bearded Dragon.gcode'").get().uuid;
  assert.notEqual(other, m.uuid);
  await s.env.uploadNotifiedFile(0, deferred(s.src, m));
  actions.apply(L.db, { kind: "merge", from: m.uuid, into: other }, { actor: {}, now: 2000 }); L.group();
  const c = chain(L, { ...(await startFromPrinter(s, "Beardie (5h41m).gcode")), jobKey: "printfile:5" });
  assert.equal(c.model, other, "shown under the survivor");
  assert.equal(c.confidence, "exact");
  assert.equal(L.db.prepare("SELECT model_uuid_at_link FROM prints WHERE job_key = 'printfile:5'").get().model_uuid_at_link, m.uuid, "sent as the Model since merged");
});

test("the fleet row shows the staged file, never what was sent", () => {
  assert.match(serverSrc, /if \(qf\) row\.queuedFile = \{ name: qf\.name, status: qf\.status, ts: qf\.ts,/);
});
