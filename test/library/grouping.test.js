// test/library/grouping.test.js — M4 grouping (docs/library-design.md §4.4,
// §4.5, §6.3, §7, §8) on an index written directly, so each rule is tested
// on exactly the Evidence it needs: the confidence policy and independence,
// determinism, generic protection, conflicts, Decisions (precedence,
// rejection, rebuild, move, moved-and-modified), duplicates, source Evidence,
// multi-printer Models and the export.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibraryStore } = require("../../library/LibraryStore");
const grouping = require("../../library/grouping");
const { recordDecision } = require("../../library/decisions");
const { diagnosticsGrouping, stableExport } = require("../../library/diagnosticsGrouping");
const { normalizeTitle, compareTitles } = require("../../library/titles");

const quiet = { log() {}, warn() {}, error() {} };

function setup(t, roots = [{ id: "r", grouping: "files" }]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-group-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  for (const r of roots) store.roots.insert({ id: r.id, name: r.id, path: base, grouping: r.grouping || "files", enabled: true, scan_every_min: 30, created_at: 1 });
  const db = store.db;
  for (const r of roots) if (r.indexed !== false) indexed(db, r.id);
  let n = 0;
  const env = { store, db, base, reportPath: path.join(base, "report.json"), uuid: () => "model-" + String(++n).padStart(3, "0") };
  env.run = () => grouping.run(db, { now: 1000, reportPath: env.reportPath, uuid: env.uuid });
  return env;
}
// A completed scan of a location (what grouping takes as "indexed").
const indexed = (db, rootId) => db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES (?, 1, 2, 'ok')").run(rootId);

// One file row. objects: names as the slicer wrote them; project: a 3MF's
// stated facts; family: a plain G-code Variant's printer.
function file(db, { root = "r", rel, role = "sliced", ck = null, objects = [], origin = "exclude_object", project = null, family = undefined, state = "present", sha = null }) {
  const name = rel.split("/").pop();
  const ext = (/\.([^.]+)$/.exec(name) || [, ""])[1].toLowerCase();
  const key = ck || (sha ? sha : "q:" + rel);
  const id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, sha256, content_key, state, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, 100, 1, ?, ?, ?, ?, 1, 1)`).run(root, rel, name, ext, role, key.replace(/^q:/, ""), sha, key, state).lastInsertRowid);
  for (const o of objects) db.prepare("INSERT OR IGNORE INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, ?, ?, ?)").run(id, o.toLowerCase().replace(/\.stl$/, ""), o, origin);
  if (project) db.prepare("INSERT INTO projects (file_id, flavour, title, designer, design_model_id) VALUES (?, 'bambu', ?, ?, ?)").run(id, project.title || null, project.designer || null, project.designModelId || null);
  if (family !== undefined) db.prepare("INSERT INTO variants (file_id, plate_no, printer_family) VALUES (?, NULL, ?)").run(id, family);
  return { id, key, loc: root + ":" + rel };
}
const modelOf = (db, loc) => {
  const [root, ...rest] = loc.split(":");
  const r = db.prepare("SELECT m.uuid, m.name FROM files f JOIN models m ON m.id = f.model_id WHERE f.root_id = ? AND f.rel_path = ? AND f.entry_path = ''").get(root, rest.join(":"));
  return r ? r.uuid : null;
};
const groupsOf = db => {
  const out = new Map();
  for (const r of db.prepare("SELECT m.uuid, f.root_id || ':' || f.rel_path AS loc FROM files f JOIN models m ON m.id = f.model_id WHERE f.entry_path = '' ORDER BY loc").all()) {
    if (!out.has(r.uuid)) out.set(r.uuid, []);
    out.get(r.uuid).push(r.loc);
  }
  return [...out.values()].map(v => v.join(" + ")).sort();
};
const openReviews = (db, kind) => db.prepare("SELECT * FROM review_items WHERE kind = ? AND status = 'open' ORDER BY subject_key").all(kind);
const report = env => JSON.parse(fs.readFileSync(env.reportPath, "utf8"));
const memberClaim = (db, key) => db.prepare("SELECT * FROM claims WHERE relation = 'member_of' AND subject_key = ?").get(key);

// ---------------------------------------------------------------- normalisation

test("title normalisation records every transformation it made", () => {
  const t = normalizeTitle("4x Beardie_PLA_3h55m.gcode");
  assert.equal(t.original, "4x Beardie_PLA_3h55m");
  assert.equal(t.normalized, "beardie");
  assert.deepEqual(t.transformations.map(x => x.rule).sort(), ["copy_count", "extension", "material_time"]);
  assert.deepEqual(t.transformations.find(x => x.rule === "copy_count").removed, "4x");
  const tag = normalizeTitle("[CP] TinyTREX @ 190.gcode");
  assert.equal(tag.normalized, "tinytrex");
  assert.deepEqual(tag.transformations.map(x => x.rule).sort(), ["extension", "tag", "temperature"]);
  const plate = normalizeTitle("Dragon Egg (Plate 2).3mf");
  assert.equal(plate.normalized, "dragon egg");
  assert.ok(plate.transformations.some(x => x.rule === "plate" && x.removed === "Plate 2"));
  const designer = normalizeTitle("Cinderwing3D Crystal Dragon.gcode", { designers: ["Cinderwing3D"] });
  assert.equal(designer.normalized, "crystal dragon");
  assert.ok(designer.transformations.some(x => x.rule === "designer"));
});

test("title comparison: exact multi-word is medium; generic is weak; short is nothing; containment is weak", () => {
  const n = s => normalizeTitle(s);
  const c = (a, b) => compareTitles(n(a), n(b));
  assert.equal(c("Skeleton T-Rex_PLA_1h.gcode", "2x Skeleton T-Rex.gcode").strength, "medium");
  const one = c("4x Beardie.gcode", "Beardie @ 160.gcode");
  assert.equal(one.strength, "medium");
  assert.equal(one.compare.original_a, "4x Beardie");
  assert.equal(one.compare.normalized_b, "beardie");
  assert.equal(c("3DBenchy.gcode", "3DBenchy.3mf").strength, "weak", "a generic title is at most weak");
  assert.equal(c("Assembly.3mf", "Assembly.gcode").strength, "weak");
  assert.equal(c("Cat.gcode", "Cat.3mf").strength, "none", "under 4 characters is never Evidence");
  assert.equal(c("Baby Dragon.gcode", "Baby Dragon Blaze.gcode").strength, "weak", "containment explains, it does not corroborate");
});

// ---------------------------------------------------------------- the policy

test("two independent groups at medium group automatically; one group is only a suggestion", t => {
  const env = setup(t);
  const { db } = env;
  const a = file(db, { rel: "4x Beardie_PLA_3h55m.gcode", objects: ["Beardie.stl"] });
  const b = file(db, { rel: "Beardie @ 160.gcode", objects: ["Beardie.stl"] });
  const c = file(db, { rel: "beardie.3mf", role: "project" });                       // title only
  env.run();
  assert.equal(modelOf(db, a.loc), modelOf(db, b.loc), "object names + title: two independent groups");
  const claim = memberClaim(db, a.key);
  assert.equal(claim.confidence, "high");
  assert.equal(claim.state, "applied");
  assert.deepEqual(claim.groups.split(",").sort(), ["filename", "internal-content"]);
  assert.notEqual(modelOf(db, c.loc), modelOf(db, a.loc), "a title alone never groups");
  const sugg = db.prepare("SELECT * FROM claims WHERE relation = 'same_model_as'").all();
  assert.equal(sugg.length, 1);
  assert.equal(sugg[0].confidence, "medium");
  assert.equal(sugg[0].state, "suggested");
  const r = report(env).suggestions[0];
  assert.match(r.missing, /only one independence group \(filename\)/);
  assert.equal(openReviews(db, "suggested_match").length, 1);
});

test("fields copied from the same source are not independent corroboration", t => {
  const env = setup(t);
  const { db } = env;
  // A 3MF's project Title and its file name are both the filename group.
  const p = file(db, { rel: "Dragon Egg.3mf", role: "project", project: { title: "Dragon Egg" } });
  const g = file(db, { rel: "Dragon Egg.gcode" });
  // A sliced_from Claim by object names is the same object-name Evidence
  // compared directly: it must not count twice.
  const x = file(db, { rel: "Whale.3mf", role: "project", objects: ["Whale body.stl"], origin: "model_settings" });
  const y = file(db, { rel: "Ocean thing.gcode", objects: ["Whale body.stl"] });
  db.prepare(`INSERT INTO claims (claim_key, subject_type, subject_key, relation, object_type, object_key, method, confidence, state, groups, evidence_json, rule_version, created_at, updated_at)
    VALUES ('k1', 'variant', ?, 'sliced_from', 'project', ?, 'object_names', 'medium', 'suggested', 'internal-content', '[{"signal":"object_names","value":"whale body"}]', 1, 1, 1)`).run(y.key, x.key);
  env.run();
  assert.notEqual(modelOf(db, p.loc), modelOf(db, g.loc));
  assert.notEqual(modelOf(db, x.loc), modelOf(db, y.loc));
  const methods = report(env).suggestions.map(s => s.groups.join(",")).sort();
  assert.deepEqual(methods, ["filename", "internal-content"], "each pair is one group: a suggestion, not a merge");
});

test("conflicting Evidence is recorded, never grouped or suggested", t => {
  const env = setup(t);
  const { db } = env;
  const a = file(db, { rel: "Dragon/Crystal Dragon.gcode", objects: ["Crystal Dragon body.stl"] });
  const b = file(db, { rel: "Other/Crystal Dragon.gcode", objects: ["Crystal Wing.stl"] });
  env.run();
  assert.notEqual(modelOf(db, a.loc), modelOf(db, b.loc));
  assert.equal(report(env).suggestions.length, 0);
  const rec = report(env).recorded.find(e => e.method === "conflict");
  assert.ok(rec, "the pair is kept, with why");
  assert.match(rec.missing, /object names differ entirely/);
});

test("a folders-mode model folder corroborates but never groups alone (rule v2)", t => {
  const env = setup(t, [{ id: "f", grouping: "folders" }]);
  const { db } = env;
  // The real-library false merge: one designer's folder, three animals.
  const a = file(db, { root: "f", rel: "Zou/Axolotl.gcode", objects: ["Axolotl.stl"] });
  const b = file(db, { root: "f", rel: "Zou/Sea Turtle.gcode", objects: ["Turtle.stl"] });
  const c = file(db, { root: "f", rel: "Zou/Bearded Dragon.gcode" });
  // Same folder and the same objects: two groups.
  const d = file(db, { root: "f", rel: "Kitty/kitty v2.gcode", objects: ["Kitty.stl"] });
  const e = file(db, { root: "f", rel: "Kitty/flexi cat print.gcode", objects: ["Kitty.stl"] });
  env.run();
  assert.equal(new Set([modelOf(db, a.loc), modelOf(db, b.loc), modelOf(db, c.loc)]).size, 3);
  assert.equal(modelOf(db, d.loc), modelOf(db, e.loc));
  assert.match(memberClaim(db, d.key).method, /model_folder/);
});

// ---------------------------------------------------------------- generic protection

test("Benchy and Assembly are protected: shared generic names never merge unrelated files", t => {
  const env = setup(t);
  const { db } = env;
  const b1 = file(db, { rel: "3DBenchy.gcode", objects: ["3DBenchy.stl"] });
  const b2 = file(db, { rel: "U1/3DBenchy.gcode", objects: ["3DBenchy.stl"] });
  const a1 = file(db, { rel: "Owl.3mf", role: "project", objects: ["Assembly"], origin: "model_settings" });
  const a2 = file(db, { rel: "Rocket.3mf", role: "project", objects: ["Assembly"], origin: "model_settings" });
  const a3 = file(db, { rel: "Assembly.3mf", role: "project", objects: ["Assembly"], origin: "model_settings" });
  const a4 = file(db, { rel: "Assembly.gcode", objects: ["Assembly"] });
  env.run();
  assert.notEqual(modelOf(db, b1.loc), modelOf(db, b2.loc), "two Benchies are no evidence of each other");
  assert.equal(new Set([a1, a2, a3, a4].map(x => modelOf(db, x.loc))).size, 4, "Assembly merges nothing, even with the same title");
  assert.equal(report(env).suggestions.length, 0, "and suggests nothing");
  const prot = report(env).protectedClusters;
  assert.ok(prot.some(p => p.terms.includes("assembly") && /Assembly/.test(p.reason)), "the reason is shown");
  assert.ok(prot.some(p => p.terms.includes("3dbenchy")));
  assert.ok(openReviews(db, "ambiguous_grouping").some(r => r.subject_key === "ambiguous:generic:3dbenchy"));
  const ign = report(env).recorded.concat(report(env).suggestions).flatMap(e => e.ignored || []);
  assert.ok(ign.some(i => i.signal === "object_name" && /generic/.test(i.why)), "Diagnostics says what was ignored as generic");
});

test("a name used under three unrelated titles becomes common; a model's own colourways do not", t => {
  const env = setup(t);
  const { db } = env;
  // "Stand plate" under three unrelated titles: common.
  const s1 = file(db, { rel: "Owl Display.gcode", objects: ["stand plate.stl"] });
  const s2 = file(db, { rel: "Rocket Display.gcode", objects: ["stand plate.stl"] });
  const s3 = file(db, { rel: "Frog Stand.gcode", objects: ["stand plate.stl"] });
  // "TinyTREX" under related titles (copy counts, spacing): still identifying.
  const t1 = file(db, { rel: "2x TinyTREX.gcode", objects: ["Cinderwing3D_TinyTREX.stl"] });
  const t2 = file(db, { rel: "[CP] Tiny TREX @ 190.gcode", objects: ["Cinderwing3D_TinyTREX.stl"] });
  const t3 = file(db, { rel: "6x TinyTREX.gcode", objects: ["Cinderwing3D_TinyTREX.stl"] });
  env.run();
  assert.equal(new Set([s1, s2, s3].map(x => modelOf(db, x.loc))).size, 3);
  const prot = report(env).protectedClusters.find(p => p.terms.includes("stand plate"));
  assert.match(prot.reason, /3 unrelated titles/);
  assert.equal(modelOf(db, t1.loc), modelOf(db, t3.loc), "object names + exact title");
  assert.notEqual(modelOf(db, t2.loc), modelOf(db, t1.loc), "\"tiny trex\" is not an exact title match: a suggestion, not a merge");
});

// ---------------------------------------------------------------- determinism

test("grouping does not depend on scan order", t => {
  const specs = [
    { rel: "a/Beardie.gcode", objects: ["Beardie.stl"] }, { rel: "b/4x Beardie.gcode", objects: ["Beardie.stl"] },
    { rel: "c/Beardie_PLA_2h.gcode", objects: ["Beardie.stl"] }, { rel: "d/beardie.3mf", role: "project" },
    { rel: "e/Owl.3mf", role: "project", objects: ["Assembly"], origin: "model_settings" }, { rel: "f/Kitty.gcode", objects: ["Kitty.stl"] },
    { rel: "g/Flexi Kitty.gcode", objects: ["Kitty.stl"] }, { rel: "h/Kitty Flexi.gcode", objects: ["Kitty body.stl"] },
    { rel: "i/Skeleton T-Rex.gcode", objects: ["T-Rex.stl", "Stand.stl"] }, { rel: "j/2x Skeleton T-Rex.gcode", objects: ["T-Rex.stl", "Stand.stl"] },
  ];
  const outcome = order => {
    const env = setup(t);
    for (const i of order) file(env.db, specs[i]);
    env.run();
    const r = report(env);
    return { groups: groupsOf(env.db), suggestions: r.suggestions.map(s => s.files.join(" ~ ")).sort(), claims: env.db.prepare("SELECT subject_key, method, confidence FROM claims WHERE relation = 'member_of' ORDER BY subject_key").all().map(x => ({ ...x })) };
  };
  const forward = outcome(specs.map((_, i) => i));
  const backward = outcome(specs.map((_, i) => specs.length - 1 - i));
  const shuffled = outcome([3, 7, 0, 9, 5, 1, 8, 2, 6, 4]);
  assert.deepEqual(backward, forward);
  assert.deepEqual(shuffled, forward);
  assert.ok(forward.groups.some(g => g.split(" + ").length === 3), "the three Beardies are one Model");
});

// ---------------------------------------------------------------- Decisions

test("a Decision wins over automatic Evidence: a separated file stays out, a confirmed one stays in", t => {
  const env = setup(t);
  const { db } = env;
  const a = file(db, { rel: "Beardie.gcode", objects: ["Beardie.stl"] });
  const b = file(db, { rel: "4x Beardie.gcode", objects: ["Beardie.stl"] });
  const c = file(db, { rel: "lizard thing.gcode" });
  env.run();
  const m = modelOf(db, a.loc);
  assert.equal(modelOf(db, b.loc), m);
  recordDecision(db, { subject_type: "file", subject_key: b.key, relation: "member_of", polarity: "reject", object_type: "model", object_key: m, subject_hint: b.loc });
  recordDecision(db, { subject_type: "file", subject_key: c.key, relation: "member_of", polarity: "affirm", object_type: "model", object_key: m, subject_hint: c.loc });
  env.run();
  assert.equal(modelOf(db, a.loc), m, "the Model keeps its identity");
  assert.notEqual(modelOf(db, b.loc), m, "the separated file is out, despite two groups of Evidence");
  assert.equal(modelOf(db, c.loc), m, "the confirmed file is in, with no Evidence at all");
  const row = db.prepare("SELECT model_decision_id FROM files WHERE id = ?").get(c.id);
  assert.ok(row.model_decision_id);
  env.run();
  assert.notEqual(modelOf(db, b.loc), m, "and stays out on every rerun");
});

test("a rejected suggestion does not come back", t => {
  const env = setup(t);
  const { db } = env;
  const a = file(db, { rel: "Kraken.gcode", objects: ["Kraken.stl"] });
  const b = file(db, { rel: "Kraken.3mf", role: "project" });
  env.run();
  const [ma, mb] = [modelOf(db, a.loc), modelOf(db, b.loc)];
  assert.equal(openReviews(db, "suggested_match").length, 1);
  recordDecision(db, { subject_type: "model", subject_key: ma, relation: "distinct_from", object_type: "model", object_key: mb });
  env.run();
  assert.equal(db.prepare("SELECT count(*) AS n FROM claims WHERE relation = 'same_model_as'").get().n, 0);
  assert.equal(openReviews(db, "suggested_match").length, 0);
  // Even when new Evidence would group them automatically, they stay apart.
  db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, 'kraken', 'Kraken.stl', 'model_settings')").run(b.id);
  env.run();
  assert.notEqual(modelOf(db, a.loc), modelOf(db, b.loc));
  assert.ok(report(env).blocked.some(x => /distinct_from/.test(x.blockedBy)), "the prevented merge is shown");
});

test("a dismissed Review Item stays dismissed; a cleared one auto-closes", t => {
  const env = setup(t);
  const { db } = env;
  file(db, { rel: "x/Dino.gcode", ck: "q:same" });
  file(db, { rel: "y/Dino.gcode", ck: "q:same" });
  const k = file(db, { rel: "Kraken.gcode", objects: ["Kraken.stl"] });
  file(db, { rel: "Kraken.3mf", role: "project" });
  env.run();
  db.prepare("UPDATE review_items SET status = 'dismissed' WHERE kind = 'possible_duplicate'").run();
  db.prepare("DELETE FROM files WHERE id = ?").run(k.id);
  env.run();
  assert.equal(db.prepare("SELECT status FROM review_items WHERE kind = 'possible_duplicate'").get().status, "dismissed");
  const s = db.prepare("SELECT status, resolution_note FROM review_items WHERE kind = 'suggested_match'").get();
  assert.deepEqual({ ...s }, { status: "auto_closed", resolution_note: "the condition cleared" });
});

test("Models and Decisions survive a full derived rebuild, even while locations are re-indexed one at a time", t => {
  const env = setup(t, [{ id: "r1" }, { id: "r2" }]);
  const { db, store } = env;
  const specs = [
    { root: "r1", rel: "Beardie.gcode", objects: ["Beardie.stl"] }, { root: "r2", rel: "AD5X/Beardie.gcode", objects: ["Beardie.stl"] },
    { root: "r2", rel: "I7/4x Beardie.gcode", objects: ["Beardie.stl"] }, { root: "r2", rel: "odd one.gcode" },
  ];
  const fs1 = specs.map(s => file(db, s));
  env.run();
  const m = modelOf(db, fs1[0].loc);
  assert.equal(groupsOf(db).find(g => g.includes("r1:Beardie")).split(" + ").length, 3);
  recordDecision(db, { subject_type: "file", subject_key: fs1[3].key, relation: "member_of", object_type: "model", object_key: m, subject_hint: fs1[3].loc });
  env.run();
  const before = groupsOf(db);
  const modelsBefore = db.prepare("SELECT count(*) AS n FROM models").get().n;

  store.rebuildDerived();
  assert.equal(db.prepare("SELECT count(*) AS n FROM files").get().n, 0);
  // r1 is re-indexed first: grouping runs on a partial index.
  file(db, specs[0]);
  indexed(db, "r1");
  env.run();
  assert.equal(modelOf(db, specs[0].root + ":" + specs[0].rel), m);
  assert.equal(openReviews(db, "decision_unmatched").length, 0, "a Decision about a file in a location not yet re-indexed is not unmatched");
  assert.equal(openReviews(db, "empty_model").length, 0, "nor is a Model whose files are not indexed yet empty");
  // Then r2, in another order.
  for (const s of specs.slice(1).reverse()) file(db, s);
  indexed(db, "r2");
  env.run();
  assert.deepEqual(groupsOf(db), before, "the same Models, with the same members");
  assert.equal(modelOf(db, "r2:odd one.gcode"), m, "the Decision still applies");
  assert.equal(db.prepare("SELECT count(*) AS n FROM models").get().n, modelsBefore, "no Model was created again");
});

test("a moved or renamed file keeps its Model and its Decision", t => {
  const env = setup(t);
  const { db } = env;
  const a = file(db, { rel: "Beardie.gcode", objects: ["Beardie.stl"] });
  const b = file(db, { rel: "4x Beardie.gcode", objects: ["Beardie.stl"] });
  const c = file(db, { rel: "lizard.gcode" });
  env.run();
  const m = modelOf(db, a.loc);
  const d = recordDecision(db, { subject_type: "file", subject_key: c.key, relation: "member_of", object_type: "model", object_key: m, subject_hint: c.loc });
  env.run();
  // Same content, new place and name.
  db.prepare("UPDATE files SET rel_path = 'archive/lizard renamed.gcode', name = 'lizard renamed.gcode' WHERE id = ?").run(c.id);
  db.prepare("UPDATE files SET rel_path = 'archive/old beardie.gcode', name = 'old beardie.gcode' WHERE id = ?").run(a.id);
  env.run();
  assert.equal(modelOf(db, "r:archive/lizard renamed.gcode"), m);
  assert.equal(modelOf(db, b.loc), m, "anchors re-find the Model whatever the files are called now");
  assert.equal(db.prepare("SELECT subject_hint FROM decisions WHERE id = ?").get(d).subject_hint, "r:archive/lizard renamed.gcode", "the hint follows the move");
  assert.equal(openReviews(db, "decision_unmatched").length, 0);
});

test("a file moved and modified while unseen raises decision_unmatched; changed in place raises file_changed", t => {
  const env = setup(t);
  const { db } = env;
  const a = file(db, { rel: "Beardie.gcode", objects: ["Beardie.stl"] });
  const b = file(db, { rel: "lizard.gcode" });
  const c = file(db, { rel: "frog.gcode" });
  env.run();
  const m = modelOf(db, a.loc);
  const d1 = recordDecision(db, { subject_type: "file", subject_key: b.key, relation: "member_of", object_type: "model", object_key: m, subject_hint: b.loc });
  const d2 = recordDecision(db, { subject_type: "file", subject_key: c.key, relation: "member_of", object_type: "model", object_key: m, subject_hint: c.loc });
  env.run();
  // lizard: moved AND changed (new place, new content) — never guessed.
  db.prepare("DELETE FROM files WHERE id = ?").run(b.id);
  file(db, { rel: "elsewhere/lizard v2.gcode", ck: "q:lizard-new" });
  // frog: changed in place.
  db.prepare("UPDATE files SET content_key = 'q:frog-new', quick_fp = 'frog-new' WHERE id = ?").run(c.id);
  env.run();
  const un = openReviews(db, "decision_unmatched");
  assert.deepEqual(un.map(r => r.subject_key), ["decision:" + d1]);
  assert.equal(un[0].location, "r:lizard.gcode");
  assert.equal(un[0].priority, 1);
  const ch = openReviews(db, "file_changed");
  assert.deepEqual(ch.map(r => r.subject_key), ["changed:" + d2]);
  assert.equal(ch[0].content_key, "q:frog-new");
  assert.notEqual(modelOf(db, "r:elsewhere/lizard v2.gcode"), m, "the Decision is not transferred by guesswork");
});

test("an unscanned location's Decisions are not reported as unmatched", t => {
  const env = setup(t, [{ id: "r" }, { id: "late", indexed: false }]);
  const { db } = env;
  const a = file(db, { rel: "Beardie.gcode", objects: ["Beardie.stl"] });
  env.run();
  recordDecision(db, { subject_type: "file", subject_key: "q:gone", relation: "member_of", object_type: "model", object_key: modelOf(db, a.loc), subject_hint: "late:x.gcode" });
  env.run();
  assert.equal(openReviews(db, "decision_unmatched").length, 0);
  indexed(db, "late");
  env.run();
  assert.equal(openReviews(db, "decision_unmatched").length, 1);
});

// ---------------------------------------------------------------- duplicates, sources, printers

test("duplicates are recorded per location pair, never merged away or hidden", t => {
  const env = setup(t);
  const { db } = env;
  const a = file(db, { rel: "skelly.gcode", sha: "a".repeat(64) });
  const b = file(db, { rel: "boat.gcode", sha: "a".repeat(64) });
  env.run();
  const dup = db.prepare("SELECT * FROM claims WHERE relation = 'duplicate_of'").get();
  assert.deepEqual([dup.subject_key, dup.object_key, dup.method, dup.confidence], ["r:boat.gcode", "r:skelly.gcode", "sha256", "exact"]);
  assert.equal(modelOf(db, a.loc), modelOf(db, b.loc), "the same content is one Model");
  assert.equal(db.prepare("SELECT count(*) AS n FROM files WHERE hidden = 1").get().n, 0);
  assert.equal(openReviews(db, "possible_duplicate").length, 1);
});

test("source Evidence: a resolved source_file is identity, an ambiguous one is ignored, an unresolved path is listed only", t => {
  const env = setup(t);
  const { db } = env;
  const src = file(db, { rel: "Whale.stl", role: "source" });
  const p = file(db, { rel: "Ocean Project.3mf", role: "project" });
  const amb = file(db, { rel: "Shark.stl", role: "source" });
  const q = file(db, { rel: "Sea.3mf", role: "project" });
  const lonely = file(db, { rel: "Lonely.3mf", role: "project" });
  db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, 'c:/models/missing.stl', 'C:/models/missing.stl', 'source_file')").run(lonely.id);
  const claim = (k, s, o, state) => db.prepare(`INSERT INTO claims (claim_key, subject_type, subject_key, relation, object_type, object_key, method, confidence, state, groups, evidence_json, rule_version, created_at, updated_at)
    VALUES (?, 'file', ?, 'source_of', 'file', ?, 'source_file_meta', ?, ?, 'identity', '[{"signal":"source_file","value":"x"}]', 1, 1, 1)`).run(k, s, o, state === "applied" ? "high" : "medium", state);
  claim("s1", src.key, p.key, "applied");
  claim("s2", amb.key, q.key, "suggested");
  env.run();
  assert.equal(modelOf(db, src.loc), modelOf(db, p.loc), "a resolved source reference is identity Evidence");
  assert.equal(memberClaim(db, p.key).method, "source_file");
  assert.notEqual(modelOf(db, amb.loc), modelOf(db, q.loc), "an ambiguous one does not group");
  assert.ok(report(env).unresolvedSources.some(u => u.file === lonely.loc && /weak/.test(u.note)));
  assert.equal(openReviews(db, "source_may_match").length, 1);
});

test("one Model across printers: Variants keep their own printer, and a printer folder is not grouping or printer Evidence", t => {
  const env = setup(t);
  const { db } = env;
  db.prepare("INSERT INTO folder_classes (root_id, rel_path, class, method, evidence_json, rule_version) VALUES ('r', 'AD5X', 'printer_family_like', 'x', '[{\"families\":[\"flashforge-ad5x\"]}]', 1), ('r', 'I7', 'printer_family_like', 'x', '[{\"families\":[\"anycubic-i7\"]}]', 1)").run();
  const a = file(db, { rel: "AD5X/Beardie.gcode", objects: ["Beardie.stl"], family: "flashforge-ad5x" });
  const b = file(db, { rel: "I7/4x Beardie.gcode", objects: ["Beardie.stl"], family: "snapmaker-u1" });
  const c = file(db, { rel: "I7/Gecko.gcode", objects: ["Gecko.stl"], family: "snapmaker-u1" });
  env.run();
  assert.equal(modelOf(db, a.loc), modelOf(db, b.loc));
  assert.notEqual(modelOf(db, c.loc), modelOf(db, b.loc), "sharing a printer folder groups nothing");
  const diag = diagnosticsGrouping(db, { reportPath: env.reportPath });
  const beardie = diag.models.find(m => m.files.length === 2);
  assert.equal(beardie.printers.length, 2, "both printers, each from its own Variant");
  assert.deepEqual(db.prepare("SELECT printer_family FROM variants ORDER BY file_id").all().map(v => v.printer_family), ["flashforge-ad5x", "snapmaker-u1", "snapmaker-u1"], "grouping never changes a Variant's printer");
  assert.ok(openReviews(db, "folder_disagrees").some(r => r.location === b.loc), "the I7 folder disagreeing is informational");
});

test("design ids: the same MakerWorld design groups alone; different designs conflict", t => {
  const env = setup(t);
  const { db } = env;
  const a = file(db, { rel: "Keyrambit.3mf", role: "project", project: { title: "Keyrambit", designModelId: "D1" } });
  const b = file(db, { rel: "rivals keychain.3mf", role: "project", project: { title: "Rivals", designModelId: "D1" } });
  const c = file(db, { rel: "x/Keyrambit.3mf", role: "project", project: { title: "Keyrambit", designModelId: "D2" } });
  env.run();
  assert.equal(modelOf(db, a.loc), modelOf(db, b.loc));
  assert.equal(memberClaim(db, a.key).method, "design_model_id");
  assert.notEqual(modelOf(db, c.loc), modelOf(db, a.loc));
});

// ---------------------------------------------------------------- export

test("the export is stable across reruns and carries the rule versions", t => {
  const env = setup(t);
  const { db } = env;
  file(db, { rel: "Beardie.gcode", objects: ["Beardie.stl"] });
  file(db, { rel: "4x Beardie.gcode", objects: ["Beardie.stl"] });
  file(db, { rel: "Beardie.3mf", role: "project" });
  file(db, { rel: "Assembly.3mf", role: "project", objects: ["Assembly"], origin: "model_settings" });
  file(db, { rel: "Owl.3mf", role: "project", objects: ["Assembly"], origin: "model_settings" });
  env.run();
  const one = JSON.stringify(stableExport(diagnosticsGrouping(db, { reportPath: env.reportPath })));
  env.run();
  const two = JSON.stringify(stableExport(diagnosticsGrouping(db, { reportPath: env.reportPath })));
  assert.equal(two, one);
  const e = JSON.parse(one);
  assert.equal(e.ruleVersion, grouping.RULE_VERSION);
  assert.equal(typeof e.titleRuleVersion, "number");
  assert.equal(e.generatedAt, undefined, "no run timestamp in the export");
});
