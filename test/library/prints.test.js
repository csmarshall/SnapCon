// test/library/prints.test.js — print history (docs/library-design.md §9, M7):
// how a Print is linked (exact, high, by filename, ambiguous, generic), that
// the link follows the content through rename, move, merge and undo without
// the Print being rewritten or duplicated, the counts, printer visibility,
// rebuild survival, and the import from the audit log. On an index written
// directly and grouped by the real grouping.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibraryStore } = require("../../library/LibraryStore");
const grouping = require("../../library/grouping");
const actions = require("../../library/actions");
const P = require("../../library/prints");
const V = require("../../library/libraryView");

const quiet = { log() {}, warn() {}, error() {} };
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-prints-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  for (const id of ["gcode", "nas"]) store.roots.insert({ id, name: id === "gcode" ? "G-code folder" : "NAS models", path: base, grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
  const db = store.db;
  for (const id of ["gcode", "nas"]) db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES (?, 1, 2, 'ok')").run(id);
  let n = 0;
  const group = () => grouping.run(db, { now: 1000, uuid: () => "00000000-0000-0000-0000-" + String(++n).padStart(12, "0") });
  return { db, store, group };
}
// A sliced file. sha: its verified hash (then the content key), else a quick key.
function file(db, { root = "gcode", rel, objects = [], sha = null, size = 100, mtime = 1, family = "snapmaker-u1" }) {
  const name = rel.split("/").pop();
  const key = sha || "q:" + root + rel;
  const id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, sha256, content_key, first_seen, last_seen)
    VALUES (?, ?, ?, 'gcode', 'sliced', ?, ?, ?, ?, ?, 1, 1)`).run(root, rel, name, size, mtime, "fp" + root + rel, sha, key).lastInsertRowid);
  for (const o of objects) db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, ?, ?, 'exclude_object')").run(id, o.toLowerCase(), o);
  db.prepare("INSERT INTO variants (file_id, plate_no, printer_family) VALUES (?, NULL, ?)").run(id, family);
  return key;
}
const modelOf = (db, rel) => db.prepare("SELECT m.uuid, m.name, m.id FROM files f JOIN models m ON m.id = f.model_id WHERE f.rel_path = ?").get(rel);
const stats = (db, rel) => { const s = db.prepare("SELECT * FROM model_stats WHERE model_id = ?").get(modelOf(db, rel).id); return s ? [s.print_count, s.print_count_confirmed, s.print_count_filename] : [0, 0, 0]; };
const start = (db, e) => P.recordStart(db, { printerId: "pr1", printerName: "U1 one", startedAt: 5000, ...e }, { now: 5000 });
const ACT = { actor: { userId: "u", userLabel: "owner" }, now: 2000 };
const act = (db, a, group) => { const r = actions.apply(db, a, ACT); group(); return r; };

test("a Library print is the exact Variant, counted confirmed, and kept through a Model rename", t => {
  const { db, group } = setup(t);
  const key = file(db, { rel: "Beardie (5h41m).gcode", sha: "a".repeat(64), objects: ["Beardie.stl"] });
  group();
  const m = modelOf(db, "Beardie (5h41m).gcode");
  const r = start(db, { jobKey: "print:1", remoteName: "Beardie (5h41m).gcode", source: "library", via: "print", location: "gcode:Beardie (5h41m).gcode",
    library: { contentKey: key, plate: null, model: m.uuid, variantKey: key, sha256: key } });
  assert.deepEqual(r.link, { method: "snapcon_variant", confidence: "exact" });
  assert.deepEqual(stats(db, "Beardie (5h41m).gcode"), [1, 1, 0]);
  act(db, { kind: "rename", model: m.uuid, name: "Bearded Dragon" }, group);
  const h = P.historyFor(db, m.id).rows;
  assert.equal(h.length, 1, "the same Print, under the renamed Model");
  assert.equal(h[0].link.confidence, "exact");
  assert.equal(h[0].file.name, "Beardie (5h41m).gcode");
  assert.equal(h[0].wasIn, null, "same Model: nothing to explain");
  assert.equal(db.prepare("SELECT count(*) AS n FROM prints").get().n, 1);
});

test("one row per job: the same job reported twice changes nothing, and a new start ends the open one as unknown", t => {
  const { db, group } = setup(t);
  file(db, { rel: "Gecko.gcode", objects: ["Gecko.stl"] });
  group();
  const a = start(db, { jobKey: "queue:qi_1", remoteName: "Gecko.gcode", source: "queue", via: "queue" });
  const again = start(db, { jobKey: "queue:qi_1", remoteName: "Gecko.gcode", source: "queue", via: "queue" });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, a.id);
  start(db, { jobKey: "observed:pr1:9000", remoteName: "Other.gcode", source: "external", startedAt: 9000 });
  assert.equal(db.prepare("SELECT outcome FROM prints WHERE id = ?").get(a.id).outcome, "unknown", "never guessed as completed");
  assert.equal(db.prepare("SELECT count(*) AS n FROM prints").get().n, 2);
});

test("an outcome closes the job open on its printer — with the printer's own way of naming it — and never another printer's", t => {
  const { db, group } = setup(t);
  file(db, { rel: "Frog.gcode", objects: ["Frog.stl"] });
  group();
  const a = start(db, { jobKey: "print:a", remoteName: "Frog.gcode", source: "send", via: "print" });
  assert.equal(P.recordOutcome(db, { printerId: "pr2", remoteName: "Frog.gcode", outcome: "completed", at: 6000 }).updated, 0, "another printer's outcome");
  assert.equal(P.recordOutcome(db, { printerId: "pr1", remoteName: "subdir/Frog", outcome: "completed", at: 6000, elapsedSec: 3600, filamentG: 12.5 }).updated, 1);
  const row = db.prepare("SELECT * FROM prints WHERE id = ?").get(a.id);
  assert.deepEqual([row.outcome, row.ended_at, row.elapsed_sec, row.filament_g], ["completed", 6000, 3600, 12.5]);
  assert.equal(P.recordOutcome(db, { printerId: "pr1", remoteName: "Frog.gcode", outcome: "failed", at: 7000 }).updated, 0, "a closed job is not closed again");
});

test("queue sha256 is exact; an unchanged sent file is high; a changed one falls back to its name", t => {
  const { db, group } = setup(t);
  const sha = "b".repeat(64);
  file(db, { rel: "Owl.gcode", sha, objects: ["Owl.stl"] });
  file(db, { rel: "Toad.gcode", size: 500, mtime: 77, objects: ["Toad.stl"] });
  group();
  assert.equal(start(db, { jobKey: "queue:q1", remoteName: "Owl.gcode", source: "queue", via: "queue", sha256: sha }).link.method, "queue_sha256");
  assert.deepEqual(start(db, { jobKey: "print:t1", remoteName: "Toad.gcode", source: "send", via: "print", location: "gcode:Toad.gcode", stat: { size: 500, mtimeMs: 77.4 }, startedAt: 6000 }).link,
    { method: "content_fp", confidence: "high" });
  assert.deepEqual(start(db, { jobKey: "print:t2", remoteName: "Toad.gcode", source: "send", via: "print", location: "gcode:Toad.gcode", stat: { size: 501, mtimeMs: 99 }, startedAt: 7000 }).link,
    { method: "filename", confidence: "medium" }, "changed since indexing: only the name is evidence");
  assert.deepEqual(stats(db, "Toad.gcode"), [2, 1, 1]);
});

test("by name: unique is medium; several Models is low, unlinked, uncounted and asks a person; a generic name is refused", t => {
  const { db, group } = setup(t);
  file(db, { rel: "Dragon.gcode", objects: ["Dragon.stl"] });
  file(db, { rel: "A/Lamp.gcode", objects: ["Lamp shade.stl"] });
  file(db, { rel: "B/Lamp.gcode", objects: ["Desk lamp arm.stl"] });
  file(db, { rel: "C/Assembly.gcode", objects: ["Thing one.stl"] });
  group();
  assert.notEqual(modelOf(db, "A/Lamp.gcode").uuid, modelOf(db, "B/Lamp.gcode").uuid, "two different Models carry the name");
  assert.deepEqual(start(db, { jobKey: "o:1", remoteName: "Dragon.gcode", source: "external" }).link, { method: "filename", confidence: "medium" });
  const amb = start(db, { jobKey: "o:2", remoteName: "Lamp.gcode", source: "external", startedAt: 6000 });
  assert.deepEqual(amb.link, { method: "filename", confidence: "low" });
  const gen = start(db, { jobKey: "o:3", remoteName: "Assembly.gcode", source: "external", startedAt: 7000 });
  assert.deepEqual(gen.link, { method: "none", confidence: "none" });
  const none = start(db, { jobKey: "o:4", remoteName: "MatMireMakes - Beardie (PLA_5h41m).gcode", source: "external", startedAt: 8000 });
  assert.deepEqual(none.link, { method: "none", confidence: "none" });
  const items = db.prepare("SELECT kind, print_id, confidence FROM review_items WHERE kind = 'unlinked_print' ORDER BY print_id").all();
  assert.deepEqual(items.map(i => [i.print_id, i.confidence]), [[amb.id, "low"], [gen.id, "none"]], "a choice to make; nothing to choose from raises nothing");
  assert.deepEqual(stats(db, "A/Lamp.gcode"), [0, 0, 0], "an ambiguous print is counted nowhere");
  assert.deepEqual(stats(db, "B/Lamp.gcode"), [0, 0, 0]);
  assert.deepEqual(stats(db, "C/Assembly.gcode"), [0, 0, 0], "a generic name is never evidence");
  assert.deepEqual(stats(db, "Dragon.gcode"), [1, 0, 1], "matched by filename, shown as such");
  const att = V.attentionList(db);
  assert.equal(att.items.find(i => i.kind === "unlinked_print" && i.confidence === "low").level, "review");
  assert.equal(att.items.find(i => i.kind === "unlinked_print" && i.confidence === "none").level, "info");
});

test("a person links an ambiguous print to one of the offered Models; undo unlinks it again; the Print row is never rewritten", t => {
  const { db, group } = setup(t);
  file(db, { rel: "A/Lamp.gcode", objects: ["Lamp shade.stl"] });
  file(db, { rel: "B/Lamp.gcode", objects: ["Desk lamp arm.stl"] });
  group();
  const p = start(db, { jobKey: "o:2", remoteName: "Lamp.gcode", source: "external" });
  const before = db.prepare("SELECT * FROM prints WHERE id = ?").get(p.id);
  const review = db.prepare("SELECT id FROM review_items WHERE print_id = ?").get(p.id).id;
  const b = modelOf(db, "B/Lamp.gcode");
  assert.throws(() => actions.apply(db, { kind: "approve", review, model: "not-offered" }, ACT), { code: "bad_choice" });
  const r = act(db, { kind: "approve", review, model: b.uuid }, group);
  assert.equal(r.print.id, p.id);
  assert.deepEqual(stats(db, "B/Lamp.gcode"), [1, 1, 0], "a person's link counts as confirmed");
  assert.deepEqual(db.prepare("SELECT * FROM prints WHERE id = ?").get(p.id), before, "the historical row is untouched");
  assert.equal(db.prepare("SELECT status FROM review_items WHERE id = ?").get(review).status, "resolved");
  actions.undo(db, r.actionId, ACT); group();
  assert.deepEqual(stats(db, "B/Lamp.gcode"), [0, 0, 0]);
  assert.equal(db.prepare("SELECT status FROM review_items WHERE id = ?").get(review).status, "open");
});

test("move by Decision: the Print follows its file to the new Model, says where it was, and is not duplicated", t => {
  const { db, group } = setup(t);
  const key = file(db, { rel: "Beardie (9h28m).gcode", objects: ["Beardie.stl"] });
  file(db, { rel: "Leopard Gecko.gcode", objects: ["Leopard Gecko.stl"] });
  group();
  const from = modelOf(db, "Beardie (9h28m).gcode"), to = modelOf(db, "Leopard Gecko.gcode");
  start(db, { jobKey: "print:1", remoteName: "Beardie (9h28m).gcode", source: "library", via: "print", library: { contentKey: key, model: from.uuid, variantKey: key } });
  act(db, { kind: "move", model: from.uuid, files: [key], to: to.uuid }, group);
  const h = P.historyFor(db, to.id).rows;
  assert.equal(h.length, 1);
  assert.equal(h[0].wasIn.uuid, from.uuid, "what was true when it printed");
  assert.equal(db.prepare("SELECT model_uuid_at_link FROM prints").get().model_uuid_at_link, from.uuid, "the fact is not rewritten");
  assert.equal(db.prepare("SELECT count(*) AS n FROM print_links WHERE model_id IS NOT NULL").get().n, 1);
});

test("merge shows both Models' prints through the survivor; undo gives each its own back; nothing is duplicated or lost", t => {
  const { db, group } = setup(t);
  const k1 = file(db, { rel: "Butterfly Dragon.gcode", objects: ["Butterfly.stl"] });
  const k2 = file(db, { rel: "X/Wing Dragon.gcode", objects: ["Wings.stl"] });
  group();
  const a = modelOf(db, "Butterfly Dragon.gcode"), b = modelOf(db, "X/Wing Dragon.gcode");
  assert.notEqual(a.id, b.id);
  start(db, { jobKey: "p:1", remoteName: "Butterfly Dragon.gcode", source: "library", via: "print", library: { contentKey: k1, model: a.uuid, variantKey: k1 } });
  start(db, { jobKey: "p:2", remoteName: "Wing Dragon.gcode", source: "library", via: "queue", library: { contentKey: k2, model: b.uuid, variantKey: k2 }, printerId: "pr2", startedAt: 6000 });
  const r = act(db, { kind: "merge", from: b.uuid, into: a.uuid }, group);
  assert.deepEqual(stats(db, "Butterfly Dragon.gcode"), [2, 2, 0]);
  const merged = P.historyFor(db, a.id).rows;
  assert.equal(merged.length, 2);
  assert.equal(merged.find(x => x.remoteName === "Wing Dragon.gcode").wasIn.merged, true, "printed as the Model that was merged in");
  actions.undo(db, r.actionId, ACT); group();
  assert.deepEqual(stats(db, "Butterfly Dragon.gcode"), [1, 1, 0]);
  assert.deepEqual(stats(db, "X/Wing Dragon.gcode"), [1, 1, 0]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prints").get().n, 2);
});

test("two copies of the same content: the print records the copy it was sent from, and a name match over both is one link", t => {
  const { db, group } = setup(t);
  const sha = "c".repeat(64);
  file(db, { rel: "Kit/Sea Turtle.gcode", sha, objects: ["Turtle.stl"] });
  file(db, { root: "nas", rel: "Boats/Sea Turtle.gcode", sha, objects: ["Turtle.stl"] });
  group();
  const m = modelOf(db, "Kit/Sea Turtle.gcode");
  assert.equal(modelOf(db, "Boats/Sea Turtle.gcode").id, m.id, "membership is by content: copies are one Model");
  const p = start(db, { jobKey: "p:1", remoteName: "Sea Turtle.gcode", source: "library", via: "print", location: "nas:Boats/Sea Turtle.gcode",
    library: { contentKey: sha, model: m.uuid, variantKey: sha } });
  assert.equal(db.prepare("SELECT location FROM prints WHERE id = ?").get(p.id).location, "nas:Boats/Sea Turtle.gcode", "the physical copy chosen");
  const row = P.historyFor(db, m.id).rows[0];
  assert.deepEqual(row.location, { root: "nas" }, "the location, never a folder path");
  const byName = start(db, { jobKey: "o:1", remoteName: "Sea Turtle.gcode", source: "external", startedAt: 6000 });
  assert.deepEqual(byName.link, { method: "filename", confidence: "medium" }, "two copies of one content are one candidate");
  assert.equal(JSON.parse(db.prepare("SELECT link_evidence_json FROM prints WHERE id = ?").get(byName.id).link_evidence_json).copies, 2);
  assert.equal(db.prepare("SELECT location FROM prints WHERE id = ?").get(byName.id).location, null, "which copy printed is not known");
  assert.deepEqual(stats(db, "Kit/Sea Turtle.gcode"), [2, 1, 1]);
});

test("counts are everyone's; the rows only for printers this person may see; Needs attention hides another printer's prints", t => {
  const { db, group } = setup(t);
  const key = file(db, { rel: "Frog.gcode", objects: ["Frog.stl"] });
  file(db, { rel: "A/Lamp.gcode", objects: ["Lamp shade.stl"] });
  file(db, { rel: "B/Lamp.gcode", objects: ["Desk lamp arm.stl"] });
  group();
  const m = modelOf(db, "Frog.gcode");
  start(db, { jobKey: "p:1", remoteName: "Frog.gcode", source: "library", via: "print", library: { contentKey: key, model: m.uuid, variantKey: key }, printerId: "seen", printerName: "Visible" });
  start(db, { jobKey: "p:2", remoteName: "Frog.gcode", source: "library", via: "print", library: { contentKey: key, model: m.uuid, variantKey: key }, printerId: "secret", printerName: "Secret printer", startedAt: 6000 });
  start(db, { jobKey: "p:3", remoteName: "Lamp.gcode", source: "external", printerId: "secret", printerName: "Secret printer", startedAt: 7000 });
  const visible = pid => pid !== "secret";
  const h = P.historyFor(db, m.id, { visible });
  assert.deepEqual(h.rows.map(r => r.printer), ["Visible"]);
  assert.equal(JSON.stringify(h.rows).includes("Secret"), false, "nothing about the other printer");
  assert.equal(V.modelDetail(db, m.uuid, { printerVisible: visible }).prints.count, 2, "the count is global (§9 D6)");
  const att = V.attentionList(db, { printerVisible: visible });
  assert.equal(att.items.some(i => i.kind === "unlinked_print"), false);
  assert.equal(JSON.stringify(att).includes("Secret"), false);
  assert.equal(V.attentionCounts(db, { printerVisible: visible }).review, V.attentionCounts(db).review - 1);
});

test("a derived rebuild keeps every Print, its link and the counts; no Print is created by it", t => {
  const { db, store, group } = setup(t);
  const key = file(db, { rel: "Owl.gcode", sha: "d".repeat(64), objects: ["Owl.stl"] });
  file(db, { rel: "Dragon.gcode", objects: ["Dragon.stl"] });
  group();
  const m = modelOf(db, "Owl.gcode");
  start(db, { jobKey: "p:1", remoteName: "Owl.gcode", source: "library", via: "print", library: { contentKey: key, model: m.uuid, variantKey: key } });
  start(db, { jobKey: "o:1", remoteName: "Dragon.gcode", source: "external", startedAt: 6000 });
  const before = [stats(db, "Owl.gcode"), stats(db, "Dragon.gcode")];
  store.rebuildDerived();
  assert.equal(db.prepare("SELECT count(*) AS n FROM prints").get().n, 2, "prints are authored");
  file(db, { rel: "Owl.gcode", sha: "d".repeat(64), objects: ["Owl.stl"] });
  file(db, { rel: "Dragon.gcode", objects: ["Dragon.stl"] });
  group();
  assert.equal(modelOf(db, "Owl.gcode").uuid, m.uuid, "the Model is re-found");
  assert.deepEqual([stats(db, "Owl.gcode"), stats(db, "Dragon.gcode")], before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prints").get().n, 2);
});

test("import from the audit log: pairs outcomes, keeps the last job running, upgrades by the queue's hash, refuses generic names, and adds nothing the second time", t => {
  const { db, group } = setup(t);
  const sha = "e".repeat(64);
  file(db, { rel: "Owl.gcode", sha, objects: ["Owl.stl"] });
  file(db, { rel: "Dragon.gcode", objects: ["Dragon.stl"] });
  group();
  // A start recorded live (audit row 5) must not be added again.
  start(db, { jobKey: "print:live", remoteName: "Dragon.gcode", source: "send", via: "print", auditRef: 5, startedAt: 500 });
  const ev = (id, ts, event, printerId, detail, user) => ({ id, ts, event, printerId, printerName: printerId.toUpperCase(), userId: user || null, userLabel: user || null, detail: JSON.stringify(detail) });
  const events = [
    ev(1, 100, "print-completed", "p1", { file: "Dragon.gcode", elapsedSec: 50 }),                   // its start is before the window
    ev(2, 200, "queue-print-started", "p1", { file: "Owl.gcode" }),
    ev(3, 300, "print-completed", "p1", { file: "Owl.gcode", elapsedSec: 90, filamentGramsEst: 3.1 }),
    ev(4, 400, "print-started", "p1", { file: "Assembly.gcode" }),                                  // no outcome, then another start
    ev(5, 500, "print-started", "p2", { file: "Dragon.gcode" }, "alice"),                            // recorded live
    ev(6, 600, "print-cancelled", "p2", { file: "Dragon.gcode" }),
    ev(7, 700, "print-started", "p1", { file: "Dragon.gcode" }),                                    // the last: still running
  ];
  const queueHistory = { p1: [{ id: "qi_x", file: { name: "Owl.gcode", sha256: sha }, dispatchedAt: 230 }] };
  const rep = P.importAudit(db, { events, queueHistory, from: 0, to: 1000, now: 1000 });
  assert.equal(rep.created, 4, "three starts and one orphan outcome");
  assert.equal(rep.alreadyRecorded, 1);
  assert.equal(rep.queueHashUpgrades, 1);
  assert.equal(rep.genericRefused, 1);
  const by = id => db.prepare("SELECT * FROM prints WHERE audit_ref = ?").get(id);
  assert.deepEqual([by(2).link_method, by(2).link_confidence, by(2).outcome, by(2).elapsed_sec, by(2).via], ["queue_sha256", "exact", "completed", 90, "queue"]);
  assert.deepEqual([by(1).started_at, by(1).ended_at, by(1).outcome], [null, 100, "completed"], "the start was not seen; the job still happened");
  assert.equal(by(4).outcome, "unknown", "ended unseen: never guessed");
  assert.equal(by(7).outcome, "printing", "the last start may still be running");
  // Days later, with no outcome, it ended unseen.
  const later = P.importAudit(db, { events, queueHistory, from: 0, to: 1000 + 4 * 24 * 3600 * 1000, now: 3000 });
  assert.equal(later.staleOpen, 1);
  assert.equal(by(7).outcome, "unknown", "an old open job is never left printing");
  db.prepare("UPDATE prints SET outcome = 'printing' WHERE audit_ref = 7").run();
  assert.equal(by(5).outcome, "cancelled", "a live job's outcome found in the log closes it");
  assert.equal(by(5).source, "send", "the live row is the one kept");
  const again = P.importAudit(db, { events, queueHistory, from: 0, to: 1000, now: 2000 });
  assert.equal(again.created, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prints").get().n, 5);
  assert.equal(db.prepare("SELECT count(*) AS n FROM print_imports").get().n, 3, "each run is recorded with its report");
  // The live outcome of the still-running job closes it.
  assert.equal(P.recordOutcome(db, { printerId: "p1", remoteName: "Dragon.gcode", outcome: "completed", at: 900 }).updated, 1);
  assert.equal(by(7).outcome, "completed");
});

test("generic names: test prints and default object names are never linked by name", () => {
  for (const n of ["Assembly.gcode", "3DBenchy.gcode", "Benchy_PLA_45m.gcode", "plate_1.gcode", "Calibration Cube.gcode", "Part 3.gcode", "a.gcode"]) assert.ok(P.genericName(n), n);
  for (const n of ["Beardie (5h41m).gcode", "Flexi Factory Skeleton T-Rex.gcode", "Whites Tree Frog.gcode"]) assert.equal(P.genericName(n), null, n);
});

test("recording one job updates only its own link and Model, and agrees with a full recompute (M8)", t => {
  const { db, group } = setup(t);
  const sha = "f".repeat(64);
  const k1 = file(db, { rel: "Owl.gcode", sha, objects: ["Owl.stl"] });
  file(db, { rel: "Dragon.gcode", objects: ["Dragon.stl"] });
  file(db, { rel: "A/Lamp.gcode", objects: ["Lamp shade.stl"] });
  file(db, { rel: "B/Lamp.gcode", objects: ["Desk lamp arm.stl"] });
  group();
  const m = modelOf(db, "Owl.gcode");
  let n = 0;
  for (const e of [
    { remoteName: "Owl.gcode", source: "library", via: "print", library: { contentKey: k1, model: m.uuid, variantKey: k1 } },
    { remoteName: "Dragon.gcode", source: "external" }, { remoteName: "Lamp.gcode", source: "external" }, { remoteName: "Assembly.gcode", source: "external" },
    { remoteName: "Owl.gcode", source: "queue", via: "queue", sha256: sha }, { remoteName: "Dragon.gcode", source: "external" },
  ]) P.recordStart(db, { jobKey: "j" + (++n), printerId: "p" + (n % 2), startedAt: 1000 * n, ...e }, { now: 1000 * n });
  P.recordOutcome(db, { printerId: "p0", remoteName: "Dragon.gcode", outcome: "completed", at: 9000 });
  const snap = () => JSON.stringify([db.prepare("SELECT * FROM print_links ORDER BY print_id").all(), db.prepare("SELECT * FROM model_stats ORDER BY model_id").all()]);
  const incremental = snap();
  P.refreshStats(db);
  assert.equal(incremental, snap());
  assert.deepEqual(stats(db, "Owl.gcode"), [2, 2, 0]);
  assert.deepEqual(stats(db, "Dragon.gcode"), [2, 0, 2]);
});
