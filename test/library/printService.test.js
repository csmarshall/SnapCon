// test/library/printService.test.js — what the print and queue routes ask the
// Library before sending a file (M7, §12), and print history over real HTTP
// with printer visibility (§9 D6): the real service, its worker, and the real
// Library routes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const auth = require("../../auth");
const { createLibraryService, LibraryError } = require("../../library/LibraryService");
const { registerLibraryRoutes } = require("../../library/routes");

const quiet = { log() {}, warn() {}, error() {} };
const USERS = {
  view: { id: "u-v", role: "view", groupIds: [] },
  regular: { id: "u-r", role: "regular", groupIds: ["g-shop"] },
  admin: { id: "u-a", role: "admin", groupIds: [] },
  nobody: { id: "u-n", role: "nobody", groupIds: [] },
};
// Printer "secret" is in a group only admins see.
const printerVisible = (user, pid) => !user || user.role === "admin" || pid !== "secret";

async function service(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ps-"));
  fs.mkdirSync(path.join(base, "gcode"));
  fs.mkdirSync(path.join(base, "nas"));
  const library = createLibraryService({ baseDir: base, getGcodeFolder: () => path.join(base, "gcode"), log: quiet, workerOptions: { log: quiet }, indexing: false, printerVisible });
  library.start();
  const db = library._store.db;
  library._store.roots.insert({ id: "nas", name: "NAS models", path: path.join(base, "nas"), grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
  library._store.roots.setStatus("nas", { status: "ok" });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = req.headers["x-as"] ? USERS[req.headers["x-as"]] : null; next(); });
  registerLibraryRoutes(app, { library, requireAuth: auth.requireAuth, actorFromReq: () => ({ userId: null, userLabel: null }) });
  const srv = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const call = async (as, p, body) => { const res = await fetch(url + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(as ? { "x-as": as } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json() }; };
  t.after(async () => { srv.closeAllConnections(); await new Promise(r => srv.close(r)); await library.stop(); });
  return { library, db, call, base };
}
function indexFile(db, { root, rel, key, sha = null, size = 10, mtime = 5, plates = [null], state = "present" }) {
  const id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, sha256, content_key, state, first_seen, last_seen)
    VALUES (?, ?, ?, ?, 'sliced', ?, ?, ?, ?, ?, ?, 1, 1)`).run(root, rel, rel.split("/").pop(), rel.split(".").pop(), size, mtime, "fp-" + rel, sha, key, state).lastInsertRowid);
  for (const p of plates) db.prepare("INSERT INTO variants (file_id, plate_no, printer_family) VALUES (?, ?, 'snapmaker-u1')").run(id, p);
  db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, ?, ?, 'exclude_object')").run(id, rel.toLowerCase(), rel);
  return id;
}
const rejects = (fn, status, code) => assert.throws(fn, e => e instanceof LibraryError && e.status === status && e.code === code);

test("a location to print from: the G-code folder for anyone who may print; another needs library.view; switched off or unreachable says so", async t => {
  const { library } = await service(t);
  assert.equal(library.printLocation(USERS.nobody, "gcode").id, "gcode", "the G-code folder is printing's own, as before");
  assert.equal(library.printLocation(USERS.view, "nas").id, "nas");
  rejects(() => library.printLocation(USERS.nobody, "nas"), 403, "forbidden");
  assert.equal(library.printLocation(null, "nas", { system: true }).id, "nas", "queue dispatch, already checked when queued");
  rejects(() => library.printLocation(USERS.admin, "nope"), 404, "location_not_found");
  library._store.roots.setStatus("nas", { status: "offline" });
  rejects(() => library.printLocation(USERS.admin, "nas"), 503, "location_offline");
  library._store.roots.setStatus("nas", { status: "error", error: "the folder is gone" });
  rejects(() => library.printLocation(null, "nas", { system: true }), 409, "location_error");
  library._store.roots.update("nas", { enabled: false });
  rejects(() => library.printLocation(USERS.admin, "nas"), 409, "location_disabled");
});

test("the Variant a person chose must still be the file's: changed, missing, or another plate is refused", async t => {
  const { library, db } = await service(t);
  indexFile(db, { root: "nas", rel: "Frog.gcode", key: "q:frog" });
  indexFile(db, { root: "nas", rel: "Dragon.3mf", key: "f".repeat(64), sha: "f".repeat(64), plates: [1, 2] });
  indexFile(db, { root: "nas", rel: "Gone.gcode", key: "q:gone", state: "missing" });
  const id = library.printIdentity({ rootId: "nas", rel: "Frog.gcode", key: "q:frog", plate: null });
  assert.deepEqual([id.contentKey, id.variantKey, id.location, id.sha256], ["q:frog", "q:frog", "nas:Frog.gcode", null]);
  rejects(() => library.printIdentity({ rootId: "nas", rel: "Frog.gcode", key: "q:other" }), 409, "library_file_changed");
  db.prepare("INSERT INTO content_aliases (alias, content_key) VALUES ('q:frog-old', 'q:frog')").run();
  assert.equal(library.printIdentity({ rootId: "nas", rel: "Frog.gcode", key: "q:frog-old" }).contentKey, "q:frog", "an older key of the same content is the same Variant");
  assert.equal(library.printIdentity({ rootId: "nas", rel: "Dragon.3mf", key: "f".repeat(64) + "#1", plate: 1 }).variantKey, "f".repeat(64) + "#1");
  // M7.1: any sliced plate is a Variant; which printer can start it is the print route's check.
  assert.equal(library.printIdentity({ rootId: "nas", rel: "Dragon.3mf", key: "f".repeat(64) + "#2", plate: 2 }).variantKey, "f".repeat(64) + "#2");
  rejects(() => library.printIdentity({ rootId: "nas", rel: "Dragon.3mf", key: "f".repeat(64) + "#3", plate: 3 }), 409, "library_variant_missing");
  rejects(() => library.printIdentity({ rootId: "nas", rel: "Gone.gcode", key: "q:gone" }), 409, "library_file_missing");
  rejects(() => library.printIdentity({ rootId: "nas", rel: "Nowhere.gcode" }), 409, "library_file_missing");
  assert.deepEqual(library.locateContent("f".repeat(64)).map(c => [c.rootId, c.rel]), [["nas", "Dragon.3mf"]]);
  library._store.roots.setStatus("nas", { status: "offline" });
  assert.deepEqual(library.locateContent("f".repeat(64)), [], "never a copy in a location that does not answer");
});

test("over HTTP: everyone with library.view sees the counts; the rows only for printers they may see; nobody without library.view sees anything", async t => {
  const { library, db, call } = await service(t);
  indexFile(db, { root: "gcode", rel: "Frog.gcode", key: "q:frog" });
  await library._group();
  const uuid = db.prepare("SELECT m.uuid FROM models m JOIN files f ON f.model_id = m.id").get().uuid;
  const lib = { contentKey: "q:frog", model: uuid, variantKey: "q:frog" };
  await library.recordPrintStart({ jobKey: "print:1", printerId: "shop", printerName: "Shop U1", remoteName: "Frog.gcode", source: "library", via: "print", startedAt: 10, library: lib });
  await library.recordPrintStart({ jobKey: "print:2", printerId: "secret", printerName: "Secret K1C", remoteName: "Frog.gcode", source: "library", via: "queue", startedAt: 20, library: lib });
  await library.recordPrintOutcome({ printerId: "secret", remoteName: "Frog.gcode", outcome: "completed", at: 30, elapsedSec: 600 });
  const admin = (await call("admin", "/api/library/models/" + uuid)).body;
  assert.deepEqual(admin.prints, { count: 2, confirmed: 2, filename: 0, lastAt: 20 });
  assert.deepEqual(admin.printHistory.rows.map(r => [r.printer, r.outcome]), [["Secret K1C", "completed"], ["Shop U1", "printing"]]);
  assert.equal(admin.printHistory.someNotShown, false);
  for (const who of ["view", "regular"]) {
    const r = (await call(who, "/api/library/models/" + uuid)).body;
    assert.equal(r.prints.count, 2, who + ": the count is global");
    assert.deepEqual(r.printHistory.rows.map(x => x.printer), ["Shop U1"], who);
    assert.equal(r.printHistory.someNotShown, true);
    assert.equal(JSON.stringify(r).includes("Secret"), false, who + ": nothing names the other printer");
    assert.equal(JSON.stringify(r).includes("secret"), false);
  }
  assert.equal((await call(null, "/api/library/models/" + uuid)).status, 401);
  assert.equal((await call("nobody", "/api/library/models/" + uuid)).status, 403);
  const grid = (await call("view", "/api/library/models")).body.models[0];
  assert.equal(grid.prints.count, 2, "the grid shows the count from model_stats");
});

test("an unlinked print on a printer someone may not see: they can't dismiss it, link it, undo its link, or see it in a Model's changes (M8 review)", async t => {
  const { library, db, call } = await service(t);
  indexFile(db, { root: "gcode", rel: "A/Lamp.gcode", key: "q:lamp-a" });
  indexFile(db, { root: "gcode", rel: "B/Lamp.gcode", key: "q:lamp-b" });
  await library._group();
  await library.recordPrintStart({ jobKey: "o:1", printerId: "secret", printerName: "Secret K1C", remoteName: "Lamp.gcode", source: "external", startedAt: 10 });
  const item = db.prepare("SELECT id, evidence_json FROM review_items WHERE kind = 'unlinked_print'").get();
  assert.ok(item, "the ambiguous print asks a person");
  const pick = JSON.parse(item.evidence_json).candidates[0].uuid;
  for (const kind of ["dismiss", "approve"]) {
    const r = await call("regular", "/api/library/actions", { kind, review: item.id, model: pick });
    assert.equal(r.status, 404, kind + ": as if the item did not exist");
  }
  assert.equal(db.prepare("SELECT status FROM review_items WHERE id = ?").get(item.id).status, "open", "untouched");
  const linked = await call("admin", "/api/library/actions", { kind: "approve", review: item.id, model: pick });
  assert.equal(linked.status, 200);
  assert.equal((await call("regular", `/api/library/actions/${linked.body.actionId}/undo`, {})).status, 404, "nor undo it");
  const asRegular = (await call("regular", "/api/library/models/" + pick)).body;
  assert.equal(asRegular.history.some(h => h.summary && h.summary.print), false, "the change naming the hidden printer's job is not shown");
  assert.equal(JSON.stringify(asRegular).includes("Lamp.gcode\",\"at"), false);
  const asAdmin = (await call("admin", "/api/library/models/" + pick)).body;
  assert.equal(asAdmin.history.some(h => h.summary && h.summary.print), true);
  assert.equal((await call("admin", `/api/library/actions/${linked.body.actionId}/undo`, {})).status, 200);
});
