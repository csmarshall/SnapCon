// test/library/schema.test.js — the production schema is the specification's.
//
// library/schema.js must be docs/library-design.md §5, statement for
// statement. If one changes without the other, this fails.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const schema = require("../../library/schema");

const doc = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "library-design.md"), "utf8");
const specSql = (() => {
  const at = doc.indexOf("```sql");
  assert.ok(at > 0, "the specification must contain its §5 SQL block");
  return doc.slice(at + 6, doc.indexOf("```", at + 6));
})();

// Statements, with comments and whitespace normalised away.
const statements = sql => sql.replace(/--[^\n]*/g, "").split(";").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean).sort();

test("library/schema.js is the specification's SQL, statement for statement", () => {
  assert.deepEqual(statements(schema.AUTHORED_SQL + ";" + schema.IDENTITY_SQL + ";" + schema.DERIVED_SQL), statements(specSql));
});

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema.AUTHORED_SQL);
  db.exec(schema.IDENTITY_SQL);
  db.exec(schema.DERIVED_SQL);
  return db;
}

test("it creates exactly the authored and derived tables it lists", () => {
  const db = freshDb();
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'model_fts_%'").all().map(r => r.name).sort();
  assert.deepEqual(tables, [...schema.AUTHORED_TABLES, ...schema.IDENTITY_TABLES, ...schema.DERIVED_TABLES].sort());
});

test("no authored table has a foreign key into a derived table (§4.6 rule 1)", () => {
  const db = freshDb();
  const bad = [];
  for (const t of schema.AUTHORED_TABLES) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all()) if (schema.DERIVED_TABLES.includes(fk.table)) bad.push(`${t} -> ${fk.table}`);
  }
  assert.deepEqual(bad, []);
});

test("the M0-required indexes exist (P1, P3)", () => {
  const db = freshDb();
  const idx = db.prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type='index'").all();
  const has = (name, tbl) => idx.some(i => i.name === name && i.tbl_name === tbl);
  assert.ok(has("files_container", "files"), "P1: without it, deleting files scans the table once per row");
  assert.ok(has("models_grid", "models"), "P3: keyset paging of the grid");
  assert.ok(has("model_families_family", "model_families"), "P3: printer filter and facets");
});

test("the derived drop order drops every child before its parent", () => {
  const db = freshDb();
  const pos = t => schema.DERIVED_TABLES.indexOf(t);
  for (const child of schema.DERIVED_TABLES) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${child})`).all()) {
      if (fk.table !== child && schema.DERIVED_TABLES.includes(fk.table)) {
        assert.ok(pos(child) < pos(fk.table), `${child} must be dropped before ${fk.table}`);
      }
    }
  }
});

test("the identity cache is neither authored nor derived: a rebuild never drops it, and it references nothing", () => {
  const db = freshDb();
  for (const t of schema.IDENTITY_TABLES) {
    assert.ok(!schema.DERIVED_TABLES.includes(t) && !schema.AUTHORED_TABLES.includes(t), t);
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], t + " has no foreign keys");
  }
});
