// test/library/store.test.js — the Library database: first run, rebuild,
// corruption, versioning, migration and backups (docs/library-design.md §4.6,
// §14, and CLAUDE.md §7: never silently destroy recoverable data).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createLibraryStore, runBackup, listBackups } = require("../../library/LibraryStore");
const schema = require("../../library/schema");

const quiet = { log() {}, warn() {}, error() {} };
const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-lib-"));
const open = (baseDir, extra = {}) => createLibraryStore({ baseDir, log: quiet, ...extra }).open();
let clock = Date.parse("2026-10-01T03:00:00Z");
const tick = () => (clock += 1000);

// One row in every authored table, and derived rows that point at them.
function seed(db) {
  const now = Date.now();
  db.exec(`
    INSERT INTO roots (id, name, path, created_at, status) VALUES ('nas', 'NAS', '/models', ${now}, 'ok');
    INSERT INTO models (uuid, origin, name, created_at, updated_at) VALUES ('m-1', 'auto', 'Beardie', ${now}, ${now});
    INSERT INTO model_anchors (model_id, content_key, last_seen) VALUES (1, 'q:abc', ${now});
    INSERT INTO decisions (subject_type, subject_key, relation, object_type, object_key, created_at) VALUES ('file', 'q:abc', 'member_of', 'model', 'm-1', ${now});
    INSERT INTO prints (content_key, printer_id, remote_name, source, link_method, link_confidence) VALUES ('q:abc', 'p1', 'b.gcode', 'library', 'snapcon_variant', 'exact');
    INSERT INTO review_items (kind, subject_key, created_at, updated_at, print_id) VALUES ('suggested_match', 'rk', ${now}, ${now}, 1);
    INSERT INTO tags (name) VALUES ('lizard');
    INSERT INTO model_tags (model_id, tag_id) VALUES (1, 1);
    INSERT INTO collections (uuid, name) VALUES ('c-1', 'Best sellers');
    INSERT INTO collection_models (collection_id, model_id) VALUES (1, 1);
    INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, content_key, first_seen, last_seen, model_id, model_decision_id)
      VALUES ('nas', 'a.gcode', 'a.gcode', 'gcode', 'sliced', 1, 1, 'abc', 'q:abc', 1, 1, 1, 1);
    INSERT INTO files (root_id, rel_path, entry_path, container_id, name, ext, role, size, mtime_ms, quick_fp, content_key, first_seen, last_seen)
      VALUES ('nas', 'p.3mf', 'Auxiliaries/1.webp', 1, '1.webp', 'webp', 'image', 1, 1, 'def', 'q:def', 1, 1);
    INSERT INTO variants (file_id, printer_family) VALUES (1, 'snapmaker-u1');
    INSERT INTO claims (claim_key, subject_type, subject_key, relation, object_type, object_key, method, confidence, state, groups, evidence_json, rule_version, created_at, updated_at)
      VALUES ('ck', 'file', 'q:abc', 'member_of', 'model', 'm-1', 'x', 'high', 'applied', 'filename', '[]', 1, 1, 1);
    INSERT INTO model_stats (model_id, print_count) VALUES (1, 1);
    INSERT INTO model_families (model_id, printer_family, variant_count) VALUES (1, 'snapmaker-u1', 1);
    INSERT INTO model_fts (rowid, name) VALUES (1, 'Beardie');
  `);
}
const counts = (db, tables) => Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));

test("a first run creates the schema at the current version, with role grants seeded", () => {
  const s = open(tmpBase());
  assert.equal(s.available, true);
  assert.equal(s.schemaVersion(), schema.SCHEMA_VERSION);
  assert.ok(s.db.prepare("SELECT count(*) AS n FROM permission_grants WHERE subject_type='role'").get().n > 0);
  assert.equal(s.recovery, null);
  s.close();
});

test("reopening an existing database changes nothing", () => {
  const base = tmpBase();
  const a = open(base); seed(a.db); const before = counts(a.db, schema.AUTHORED_TABLES); a.close();
  const b = open(base);
  assert.deepEqual(counts(b.db, schema.AUTHORED_TABLES), before);
  b.close();
});

test("rebuildDerived empties every derived table and leaves every authored row exactly as it was (P4)", () => {
  const s = open(tmpBase());
  seed(s.db);
  const authoredBefore = schema.AUTHORED_TABLES.map(t => [t, s.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]);
  const res = s.rebuildDerived();
  assert.ok(res.ms >= 0);
  for (const [t, rows] of authoredBefore) assert.deepEqual(s.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(), rows, `${t} changed`);
  for (const t of schema.DERIVED_TABLES) assert.equal(s.db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} not emptied`);
  // The rebuilt tables are the real ones: indexes back, foreign keys on.
  assert.ok(s.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='files_container'").get());
  assert.equal(s.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.throws(() => s.db.prepare("INSERT INTO variants (file_id) VALUES (999)").run(), /FOREIGN KEY/);
  s.close();
});

test("a corrupt database is quarantined and the newest good backup restored", () => {
  const base = tmpBase();
  const a = open(base, { now: tick }); seed(a.db); a.close();
  runBackup({ DatabaseSync, dbPath: path.join(base, "library-data", "library.db"), backupsDir: path.join(base, "library-data", "backups"), reason: "nightly", now: tick });
  fs.writeFileSync(path.join(base, "library-data", "library.db"), "this is not a sqlite database, it is garbage ".repeat(200));
  const b = open(base, { now: tick });
  assert.equal(b.available, true);
  assert.ok(b.recovery && b.recovery.restoredFrom, "it must say it restored");
  assert.equal(b.db.prepare("SELECT name FROM models").get().name, "Beardie", "the backup's data is back");
  const kept = fs.readdirSync(path.join(base, "library-data")).filter(f => f.startsWith("library.db.corrupt-"));
  assert.ok(kept.length >= 1, "the corrupt file is kept, never deleted");
  b.close();
});

test("a corrupt database with no backup starts empty, says so, and keeps the corrupt file", () => {
  const base = tmpBase();
  fs.mkdirSync(path.join(base, "library-data"), { recursive: true });
  fs.writeFileSync(path.join(base, "library-data", "library.db"), "garbage ".repeat(500));
  const s = open(base);
  assert.equal(s.available, true);
  assert.equal(s.recovery.fresh, true, "never recreated silently");
  assert.ok(fs.readdirSync(path.join(base, "library-data")).some(f => f.startsWith("library.db.corrupt-")));
  s.close();
});

test("a database that cannot be opened for another reason is left untouched", () => {
  const base = tmpBase();
  fs.mkdirSync(path.join(base, "library-data", "library.db"), { recursive: true });   // a directory where the file should be
  const s = open(base);
  assert.equal(s.available, false);
  assert.ok(fs.statSync(path.join(base, "library-data", "library.db")).isDirectory(), "nothing was moved or replaced");
  assert.equal(fs.readdirSync(path.join(base, "library-data")).filter(f => f.includes("corrupt")).length, 0);
});

test("a database from a newer SnapCon is refused and left byte-for-byte untouched", () => {
  const base = tmpBase();
  const a = open(base); a.db.exec(`PRAGMA user_version = ${schema.SCHEMA_VERSION + 5}`); a.close();
  const file = path.join(base, "library-data", "library.db");
  const before = fs.readFileSync(file);
  const s = open(base);
  assert.equal(s.available, false);
  assert.match(s.reason, /newer/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("an unversioned database that already has tables is not adopted", () => {
  const base = tmpBase();
  fs.mkdirSync(path.join(base, "library-data"));
  const d = new DatabaseSync(path.join(base, "library-data", "library.db")); d.exec("CREATE TABLE something_else (x)"); d.close();
  const s = open(base);
  assert.equal(s.available, false);
});

test("without node:sqlite the Library is unavailable, not a crash", () => {
  const s = open(tmpBase(), { sqlite: null });
  assert.equal(s.available, false);
  assert.match(s.reason, /node:sqlite/);
});

test("an upgrade takes a pre-migration snapshot, then migrates inside a transaction", () => {
  const base = tmpBase();
  const v1 = open(base, { now: tick }); seed(v1.db); v1.close();
  const v2schema = { ...schema, SCHEMA_VERSION: 2 };
  const migrations = { 2: db => db.exec("ALTER TABLE models ADD COLUMN nickname TEXT") };
  const s = open(base, { now: tick, schema: v2schema, migrations });
  assert.equal(s.available, true);
  assert.equal(s.schemaVersion(), 2);
  assert.ok(s.db.prepare("SELECT nickname FROM models").get() !== undefined);
  assert.equal(s.db.prepare("SELECT name FROM models").get().name, "Beardie");
  const snap = listBackups(path.join(base, "library-data", "backups")).filter(b => b.reason === "pre-migration");
  assert.equal(snap.length, 1, "one snapshot before the upgrade");
  const old = new DatabaseSync(path.join(base, "library-data", "backups", snap[0].file));
  assert.equal(old.prepare("PRAGMA user_version").get().user_version, 1, "the snapshot is the pre-upgrade database");
  old.close(); s.close();
});

test("a failed migration rolls back and leaves the Library unavailable at the old version", () => {
  const base = tmpBase();
  const v1 = open(base, { now: tick }); seed(v1.db); v1.close();
  const s = open(base, { now: tick, schema: { ...schema, SCHEMA_VERSION: 2 }, migrations: { 2: db => { db.exec("ALTER TABLE models ADD COLUMN x TEXT"); throw new Error("boom"); } } });
  assert.equal(s.available, false);
  const again = open(base);
  assert.equal(again.schemaVersion(), 1);
  assert.throws(() => again.db.prepare("SELECT x FROM models").get(), /no such column/);
  again.close();
});

test("backups: VACUUM INTO copies, seven routine ones kept, pre-migration snapshots never rotated", () => {
  const base = tmpBase();
  const s = open(base); seed(s.db); s.close();
  const dbPath = path.join(base, "library-data", "library.db"), backupsDir = path.join(base, "library-data", "backups");
  runBackup({ DatabaseSync, dbPath, backupsDir, reason: "pre-migration", now: tick });
  for (let i = 0; i < 10; i++) runBackup({ DatabaseSync, dbPath, backupsDir, reason: "nightly", now: tick });
  const all = listBackups(backupsDir);
  assert.equal(all.filter(b => b.reason === "nightly").length, 7);
  assert.equal(all.filter(b => b.reason === "pre-migration").length, 1);
  assert.equal(fs.readdirSync(backupsDir).filter(f => f.endsWith(".partial")).length, 0);
  const copy = new DatabaseSync(path.join(backupsDir, all[0].file));
  assert.equal(copy.prepare("SELECT name FROM models").get().name, "Beardie", "a backup is a complete, openable database");
  copy.close();
});

test("a damaged database is never backed up over the good copies", () => {
  const base = tmpBase();
  const s = open(base); seed(s.db);
  for (let i = 0; i < 200; i++) s.db.prepare("INSERT INTO tags (name) VALUES (?)").run("tag-" + i + "-".repeat(200));
  s.close();
  const dbPath = path.join(base, "library-data", "library.db"), backupsDir = path.join(base, "library-data", "backups");
  runBackup({ DatabaseSync, dbPath, backupsDir, reason: "nightly", now: tick });
  // Overwrite a page in the middle of the file.
  const buf = fs.readFileSync(dbPath);
  buf.fill(0xa5, Math.floor(buf.length / 2), Math.floor(buf.length / 2) + 4096);
  fs.writeFileSync(dbPath, buf);
  assert.throws(() => runBackup({ DatabaseSync, dbPath, backupsDir, reason: "nightly", now: tick }), e => /integrity|malformed|corrupt/i.test(e.message));
  assert.equal(listBackups(backupsDir).length, 1, "the one good backup is still the only one");
});
