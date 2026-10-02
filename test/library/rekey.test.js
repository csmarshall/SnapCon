// test/library/rekey.test.js — what happens to keys when a file's full hash
// arrives (§4.5): Claims follow, authored rows are re-keyed in place, and a
// Decision still held on the quick key (because an identical copy is not
// hashed yet) keeps applying through content_aliases.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibraryStore } = require("../../library/LibraryStore");
const idx = require("../../library/indexStore");
const { extractFromWindow } = require("../../library/gcodeExtract");
const { gcodeFile } = require("./helpers/gcode");

const quiet = { log() {}, warn() {}, error() {} };
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-rekey-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  store.roots.insert({ id: "r", name: "r", path: base, grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
  return store.db;
}
// The 5M Pro file: medium / suggested, so a Decision is what decides it.
const ex = () => extractFromWindow(gcodeFile({ generic: true, settingsId: "Flashforge Adventurer 5M Pro 0.4 Nozzle" }), null, { wholeFile: true });
const write = (db, rel) => idx.writeFile(db, { rootId: "r", relPath: rel, name: rel, ext: "gcode", role: "sliced", size: 100, mtimeMs: 5, quickFp: "fp1", metaVersion: 2, extract: ex() }, { now: 1 });
const expect = { size: 100, mtime_ms: 5, quick_fp: "fp1" };

test("a Decision on the quick key still applies to the copy that was hashed first", t => {
  const db = setup(t);
  const a = write(db, "a.gcode"); write(db, "b.gcode");
  db.prepare(`INSERT INTO decisions (subject_type, subject_key, relation, polarity, object_type, object_key, value_json, created_at)
    VALUES ('variant', 'q:fp1', 'targets_printer', 'affirm', 'printer_family', 'flashforge-5m', '{"printer_family":"flashforge-5m"}', 1)`).run();
  assert.equal(idx.setHash(db, { id: a.id, sha256: "s".repeat(64), md5: "m", expect, now: 2 }).ok, true);
  assert.equal(db.prepare("SELECT subject_key FROM decisions").get().subject_key, "q:fp1", "b.gcode still has the quick key, so the Decision stays on it");
  assert.equal(idx.resolvePrinter(db, "s".repeat(64)).family, "flashforge-5m", "found through content_aliases");
});

test("when the last copy is hashed, authored rows and references to Claims are re-keyed", t => {
  const db = setup(t);
  const a = write(db, "a.gcode");
  const claimKey = db.prepare("SELECT claim_key FROM claims WHERE subject_key = 'q:fp1'").get().claim_key;
  db.prepare(`INSERT INTO decisions (subject_type, subject_key, relation, object_type, object_key, from_claim_key, created_at)
    VALUES ('variant', 'q:fp1#2', 'sliced_from', 'project', 'q:fp1#1', ?, 1)`).run(claimKey);
  db.prepare(`INSERT INTO review_items (kind, subject_key, claim_key, content_key, created_at, updated_at)
    VALUES ('unknown_printer', 'unknown_printer:q:fp1', ?, 'q:fp1', 1, 1)`).run(claimKey);
  db.prepare("INSERT INTO models (uuid, origin, name, created_at, updated_at) VALUES ('m', 'auto', 'M', 1, 1)").run();
  db.prepare("INSERT INTO model_anchors (model_id, content_key, last_seen) VALUES (1, 'q:fp1', 1), (1, ?, 1)").run("s".repeat(64));
  const sha = "s".repeat(64);
  idx.setHash(db, { id: a.id, sha256: sha, md5: "m", expect, now: 2 });
  const d = db.prepare("SELECT subject_key, object_key, from_claim_key FROM decisions").get();
  assert.equal(d.subject_key, sha + "#2");
  assert.equal(d.object_key, sha + "#1", "a ck#plate object key is re-keyed too");
  const newClaim = db.prepare("SELECT claim_key FROM claims WHERE subject_key = ?").get(sha).claim_key;
  assert.equal(d.from_claim_key, newClaim);
  const ri = db.prepare("SELECT subject_key, claim_key, content_key FROM review_items").get();
  assert.deepEqual({ ...ri }, { subject_key: "unknown_printer:" + sha, claim_key: newClaim, content_key: sha }, "a dismissed item keeps matching");
  assert.deepEqual(db.prepare("SELECT content_key FROM model_anchors").all().map(r => r.content_key), [sha], "no anchor left on the old key");
});

test("a file that changed while it was being hashed is not re-keyed", t => {
  const db = setup(t);
  const a = write(db, "a.gcode");
  assert.deepEqual(idx.setHash(db, { id: a.id, sha256: "s".repeat(64), md5: "m", expect: { ...expect, mtime_ms: 6 }, now: 2 }), { ok: false, reason: "changed" });
  assert.equal(db.prepare("SELECT content_key FROM files").get().content_key, "q:fp1");
});
