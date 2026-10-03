// test/library/identityCache.test.js — the durable identity cache (§4.5,
// §4.6): a derived rebuild drops every full hash, and rediscovered files must
// find their stable content keys again before the re-hash, or Models are
// recreated and Decisions stop applying (the failed M4 live rebuild). The
// cache restores a key only when the fingerprint is unique, and the file's own
// full hash later confirms or overrules it; an identity is never transferred.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibraryStore } = require("../../library/LibraryStore");
const idx = require("../../library/indexStore");
const grouping = require("../../library/grouping");
const { recordDecision } = require("../../library/decisions");
const { extractFromWindow } = require("../../library/gcodeExtract");
const { gcodeFile } = require("./helpers/gcode");

const quiet = { log() {}, warn() {}, error() {} };
const SHA = c => c.repeat(64);

function setup(t, roots = ["r"]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ident-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  for (const id of roots) store.roots.insert({ id, name: id, path: base, grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
  const db = store.db;
  let n = 0, clock = 1000;
  const env = { store, db };
  env.group = () => grouping.run(db, { now: ++clock, uuid: () => "model-" + String(++n).padStart(3, "0") });
  env.scanned = root => db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES (?, 1, 2, 'ok')").run(root);
  return env;
}

// A file as the scanner reports it: fingerprint fp, its objects.
const extractOf = objects => extractFromWindow(gcodeFile({ objects: objects.map(o => [o, 1]) }), null, { wholeFile: true });
function write(db, { root = "r", rel, fp, size = 100, objects = [] }) {
  const name = rel.split("/").pop();
  return idx.writeFile(db, { rootId: root, relPath: rel, name, ext: "gcode", role: "sliced", size, mtimeMs: 5, quickFp: fp, metaVersion: 2, extract: extractOf(objects) }, { now: 1 });
}
const hash = (db, id, f, sha) => idx.setHash(db, { id, sha256: sha, md5: "md5-" + sha.slice(0, 4), expect: { size: f.size || 100, mtime_ms: 5, quick_fp: f.fp }, now: 2 });

const BEARDIE = [
  { rel: "Beardie.gcode", fp: "fpA", objects: ["Beardie.stl"], sha: SHA("a") },
  { rel: "4x Beardie.gcode", fp: "fpB", objects: ["Beardie.stl"], sha: SHA("b") },
  { rel: "lizard thing.gcode", fp: "fpC", objects: ["Gecko.stl"], sha: SHA("c") },
];

const modelOf = (db, rel) => (db.prepare("SELECT m.uuid FROM files f JOIN models m ON m.id = f.model_id WHERE f.rel_path = ? AND f.entry_path = ''").get(rel) || {}).uuid || null;
const groups = db => {
  const out = new Map();
  for (const r of db.prepare("SELECT m.uuid, f.rel_path FROM files f JOIN models m ON m.id = f.model_id WHERE f.entry_path = '' ORDER BY f.rel_path").all()) out.set(r.uuid, [...(out.get(r.uuid) || []), r.rel_path]);
  return [...out.entries()].map(([u, fs_]) => u + " = " + fs_.join(" + ")).sort();
};
const open = (db, kind) => db.prepare("SELECT subject_key FROM review_items WHERE kind = ? AND status = 'open'").all(kind).map(r => r.subject_key);
const models = db => db.prepare("SELECT count(*) AS n FROM models").get().n;

// The library before the rebuild: Beardie (two files) and a Decision putting
// "lizard thing" into it. hashed: which files had their full hash.
function before(t, hashed) {
  const env = setup(t);
  const { db } = env;
  const rows = BEARDIE.map(f => ({ ...f, id: write(db, f).id }));
  for (const f of rows) if (hashed.includes(f.rel)) hash(db, f.id, f, f.sha);
  env.scanned("r");
  env.group();
  const m = modelOf(db, "Beardie.gcode");
  assert.equal(modelOf(db, "4x Beardie.gcode"), m);
  const lizard = db.prepare("SELECT content_key FROM files WHERE rel_path = 'lizard thing.gcode'").get().content_key;
  const decision = recordDecision(db, { subject_type: "file", subject_key: lizard, relation: "member_of", object_type: "model", object_key: m, subject_hint: "r:lizard thing.gcode" });
  env.group();
  assert.equal(modelOf(db, "lizard thing.gcode"), m);
  // Models already empty before the rebuild (the Decision moved the lizard
  // out of its own one-file Model): only those may be reported empty.
  const emptyBefore = db.prepare("SELECT uuid FROM models WHERE id NOT IN (SELECT model_id FROM files WHERE model_id IS NOT NULL)").all().map(r => "empty:" + r.uuid);
  return { ...env, m, decision, rows, snapshot: groups(db), modelCount: models(db), emptyBefore };
}
// A normal derived rebuild, and the rescan that rediscovers every file —
// before any re-hash.
function rebuild(env, { files = BEARDIE } = {}) {
  env.store.rebuildDerived();
  const rows = files.map(f => ({ ...f, id: write(env.db, f).id }));
  env.scanned("r");
  env.group();
  return rows;
}
function assertSame(env, when) {
  const { db } = env;
  assert.deepEqual(groups(db), env.snapshot, when + ": the same Models with the same members");
  assert.equal(modelOf(db, "Beardie.gcode"), env.m, when + ": Beardie keeps its Model uuid");
  assert.equal(modelOf(db, "lizard thing.gcode"), env.m, when + ": the Decision still applies");
  assert.equal(models(db), env.modelCount, when + ": no Model created again");
  for (const k of ["file_changed", "decision_unmatched", "ambiguous_grouping"]) assert.deepEqual(open(db, k), [], when + ": no " + k);
  assert.deepEqual(open(db, "empty_model").filter(k => !env.emptyBefore.includes(k)), [], when + ": no wave of empty Models");
  assert.equal(db.prepare("SELECT superseded_by FROM decisions WHERE id = ?").get(env.decision).superseded_by, null);
}

for (const [label, hashed] of [
  ["after every file had its full hash", BEARDIE.map(f => f.rel)],
  ["before any file had a full hash", []],
  ["with a mixture of hashed and unhashed files", ["Beardie.gcode", "lizard thing.gcode"]],
]) {
  test(`a derived rebuild ${label}: same Models, same uuids, the Decision applies — before and after the re-hash`, t => {
    const env = before(t, hashed);
    const cacheBefore = env.db.prepare("SELECT count(*) AS n FROM identity_cache").get().n;
    assert.equal(cacheBefore, hashed.length);
    const rows = rebuild(env);
    assert.equal(env.db.prepare("SELECT count(*) AS n FROM identity_cache").get().n, cacheBefore, "the rebuild kept the identity cache");
    for (const f of rows) {
      const r = env.db.prepare("SELECT content_key, sha256 FROM files WHERE id = ?").get(f.id);
      assert.equal(r.sha256, null, "nothing is verified yet");
      assert.equal(r.content_key, hashed.includes(f.rel) ? f.sha : "q:" + f.fp, "a hashed file's key is restored, an unhashed one keeps its quick key");
    }
    assertSame(env, "right after the rescan");
    for (const f of rows) assert.equal(hash(env.db, f.id, f, f.sha).ok, true);
    env.group();
    assertSame(env, "after the re-hash");
  });
}

test("a unique fingerprint restores the verified key; the full hash confirms it", t => {
  const env = setup(t);
  const a = write(env.db, BEARDIE[0]);
  hash(env.db, a.id, BEARDIE[0], BEARDIE[0].sha);
  env.store.rebuildDerived();
  const again = write(env.db, BEARDIE[0]);
  assert.equal(again.recovered, true);
  assert.equal(again.contentKey, BEARDIE[0].sha);
  const row = env.db.prepare("SELECT sha256, md5 FROM files WHERE id = ?").get(again.id);
  assert.equal(row.sha256, null, "restored, not verified");
  assert.equal(row.md5, "md5-aaaa", "the verified MD5 comes with it (plate lineage)");
  assert.deepEqual({ ...hash(env.db, again.id, BEARDIE[0], BEARDIE[0].sha) }, { ok: true, rekeyed: 0, identity: "confirmed" });
});

test("a fingerprint two verified contents share restores nothing, and is reported", t => {
  const env = setup(t);
  // Two different files that happen to share fingerprint and size.
  const x = { rel: "x.gcode", fp: "same", objects: ["X.stl"] }, y = { rel: "y.gcode", fp: "same", objects: ["Y.stl"] };
  hash(env.db, write(env.db, x).id, x, SHA("x"));
  hash(env.db, write(env.db, y).id, y, SHA("y"));
  assert.deepEqual(idx.ambiguousIdentities(env.db).map(a => [a.quickFp, a.keys.length]), [["same", 2]]);
  env.store.rebuildDerived();
  const again = write(env.db, x);
  assert.equal(again.recovered, false);
  assert.equal(again.contentKey, "q:same", "the quick key, until its own hash decides");
});

test("an ambiguous fingerprint raises no false file_changed or decision_unmatched while its hash is pending", t => {
  const env = setup(t);
  const x = { rel: "x.gcode", fp: "same", objects: ["X.stl"] }, y = { rel: "y.gcode", fp: "same", objects: ["Y.stl"] };
  const xi = write(env.db, x).id; hash(env.db, xi, x, SHA("x"));
  hash(env.db, write(env.db, y).id, y, SHA("y"));
  env.scanned("r"); env.group();
  recordDecision(env.db, { subject_type: "file", subject_key: SHA("x"), relation: "member_of", object_type: "model", object_key: modelOf(env.db, "x.gcode"), subject_hint: "r:x.gcode" });
  env.store.rebuildDerived();
  const rows = [x, y].map(f => ({ ...f, id: write(env.db, f).id }));
  env.scanned("r"); env.group();
  assert.deepEqual(open(env.db, "file_changed"), []);
  assert.deepEqual(open(env.db, "decision_unmatched"), []);
  hash(env.db, rows[0].id, x, SHA("x")); hash(env.db, rows[1].id, y, SHA("y"));
  env.group();
  assert.deepEqual(open(env.db, "file_changed"), [], "verified: it is the same content after all");
});

test("a cached fingerprint the full hash contradicts: the file takes its verified key; the Decision is kept, not transferred", t => {
  const env = before(t, BEARDIE.map(f => f.rel));
  const { db } = env;
  // While unseen, "lizard thing" was replaced by different content with the
  // same fingerprint and size (the cache cannot know).
  rebuild(env);
  const lizard = db.prepare("SELECT id FROM files WHERE rel_path = 'lizard thing.gcode'").get().id;
  assert.equal(modelOf(db, "lizard thing.gcode"), env.m, "provisionally, the restored key");
  const res = hash(db, lizard, BEARDIE[2], SHA("d"));
  assert.equal(res.identity, "contradicted");
  assert.equal(db.prepare("SELECT content_key, sha256 FROM files WHERE id = ?").get(lizard).content_key, SHA("d"));
  env.group();
  assert.notEqual(modelOf(db, "lizard thing.gcode"), env.m, "the Decision did not follow the file to new content");
  const d = db.prepare("SELECT subject_key, superseded_by FROM decisions WHERE id = ?").get(env.decision);
  assert.deepEqual({ ...d }, { subject_key: SHA("c"), superseded_by: null }, "the Decision is preserved as it was");
  assert.deepEqual(open(db, "file_changed"), ["changed:" + env.decision], "Needs attention: the file changed under the Decision");
  assert.deepEqual(db.prepare("SELECT sha256 FROM identity_cache WHERE quick_fp = 'fpC'").all().map(r => r.sha256), [SHA("d")], "the stale entry is corrected");
  assert.equal(db.prepare("SELECT count(*) AS n FROM content_aliases WHERE content_key = ?").get(SHA("c")).n, 0, "the quick key no longer means the old content");
  assert.equal(db.prepare("SELECT count(*) AS n FROM claims WHERE subject_key = ? AND relation = 'targets_printer'").get(SHA("d")).n > 0, true, "the file's own derived Claims moved with it");
});

test("a stale cache entry restores provisionally and is dropped by the full hash", t => {
  const env = setup(t);
  const old = { rel: "old.gcode", fp: "fpS", objects: ["Old.stl"] };
  const o = write(env.db, old); hash(env.db, o.id, old, SHA("o"));
  env.db.prepare("DELETE FROM files WHERE id = ?").run(o.id);       // gone from the index
  const fresh = { rel: "fresh.gcode", fp: "fpS", objects: ["Fresh.stl"] };
  const f = write(env.db, fresh);
  assert.equal(f.contentKey, SHA("o"), "the cache cannot know yet");
  hash(env.db, f.id, fresh, SHA("f"));
  assert.deepEqual(env.db.prepare("SELECT sha256 FROM identity_cache WHERE quick_fp = 'fpS'").all().map(r => r.sha256), [SHA("f")]);
  assert.deepEqual(idx.ambiguousIdentities(env.db), []);
});

test("after a rebuild, a file moved but unchanged keeps its Model and Decision", t => {
  const env = before(t, BEARDIE.map(f => f.rel));
  const moved = BEARDIE.map(f => (f.rel === "lizard thing.gcode" ? { ...f, rel: "archive/lizard renamed.gcode" } : f));
  rebuild(env, { files: moved });
  assert.equal(modelOf(env.db, "archive/lizard renamed.gcode"), env.m);
  assert.deepEqual(open(env.db, "decision_unmatched"), []);
  assert.deepEqual(open(env.db, "file_changed"), []);
  assert.equal(env.db.prepare("SELECT subject_hint FROM decisions WHERE id = ?").get(env.decision).subject_hint, "r:archive/lizard renamed.gcode");
});

test("after a rebuild, a file moved and modified is never guessed: decision_unmatched once its hash is in", t => {
  const env = before(t, BEARDIE.map(f => f.rel));
  const changed = BEARDIE.map(f => (f.rel === "lizard thing.gcode" ? { ...f, rel: "archive/lizard v2.gcode", fp: "fpC2", objects: ["Gecko v2.stl"] } : f));
  const rows = rebuild(env, { files: changed });
  assert.deepEqual(open(env.db, "decision_unmatched"), [], "not while its identity is pending");
  const v2 = rows.find(r => r.fp === "fpC2");
  hash(env.db, v2.id, v2, SHA("e"));
  env.group();
  assert.deepEqual(open(env.db, "decision_unmatched"), ["decision:" + env.decision]);
  assert.notEqual(modelOf(env.db, "archive/lizard v2.gcode"), env.m);
});

test("an explicit identity reset forgets nothing authored: Models and Decisions re-attach after the re-hash", t => {
  const env = before(t, BEARDIE.map(f => f.rel));
  assert.ok(env.store.resetIdentityCache().removed >= 3);
  const rows = rebuild(env);
  assert.equal(models(env.db) >= env.modelCount, true);
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM decisions WHERE superseded_by IS NULL").get().n, 1, "the Decision stays");
  assert.deepEqual(open(env.db, "decision_unmatched"), [], "nothing is unmatched while identities are pending");
  for (const f of rows) hash(env.db, f.id, f, f.sha);
  env.group();
  assert.equal(modelOf(env.db, "Beardie.gcode"), env.m, "the original Model is found again through its anchors");
  assert.equal(modelOf(env.db, "lizard thing.gcode"), env.m, "and the Decision applies again");
});

// End to end, as the live failure happened: the real service, scanner and
// worker; files fully hashed; a Decision; "Rebuild index"; the state right
// after the rescan (hashing held off), then after the re-hash.
test("service: a full rebuild keeps Models, uuids and the Decision before the re-hash, and after it", async t => {
  const { createLibraryService, GCODE_ROOT } = require("../../library/LibraryService");
  const { createNetFs } = require("../../netfs/NetFs");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ident-svc-"));
  const gcode = path.join(base, "gcode");
  fs.mkdirSync(gcode);
  fs.writeFileSync(path.join(gcode, "Beardie.gcode"), gcodeFile({ objects: [["Beardie.stl", 1]], bodyBytes: 2000 }));
  fs.writeFileSync(path.join(gcode, "4x Beardie.gcode"), gcodeFile({ objects: [["Beardie.stl", 4]], bodyBytes: 3000 }));
  fs.writeFileSync(path.join(gcode, "lizard thing.gcode"), gcodeFile({ objects: [["Gecko.stl", 1]], bodyBytes: 4000 }));
  const nf = createNetFs({ log: quiet, opTimeoutMs: 5000, probeEveryMs: 60000 });
  const lib = createLibraryService({ baseDir: base, getGcodeFolder: () => gcode, log: quiet, netfs: nf, scanBudget: 1 << 30, workerOptions: { log: quiet } });
  t.after(async () => { await lib.stop(); await nf.stop(); });
  lib.start();
  const db = () => lib._store.db;
  const until = async (cond, what) => {
    for (let i = 0; i < 800; i++) { await lib._idle(); if (cond()) return; await new Promise(r => setTimeout(r, 25)); }
    throw new Error("timed out: " + what);
  };
  const unhashed = () => db().prepare("SELECT count(*) AS n FROM files WHERE entry_path = '' AND sha256 IS NULL").get().n;
  const filesN = () => db().prepare("SELECT count(*) AS n FROM files WHERE entry_path = ''").get().n;
  await until(() => filesN() === 3 && unhashed() === 0 && modelOf(db(), "Beardie.gcode"), "first scan and hash");
  await lib._group();
  const m = modelOf(db(), "Beardie.gcode");
  assert.equal(modelOf(db(), "4x Beardie.gcode"), m);
  const lizardKey = db().prepare("SELECT content_key FROM files WHERE rel_path = 'lizard thing.gcode'").get().content_key;
  const decision = recordDecision(db(), { subject_type: "file", subject_key: lizardKey, relation: "member_of", object_type: "model", object_key: m, subject_hint: GCODE_ROOT + ":lizard thing.gcode" });
  await lib._group();
  const snapshot = groups(db()), count = models(db());
  assert.equal(modelOf(db(), "lizard thing.gcode"), m);

  db().prepare("UPDATE roots SET full_hash = 'off'").run();     // hold the re-hash back
  const t0 = Date.now();
  await lib.rebuildDerived();
  await until(() => { const s = lib.scanReport().scans[GCODE_ROOT]; return s && s.finishedAt >= t0 && filesN() === 3; }, "rescan");
  await lib._group();
  assert.equal(unhashed(), 3, "nothing re-hashed yet");
  assert.deepEqual(groups(db()), snapshot, "right after the rescan: the same Models, the same members");
  assert.equal(models(db()), count, "no Model created again");
  assert.equal(modelOf(db(), "lizard thing.gcode"), m, "the Decision applies");
  for (const k of ["file_changed", "decision_unmatched", "ambiguous_grouping"]) assert.deepEqual(open(db(), k), [], k);

  db().prepare("UPDATE roots SET full_hash = 'idle'").run();
  await lib.rescan(GCODE_ROOT);
  await until(() => unhashed() === 0, "re-hash");
  await lib._group();
  assert.deepEqual(groups(db()), snapshot, "after the re-hash: unchanged");
  assert.equal(db().prepare("SELECT superseded_by FROM decisions WHERE id = ?").get(decision).superseded_by, null);
  for (const k of ["file_changed", "decision_unmatched"]) assert.deepEqual(open(db(), k), [], k);
});
