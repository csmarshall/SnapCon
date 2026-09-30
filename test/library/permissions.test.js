// test/library/permissions.test.js — Library capabilities (§11).
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const schema = require("../../library/schema");
const { CAPABILITIES, seedRoleDefaults, createAuthorizer } = require("../../library/permissions");

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(schema.AUTHORED_SQL);
  seedRoleDefaults(d);
  return d;
}
const view = { id: "u-v", role: "view", groupIds: [] };
const regular = { id: "u-r", role: "regular", groupIds: ["grp_a"] };
const admin = { id: "u-a", role: "admin", groupIds: [] };

test("role defaults: view reads, regular edits, admin also manages locations and backups", () => {
  const { can } = createAuthorizer(db());
  assert.equal(can(view, "library.view"), true);
  assert.equal(can(view, "library.edit.grouping"), false);
  assert.equal(can(regular, "library.edit.cover"), true, "D11: Regular may set covers");
  assert.equal(can(regular, "library.sources.manage"), false);
  assert.equal(can(admin, "library.sources.manage"), true);
  assert.equal(can(admin, "library.backup"), true);
  assert.equal(can(admin, "library.files.delete"), false, "D2: physical deletion is granted to no role yet");
});

test("with users switched off everyone is the implicit admin, as elsewhere in SnapCon", () => {
  const { can } = createAuthorizer(db());
  for (const cap of CAPABILITIES) assert.equal(can({ role: "admin", implicit: true }, cap), true);
});

test("no user, or an unknown capability, is never allowed", () => {
  const { can } = createAuthorizer(db());
  assert.equal(can(null, "library.view"), false);
  assert.throws(() => can(admin, "library.everything"), /unknown library capability/);
});

test("finer grants are rows, not code: user beats group beats role, and a group deny wins", () => {
  const d = db();
  const auth = createAuthorizer(d);
  d.prepare("INSERT INTO permission_grants VALUES ('group', 'grp_a', 'library.edit.cover', 0)").run();
  auth.invalidate();
  assert.equal(auth.can(regular, "library.edit.cover"), false, "the group deny overrides the role default");
  d.prepare("INSERT INTO permission_grants VALUES ('user', 'u-r', 'library.edit.cover', 1)").run();
  auth.invalidate();
  assert.equal(auth.can(regular, "library.edit.cover"), true, "a user row is the most specific");
  d.prepare("INSERT INTO permission_grants VALUES ('user', 'u-v', 'library.sources.manage', 1)").run();
  auth.invalidate();
  assert.equal(auth.can(view, "library.sources.manage"), true);
});

test("revoking a role default with allow=0 survives re-seeding on the next start", () => {
  const d = db();
  d.prepare("UPDATE permission_grants SET allow = 0 WHERE subject_type='role' AND subject_id='regular' AND capability='library.hide'").run();
  seedRoleDefaults(d);   // what every start does
  assert.equal(createAuthorizer(d).can(regular, "library.hide"), false);
});
