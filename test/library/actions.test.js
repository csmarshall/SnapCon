// test/library/actions.test.js — the M6 grouping tools (§7, §4.5): each action
// writes durable authored state (Decisions, Model columns), wins over automatic
// grouping, survives a full rebuild of the derived index, and can be undone —
// but only while nothing later depends on it. Stale requests answer 409.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibraryStore } = require("../../library/LibraryStore");
const grouping = require("../../library/grouping");
const actions = require("../../library/actions");
const V = require("../../library/libraryView");
const { resolvePrinter } = require("../../library/indexStore");

const quiet = { log() {}, warn() {}, error() {} };
const actor = { userId: "u1", userLabel: "Tester" };

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-act-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  store.roots.insert({ id: "gcode", name: "G-code folder", path: base, grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
  const db = store.db;
  const specs = [];
  let clock = 1000, n = 0;
  const env = {
    store, db, specs,
    group: () => grouping.run(db, { now: ++clock, uuid: () => "00000000-0000-0000-0000-" + String(++n).padStart(12, "0") }),
    file: spec => { specs.push(spec); return insert(db, spec); },
    act: a => { let r; db.exec("BEGIN"); try { r = actions.apply(db, a, { actor, now: ++clock }); grouping.run(db, { now: clock }); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return r; },
    undo: id => { let r; db.exec("BEGIN"); try { r = actions.undo(db, id, { actor, now: ++clock }); grouping.run(db, { now: clock }); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return r; },
    // A full derived rebuild, then every file rediscovered, then grouping.
    rebuild: () => {
      store.rebuildDerived();
      for (const s of specs) insert(db, s);
      db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES ('gcode', 1, 2, 'ok')").run();
      env.group();
    },
  };
  db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES ('gcode', 1, 2, 'ok')").run();
  return env;
}
function insert(db, { rel, role = "sliced", objects = [], family = "snapmaker-u1", thumb = null, plates = null, title = null }) {
  const key = "q:" + rel;
  const id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, content_key, thumb_key, first_seen, last_seen)
    VALUES ('gcode', ?, ?, ?, ?, 100, 1, ?, ?, ?, 1, 1)`).run(rel, rel.split("/").pop(), rel.split(".").pop(), role, rel, key, thumb).lastInsertRowid);
  if (thumb) db.prepare("INSERT OR IGNORE INTO thumbs (key, source, mime, bytes, w, h, created_at, last_used_at) VALUES (?, 'embedded', 'image/png', 100, 300, 300, 1, 1)").run(thumb);
  for (const o of objects) db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, ?, ?, 'exclude_object')").run(id, o.toLowerCase(), o);
  if (role === "sliced" && !plates) {
    db.prepare("INSERT INTO variants (file_id, plate_no, printer_family) VALUES (?, NULL, ?)").run(id, family);
    db.prepare(`INSERT OR REPLACE INTO claims (claim_key, subject_type, subject_key, relation, object_type, object_key, method, confidence, state, groups, evidence_json, rule_version, created_at, updated_at)
      VALUES (?, 'variant', ?, 'targets_printer', 'printer_family', ?, 'resolver', 'high', 'applied', 'identity', ?, 1, 1, 1)`)
      .run("tp:" + key, key, family, JSON.stringify([{ signal: "printer_model", value: family, source: "gcode:config", strength: "high", family }]));
    // As writeFile does: the Variant's printer is resolved, Decisions first.
    const res = resolvePrinter(db, key);
    db.prepare("UPDATE variants SET printer_family = ?, printer_claim_key = ?, printer_decision_id = ? WHERE file_id = ?").run(res.family, res.claimKey, res.decisionId, id);
  }
  if (plates) {
    const pid = Number(db.prepare("INSERT INTO projects (file_id, flavour, title) VALUES (?, 'bambu', ?)").run(id, title).lastInsertRowid);
    for (const p of plates) {
      db.prepare("INSERT INTO plates (project_id, plate_no, sliced, thumb_key) VALUES (?, ?, ?, ?)").run(pid, p.no, p.sliced ? 1 : 0, p.thumb || null);
      if (p.thumb) db.prepare("INSERT OR IGNORE INTO thumbs (key, source, mime, bytes, w, h, created_at, last_used_at) VALUES (?, 'embedded', 'image/png', 100, 200, 200, 1, 1)").run(p.thumb);
      if (p.sliced) db.prepare("INSERT INTO variants (file_id, plate_no, printer_family) VALUES (?, ?, ?)").run(id, p.no, family);
    }
  }
  return { id, key, rel };
}
const modelOf = (db, rel) => (db.prepare("SELECT m.uuid FROM files f JOIN models m ON m.id = f.model_id WHERE f.rel_path = ? AND f.entry_path = ''").get(rel) || {}).uuid;
const model = (db, uuid) => db.prepare("SELECT * FROM models WHERE uuid = ?").get(uuid);
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;
const rejects = (fn, code) => assert.throws(fn, e => e instanceof actions.ActionError && e.code === code, code);

// Two Beardies grouped automatically, a lone lizard, and a title-only suggestion.
function library(env) {
  env.file({ rel: "Beardie.gcode", objects: ["Beardie.stl"], thumb: "tb1" });
  env.file({ rel: "4x Beardie.gcode", objects: ["Beardie.stl"], thumb: "tb2" });
  env.file({ rel: "lizard thing.gcode", objects: ["Gecko.stl"], thumb: "tl" });
  env.file({ rel: "Kraken.gcode", objects: ["Kraken.stl"] });
  env.file({ rel: "Kraken.3mf", role: "project", plates: [{ no: 1, thumb: "kp1" }, { no: 2, sliced: true, thumb: "kp2" }] });
  env.group();
  return { beardie: modelOf(env.db, "Beardie.gcode"), lizard: modelOf(env.db, "lizard thing.gcode"), kraken: modelOf(env.db, "Kraken.gcode"), krakenProject: modelOf(env.db, "Kraken.3mf") };
}

test("merge: the absorbed Model is kept (merged_into), its files join the survivor, and that survives a rebuild; undo returns them", t => {
  const env = setup(t), { db } = env, m = library(env);
  db.prepare("UPDATE models SET designer = 'MatMire' WHERE uuid = ?").run(m.lizard);
  const r = env.act({ kind: "merge", from: m.lizard, into: m.beardie });
  assert.equal(modelOf(db, "lizard thing.gcode"), m.beardie);
  assert.equal(model(db, m.lizard).merged_into, m.beardie, "never deleted");
  assert.equal(model(db, m.beardie).name, "Beardie", "the survivor keeps its own name by default");
  assert.equal(model(db, m.beardie).designer, "MatMire", "the absorbed Model fills what the survivor lacks");
  assert.equal(V.modelDetail(db, m.lizard).mergedInto, m.beardie, "an old link lands on the survivor");
  assert.equal(count(db, "SELECT count(*) AS n FROM decisions WHERE relation = 'member_of' AND polarity = 'affirm' AND object_key = ? AND action_id = ?", m.beardie, r.actionId), 1);
  const models = count(db, "SELECT count(*) AS n FROM models");
  env.rebuild();
  assert.equal(modelOf(db, "lizard thing.gcode"), m.beardie, "after a rebuild");
  assert.equal(count(db, "SELECT count(*) AS n FROM models"), models, "no Model created again");
  env.undo(r.actionId);
  assert.equal(model(db, m.lizard).merged_into, null);
  assert.equal(model(db, m.beardie).designer, null, "the survivor's own values come back");
  assert.equal(modelOf(db, "lizard thing.gcode"), m.lizard, "automatic grouping puts it back where it was");
  env.rebuild();
  assert.equal(modelOf(db, "lizard thing.gcode"), m.lizard, "the undo survives a rebuild");
  assert.ok(db.prepare("SELECT undone_at FROM actions WHERE id = ?").get(r.actionId).undone_at, "the history keeps the undone change");
});

test("merge can keep the absorbed Model's name; both names stay recorded", t => {
  const env = setup(t), { db } = env, m = library(env);
  env.act({ kind: "merge", from: m.lizard, into: m.beardie, keepName: "from" });
  assert.equal(model(db, m.beardie).name, "lizard thing");
  assert.equal(model(db, m.beardie).name_source, "user");
  assert.equal(model(db, m.lizard).name, "lizard thing", "the absorbed row keeps its own name");
  env.group();
  assert.equal(model(db, m.beardie).name, "lizard thing", "grouping never renames a name a person chose");
});

test("approve a suggestion: merged as chosen, the item resolved, and it stays resolved after rescans and a rebuild", t => {
  const env = setup(t), { db } = env, m = library(env);
  const item = db.prepare("SELECT * FROM review_items WHERE kind = 'suggested_match' AND status = 'open'").get();
  assert.ok(item, "Kraken.gcode / Kraken.3mf: title only");
  env.act({ kind: "approve", review: item.id, survivor: m.kraken });
  assert.equal(modelOf(db, "Kraken.3mf"), m.kraken);
  assert.equal(db.prepare("SELECT status FROM review_items WHERE id = ?").get(item.id).status, "resolved");
  const d = db.prepare("SELECT from_claim_key, evidence_snapshot_json FROM decisions WHERE relation = 'member_of' AND object_key = ? AND withdrawn_at IS NULL").get(m.kraken);
  assert.ok(d.from_claim_key && d.evidence_snapshot_json, "the Decision keeps the Claim it confirmed and its Evidence");
  env.group(); env.rebuild();
  assert.equal(modelOf(db, "Kraken.3mf"), m.kraken);
  assert.equal(count(db, "SELECT count(*) AS n FROM review_items WHERE kind = 'suggested_match' AND status = 'open'"), 0);
  rejects(() => env.act({ kind: "approve", review: item.id, survivor: m.kraken }), "review_resolved");
});

test("reject a suggestion: kept apart, never suggested again, not even with new Evidence, and that survives a rebuild", t => {
  const env = setup(t), { db } = env, m = library(env);
  const item = db.prepare("SELECT * FROM review_items WHERE kind = 'suggested_match' AND status = 'open'").get();
  env.act({ kind: "reject", review: item.id });
  assert.equal(db.prepare("SELECT status FROM review_items WHERE id = ?").get(item.id).status, "resolved");
  assert.equal(count(db, "SELECT count(*) AS n FROM claims WHERE relation = 'same_model_as'"), 0);
  env.rebuild();
  assert.equal(count(db, "SELECT count(*) AS n FROM review_items WHERE kind = 'suggested_match' AND status = 'open'"), 0);
  // New Evidence that would group them automatically: still apart.
  const proj = db.prepare("SELECT id FROM files WHERE rel_path = 'Kraken.3mf'").get().id;
  db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, 'kraken.stl', 'Kraken.stl', 'model_settings')").run(proj);
  env.group();
  assert.notEqual(modelOf(db, "Kraken.3mf"), modelOf(db, "Kraken.gcode"), "the person's rejection wins");
});

test("move: the person's placement wins over automatic Evidence, in both directions, and survives a rebuild", t => {
  const env = setup(t), { db } = env, m = library(env);
  env.act({ kind: "move", model: m.beardie, files: ["q:4x Beardie.gcode"], to: m.lizard });
  assert.equal(modelOf(db, "4x Beardie.gcode"), m.lizard, "despite object names + title tying it to Beardie");
  assert.equal(count(db, "SELECT count(*) AS n FROM decisions WHERE relation = 'member_of' AND polarity = 'reject' AND object_key = ? AND withdrawn_at IS NULL", m.beardie), 1);
  env.rebuild();
  assert.equal(modelOf(db, "4x Beardie.gcode"), m.lizard);
  assert.equal(modelOf(db, "Beardie.gcode"), m.beardie);
});

test("split: the chosen files become a new Model (origin user); it survives a rebuild; undo folds them back", t => {
  const env = setup(t), { db } = env, m = library(env);
  const r = env.act({ kind: "split", model: m.beardie, files: ["q:4x Beardie.gcode"], name: "Beardie, four up" });
  const created = model(db, r.model);
  assert.deepEqual([created.origin, created.name, created.name_source], ["user", "Beardie, four up", "user"]);
  assert.equal(modelOf(db, "4x Beardie.gcode"), r.model);
  env.rebuild();
  assert.equal(modelOf(db, "4x Beardie.gcode"), r.model);
  assert.equal(modelOf(db, "Beardie.gcode"), m.beardie);
  env.undo(r.actionId);
  assert.equal(modelOf(db, "4x Beardie.gcode"), m.beardie);
  assert.equal(model(db, r.model).merged_into, m.beardie, "the emptied Model is kept, folded back");
  env.rebuild();
  assert.equal(modelOf(db, "4x Beardie.gcode"), m.beardie);
});

test("a plate or a file inside a 3MF is part of its project: it cannot be moved or split on its own", t => {
  const env = setup(t), { db } = env, m = library(env);
  rejects(() => env.act({ kind: "move", model: m.krakenProject, files: ["q:Kraken.3mf#2"], to: m.beardie }), "structural");
  const proj = db.prepare("SELECT id FROM files WHERE rel_path = 'Kraken.3mf'").get().id;
  db.prepare("INSERT INTO files (root_id, rel_path, entry_path, container_id, name, ext, role, size, mtime_ms, quick_fp, content_key, model_id, first_seen, last_seen) VALUES ('gcode', 'Kraken.3mf', 'Auxiliaries/1.png', ?, '1.png', 'png', 'image', 5, 1, 'e', 'q:entry', (SELECT model_id FROM files WHERE id = ?), 1, 1)").run(proj, proj);
  rejects(() => env.act({ kind: "split", model: m.krakenProject, files: ["q:entry"] }), "structural");
  // Moving the project file moves all of it, plates and entries included.
  env.act({ kind: "move", model: m.krakenProject, files: ["q:Kraken.3mf"], to: m.beardie });
  assert.equal(db.prepare("SELECT m.uuid FROM files f JOIN models m ON m.id = f.model_id WHERE f.content_key = 'q:entry'").get().uuid, m.beardie);
});

test("hide and unhide a Model: out of the Library, files untouched, recoverable, and that survives a rebuild", t => {
  const env = setup(t), { db } = env, m = library(env);
  const files = count(db, "SELECT count(*) AS n FROM files");
  env.act({ kind: "hide", model: m.beardie });
  assert.ok(!V.listModels(db, {}).models.some(c => c.uuid === m.beardie));
  assert.deepEqual(V.listModels(db, { hidden: true }).models.map(c => c.uuid), [m.beardie], "the hidden view recovers it");
  assert.equal(count(db, "SELECT count(*) AS n FROM files"), files, "no file touched");
  env.rebuild();
  assert.equal(model(db, m.beardie).hidden, 1);
  assert.equal(V.facets(db).hidden, 1);
  env.act({ kind: "unhide", model: m.beardie });
  assert.ok(V.listModels(db, {}).models.some(c => c.uuid === m.beardie));
});

test("hide a file: a Decision, so it stays hidden after a rebuild; unhide brings it back", t => {
  const env = setup(t), { db } = env, m = library(env);
  env.act({ kind: "hide_file", model: m.beardie, files: ["q:4x Beardie.gcode"] });
  const detail = () => V.modelDetail(db, m.beardie);
  assert.deepEqual(detail().hiddenFiles.map(f => f.path), ["4x Beardie.gcode"]);
  assert.equal(detail().printables.length, 1);
  env.rebuild();
  assert.equal(detail().hiddenFiles.length, 1);
  env.act({ kind: "unhide_file", model: m.beardie, files: ["q:4x Beardie.gcode"] });
  assert.equal(detail().hiddenFiles.length, 0);
  rejects(() => env.act({ kind: "unhide_file", model: m.beardie, files: ["q:4x Beardie.gcode"] }), "not_hidden");
});

test("rename: authored, kept by grouping and rebuilds; file names and title Evidence unchanged; undo restores", t => {
  const env = setup(t), { db } = env, m = library(env);
  const titles = db.prepare("SELECT original, normalized FROM file_titles ORDER BY file_id").all().map(r => ({ ...r }));
  const r = env.act({ kind: "rename", model: m.beardie, name: "  Bearded   dragon  " });
  assert.equal(model(db, m.beardie).name, "Bearded dragon");
  env.rebuild();
  assert.equal(model(db, m.beardie).name, "Bearded dragon");
  assert.deepEqual(db.prepare("SELECT original, normalized FROM file_titles ORDER BY file_id").all().map(x => ({ ...x })), titles, "Evidence is the files' own titles");
  assert.equal(db.prepare("SELECT name FROM files WHERE rel_path = 'Beardie.gcode'").get().name, "Beardie.gcode");
  rejects(() => env.act({ kind: "rename", model: m.beardie, name: "   " }), "name_required");
  env.undo(r.actionId);
  assert.equal(model(db, m.beardie).name, "Beardie");
  assert.equal(model(db, m.beardie).name_source, "auto");
});

test("cover: an existing picture of the Model, kept through a rebuild; a picture no longer there falls back", t => {
  const env = setup(t), { db } = env, m = library(env);
  env.act({ kind: "cover", model: m.krakenProject, file: "q:Kraken.3mf", plate: 2 });
  const card = uuid => V.listModels(db, {}).models.find(c => c.uuid === uuid);
  assert.deepEqual(card(m.krakenProject).cover, { thumb: "kp2", source: "chosen" });
  env.rebuild();
  assert.deepEqual(card(m.krakenProject).cover, { thumb: "kp2", source: "chosen" });
  rejects(() => env.act({ kind: "cover", model: m.beardie, file: "q:Kraken.3mf", plate: 1 }), "stale_cover");
  env.act({ kind: "cover", model: m.beardie, file: "q:4x Beardie.gcode" });
  db.prepare("UPDATE files SET thumb_key = NULL WHERE rel_path = '4x Beardie.gcode'").run();
  const d = V.modelDetail(db, m.beardie);
  assert.equal(d.coverMissing, true, "the chosen picture is gone: say so");
  assert.equal(d.cover.thumb, "tb1", "and show the next one");
});

test("printer correction: the person's choice wins over rescans; the file's own Evidence stays visible; undo returns to it", t => {
  const env = setup(t), { db } = env, m = library(env);
  const r = env.act({ kind: "set_printer", model: m.lizard, file: "q:lizard thing.gcode", family: "flashforge-ad5x" });
  const pv = () => V.modelDetail(db, m.lizard).printables[0].printer;
  assert.equal(pv().state, "decision");
  assert.equal(pv().family, "flashforge-ad5x");
  assert.equal(pv().fileSays.family, "snapmaker-u1", "File says U1 → set to AD5X");
  assert.ok(pv().evidence.length, "the extracted Evidence is still there");
  const { diagnosticsGrouping } = require("../../library/diagnosticsGrouping");
  const dv = diagnosticsGrouping(db, {}).models.find(x => x.uuid === m.lizard).files[0].variants[0].printer;
  assert.deepEqual([dv.fileSays.family, dv.family, dv.state], ["snapmaker-u1", "flashforge-ad5x", "decision"], "Diagnostics: file says X → a person set Y");
  const dec = db.prepare("SELECT value_json FROM decisions WHERE relation = 'targets_printer' AND withdrawn_at IS NULL").get();
  assert.equal(JSON.parse(dec.value_json).fileSays, "snapmaker-u1");
  env.rebuild();
  assert.equal(pv().family, "flashforge-ad5x", "a rebuild re-reads the file but the choice stays");
  assert.equal(pv().fileSays.family, "snapmaker-u1");
  rejects(() => env.act({ kind: "set_printer", model: m.lizard, file: "q:lizard thing.gcode", family: "not-a-printer" }), "unknown_family");
  env.undo(r.actionId);
  assert.equal(pv().family, "snapmaker-u1");
  assert.equal(pv().state, "applied");
});

test("undo is refused while a later change depends on it, and a done undo can't be repeated", t => {
  const env = setup(t), { db } = env, m = library(env);
  const r1 = env.act({ kind: "move", model: m.beardie, files: ["q:4x Beardie.gcode"], to: m.lizard });
  const r2 = env.act({ kind: "move", model: m.lizard, files: ["q:4x Beardie.gcode"], to: m.kraken });
  rejects(() => env.undo(r1.actionId), "undo_blocked");
  env.undo(r2.actionId);
  assert.equal(modelOf(db, "4x Beardie.gcode"), m.lizard, "undoing the later move restores the earlier placement");
  env.undo(r1.actionId);
  assert.equal(modelOf(db, "4x Beardie.gcode"), m.beardie);
  rejects(() => env.undo(r1.actionId), "already_undone");
  const n1 = env.act({ kind: "rename", model: m.beardie, name: "One" });
  env.act({ kind: "rename", model: m.beardie, name: "Two" });
  rejects(() => env.undo(n1.actionId), "undo_blocked");
  const h = actions.history(db, m.beardie);
  assert.deepEqual(h.slice(0, 2).map(x => [x.kind, x.undoable]), [["rename", true], ["rename", false]]);
});

test("stale requests answer 409 with a reason, never apply to something else", t => {
  const env = setup(t), { db } = env, m = library(env);
  rejects(() => env.act({ kind: "move", model: m.lizard, files: ["q:Beardie.gcode"], to: m.kraken }), "stale_file");
  env.act({ kind: "merge", from: m.lizard, into: m.beardie });
  rejects(() => env.act({ kind: "rename", model: m.lizard, name: "x" }), "model_merged");
  rejects(() => env.act({ kind: "merge", from: m.kraken, into: m.lizard }), "model_merged");
  rejects(() => env.act({ kind: "move", model: m.beardie, files: ["q:Beardie.gcode"], to: "00000000-0000-0000-0000-999999999999" }), "model_not_found");
  rejects(() => env.act({ kind: "merge", from: m.beardie, into: m.beardie }), "same_model");
  rejects(() => env.act({ kind: "dismiss", review: 999999 }), "review_not_found");
  rejects(() => env.act({ kind: "teleport" }), "unknown_action");
  assert.equal(count(db, "SELECT count(*) AS n FROM actions WHERE undone_at IS NULL"), 1, "a refused action leaves no trace");
});

test("dismiss: the item stays dismissed through rescans and rebuilds; undo reopens it", t => {
  const env = setup(t), { db } = env;
  library(env);
  const item = db.prepare("SELECT * FROM review_items WHERE status = 'open' ORDER BY id LIMIT 1").get();
  const r = env.act({ kind: "dismiss", review: item.id });
  env.rebuild();
  assert.equal(db.prepare("SELECT status FROM review_items WHERE subject_key = ?").get(item.subject_key).status, "dismissed");
  env.undo(r.actionId);
  assert.equal(db.prepare("SELECT status FROM review_items WHERE subject_key = ?").get(item.subject_key).status, "open");
});

test("search finds camel-case and punctuated names however they are typed", t => {
  const env = setup(t), { db } = env;
  env.file({ rel: "TinyTREX.gcode", objects: ["a.stl"] });
  env.file({ rel: "Skeleton T-Rex.gcode", objects: ["b.stl"] });
  env.file({ rel: "Big T Rex.gcode", objects: ["c.stl"] });
  env.file({ rel: "Rex the dog.gcode", objects: ["d.stl"] });
  env.group();
  const names = q => V.listModels(db, { q }).models.map(c => c.name).sort();
  for (const q of ["trex", "t rex", "t-rex", "T-REX", "TRex"]) assert.deepEqual(names(q), ["Big T Rex", "Skeleton T-Rex", "TinyTREX"], q);
  assert.deepEqual(names("tiny"), ["TinyTREX"], "camel-case words are words");
  assert.deepEqual(names("rex"), ["Big T Rex", "Rex the dog", "Skeleton T-Rex"], "a plain word still matches as before");
  assert.equal(V.listModels(db, { q: "trex" }).models.find(c => c.name === "TinyTREX").name, "TinyTREX", "display spelling untouched");
});
