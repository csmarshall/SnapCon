// test/archivePush.test.js — a file pushed from a slicer is kept, not just forwarded.
//
// /api/notify-load stages a pushed file in a temp dir that is deleted once the
// printer has it. archivePush() writes one extra, permanent copy into the G-code
// folder so the sliced file (and the settings the slicer embeds in it) can be
// found later. Archiving must never overwrite, never escape its folder and never
// fail a print.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { archivePush, safeSegment, dateStamp, candidateNames } = require("../archivePush");

// Same shape as netfs: mkdir(p, {recursive}) and an exclusive writer that
// rejects with code EEXIST rather than overwrite.
const fsApi = {
  mkdir: async (p, o) => fs.mkdirSync(p, { recursive: !!(o && o.recursive) }),
  writeFileExclusive: async (p, data) => fs.writeFileSync(p, data, { flag: "wx" }),
  stat: async p => fs.statSync(p),
  readFile: async p => fs.readFileSync(p)
};
const NOON = new Date(2026, 9, 5, 12, 0, 0).getTime();   // 2026-10-05 local
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-archive-"));
const read = p => fs.readFileSync(p);

test("a pushed file is saved under Archive/<user>/<date>/<name>", async () => {
  const root = tmp();
  const bytes = Buffer.from("; layer_height = 0.16\nG1 X1\n");
  const r = await archivePush({ fsApi, root, userLabel: "Charles Marshall", name: "harper.gcode", bytes, now: NOON });
  assert.equal(r.status, "archived");
  assert.equal(r.path, path.join(root, "Charles_Marshall", "2026-10-05", "harper.gcode"));
  assert.deepEqual(read(r.path), bytes, "the copy is byte-identical, settings block included");
});

test("the same bytes pushed twice are kept once", async () => {
  const root = tmp();
  const bytes = Buffer.from("G1 X1\n");
  const a = await archivePush({ fsApi, root, userLabel: "Harper", name: "a.gcode", bytes, now: NOON });
  const b = await archivePush({ fsApi, root, userLabel: "Harper", name: "a.gcode", bytes, now: NOON });
  assert.equal(a.status, "archived");
  assert.equal(b.status, "duplicate");
  assert.equal(fs.readdirSync(path.dirname(a.path)).length, 1);
});

test("same name, different content: both are kept and neither is overwritten", async () => {
  const root = tmp();
  const one = Buffer.from("version one\n"), two = Buffer.from("version two\n");
  const a = await archivePush({ fsApi, root, userLabel: "Harper", name: "a.gcode", bytes: one, now: NOON });
  const b = await archivePush({ fsApi, root, userLabel: "Harper", name: "a.gcode", bytes: two, now: NOON });
  assert.equal(b.status, "archived");
  assert.notEqual(a.path, b.path);
  assert.deepEqual(read(a.path), one, "the first copy is untouched");
  assert.deepEqual(read(b.path), two);
  assert.match(path.basename(b.path), /^a-[0-9a-f]{8}\.gcode$/);
});

test("different users and different days get their own folders", async () => {
  const root = tmp();
  const bytes = Buffer.from("G1\n");
  const a = await archivePush({ fsApi, root, userLabel: "Charles", name: "a.gcode", bytes, now: NOON });
  const b = await archivePush({ fsApi, root, userLabel: "Harper", name: "a.gcode", bytes, now: NOON });
  const c = await archivePush({ fsApi, root, userLabel: "Charles", name: "a.gcode", bytes, now: NOON + 86400000 });
  assert.equal([a, b, c].filter(r => r.status === "archived").length, 3);
  assert.equal(new Set([a, b, c].map(r => path.dirname(r.path))).size, 3);
});

test("no logged-in user is filed under 'unknown'", async () => {
  const root = tmp();
  const r = await archivePush({ fsApi, root, userLabel: null, name: "a.gcode", bytes: Buffer.from("G1\n"), now: NOON });
  assert.match(r.path, /[\\/]unknown[\\/]/);
});

test("a hostile user label or file name cannot escape the archive folder", async () => {
  const root = tmp();
  const r = await archivePush({ fsApi, root, userLabel: "../../etc", name: "../../../evil.gcode", bytes: Buffer.from("G1\n"), now: NOON });
  assert.equal(r.status, "archived");
  const archiveRoot = root + path.sep;
  assert.ok(r.path.startsWith(archiveRoot), r.path + " must stay inside " + archiveRoot);
  assert.equal(path.basename(r.path), "evil.gcode", "only the base name of the file is used");
  assert.ok(!r.path.split(path.sep).includes(".."), "no path segment may be ..: " + r.path);
});

test("an empty push is reported, not written", async () => {
  const root = tmp();
  const r = await archivePush({ fsApi, root, userLabel: "x", name: "a.gcode", bytes: Buffer.alloc(0), now: NOON });
  assert.equal(r.status, "error");
  assert.equal(fs.readdirSync(root).length, 0);
});

test("a failing disk is reported and does not throw — a print is never blocked by the archive", async () => {
  const broken = { mkdir: async () => { throw new Error("share is down"); }, writeFileExclusive: async () => { throw new Error("nope"); } };
  const r = await archivePush({ fsApi: broken, root: tmp(), userLabel: "x", name: "a.gcode", bytes: Buffer.from("G1\n"), now: NOON });
  assert.equal(r.status, "error");
  assert.match(r.error, /share is down/);
});

test("helpers: safe segments, local date stamp, hash-suffixed name", () => {
  assert.equal(safeSegment("Charles Marshall", "x"), "Charles_Marshall");
  assert.equal(safeSegment("..", "x"), "_");
  assert.equal(safeSegment("", "x"), "x");
  assert.equal(dateStamp(NOON), "2026-10-05");
  const sha = crypto.createHash("sha256").update("a").digest("hex");
  assert.deepEqual(candidateNames("a.gcode.3mf", sha), ["a.gcode.3mf", "a.gcode-" + sha.slice(0, 8) + ".3mf"]);
});

test("server.js archives in the push route, honours the opt-out, and guards the call", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = src.slice(src.indexOf('app.post("/api/notify-load"'));
  const at = route.indexOf("archivePush(");
  assert.ok(at > 0, "the push route must call archivePush");
  assert.ok(route.lastIndexOf("CFG.archivePushes !== false", at) > 0, "behind the archivePushes opt-out");
  assert.ok(at < route.indexOf("uploadNotifiedFile(idx, { file: tmpFile"), "before the temp copy is handed off and deleted");
});
