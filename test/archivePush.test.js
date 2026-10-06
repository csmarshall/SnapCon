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

const { archivePush, safeSegment, safeFileName, dateStamp, candidateNames, replayRootFor } = require("../archivePush");

// Same shape as netfs: mkdir(p, {recursive}), an exclusive writer that rejects
// with code EEXIST rather than overwrite, exists() that is false only for "not
// there", rename, and readFile(p, maxBytes) that reads at most maxBytes.
const fsApi = {
  mkdir: async (p, o) => fs.mkdirSync(p, { recursive: !!(o && o.recursive) }),
  writeFileExclusive: async (p, data) => fs.writeFileSync(p, data, { flag: "wx" }),
  exists: async p => fs.existsSync(p),
  stat: async p => fs.statSync(p),
  rename: async (a, b) => fs.renameSync(a, b),
  readFile: async (p, maxBytes) => {
    const buf = fs.readFileSync(p);
    return maxBytes != null ? buf.subarray(0, maxBytes) : buf;
  }
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

test("helpers: safe segments, local date stamp, hash-suffixed names", () => {
  assert.equal(safeSegment("Charles Marshall", "x"), "Charles_Marshall");
  assert.equal(safeSegment("..", "x"), "_");
  assert.equal(safeSegment("", "x"), "x");
  assert.equal(dateStamp(NOON), "2026-10-05");
  const sha = crypto.createHash("sha256").update("a").digest("hex");
  assert.deepEqual(candidateNames("a.gcode.3mf", sha), ["a.gcode.3mf", "a.gcode-" + sha.slice(0, 8) + ".3mf", "a.gcode-" + sha + ".3mf"]);
});

test("user names in any script keep their own folders", () => {
  assert.equal(safeSegment("张三", "x"), "张三");
  assert.notEqual(safeSegment("张三", "x"), safeSegment("李四", "x"));
  assert.equal(safeSegment("Zoë Ångström", "x"), "Zoë_Ångström");
});

test("names Windows shares refuse are made safe: reserved device names, trailing dots, NTFS characters, length", () => {
  assert.equal(safeSegment("CON", "x"), "_CON");
  assert.equal(safeSegment("nul.txt", "x"), "_nul.txt");
  assert.equal(safeSegment("Charles.", "x"), "Charles");
  assert.equal(safeFileName("foo:bar*?.gcode"), "foo_bar_.gcode");
  assert.equal(safeFileName("CON.gcode"), "_CON.gcode");
  assert.equal(safeFileName(""), "upload.gcode");
  const long = safeFileName("a".repeat(400) + ".gcode.3mf");
  assert.ok(long.length <= 150, "capped, got " + long.length);
  assert.ok(long.endsWith(".3mf"), "the extension survives the cap: " + long);
});

test("a pushed name with characters a Windows share refuses is still archived", async () => {
  const root = tmp();
  const r = await archivePush({ fsApi, root, userLabel: "x", name: "plate 1: final?.gcode", bytes: Buffer.from("G1\n"), now: NOON });
  assert.equal(r.status, "archived");
  assert.equal(path.basename(r.path), "plate_1_final_.gcode");
});

test("when the plain and short-hash names both hold other files, the full-hash name is used", async () => {
  const root = tmp();
  const bytes = Buffer.from("the real one\n");
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(root, "x", "2026-10-05");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.gcode"), "something else\n");
  fs.writeFileSync(path.join(dir, "a-" + sha.slice(0, 8) + ".gcode"), "a stale partial cop");
  const r = await archivePush({ fsApi, root, userLabel: "x", name: "a.gcode", bytes, now: NOON });
  assert.equal(r.status, "archived");
  assert.equal(path.basename(r.path), "a-" + sha + ".gcode");
  assert.deepEqual(read(r.path), bytes);
});

test("when every candidate name holds other content, it is an error, never a claimed duplicate", async () => {
  const root = tmp();
  const bytes = Buffer.from("the real one\n");
  const dir = path.join(root, "x", "2026-10-05");
  fs.mkdirSync(dir, { recursive: true });
  for (const n of candidateNames("a.gcode", crypto.createHash("sha256").update(bytes).digest("hex"))) fs.writeFileSync(path.join(dir, n), "other");
  const r = await archivePush({ fsApi, root, userLabel: "x", name: "a.gcode", bytes, now: NOON });
  assert.equal(r.status, "error");
  assert.match(r.error, /taken/);
});

test("a read error while checking an existing copy is reported, not mistaken for different content", async () => {
  const root = tmp();
  const bytes = Buffer.from("G1\n");
  await archivePush({ fsApi, root, userLabel: "x", name: "a.gcode", bytes, now: NOON });
  const flaky = { ...fsApi, readFile: async () => { throw new Error("share hiccup"); } };
  const r = await archivePush({ fsApi: flaky, root, userLabel: "x", name: "a.gcode", bytes, now: NOON });
  assert.equal(r.status, "error");
  assert.match(r.error, /share hiccup/);
  assert.equal(fs.readdirSync(path.join(root, "x", "2026-10-05")).length, 1, "no second copy was written");
});

test("a write that dies part-way never leaves a file under the archived name", async () => {
  const root = tmp();
  const dying = { ...fsApi, writeFileExclusive: async (p, data) => { fs.writeFileSync(p, data.subarray(0, 2), { flag: "wx" }); throw new Error("ENOSPC"); } };
  const r = await archivePush({ fsApi: dying, root, userLabel: "x", name: "a.gcode", bytes: Buffer.from("G1 X10\n"), now: NOON });
  assert.equal(r.status, "error");
  const left = fs.readdirSync(path.join(root, "x", "2026-10-05"));
  assert.ok(!left.includes("a.gcode"), "nothing under the real name: " + left);
  assert.ok(left.every(n => n.startsWith(".")), "leftovers are hidden partials the Library skips: " + left);
});

test("two identical pushes at the same moment are stored once", async () => {
  const root = tmp();
  // A share writes in pieces: the file exists, half-written, while the write is
  // still in flight. A second push arriving then must not see "different content".
  const slow = { ...fsApi, writeFileExclusive: async (p, d) => {
    fs.writeFileSync(p, d.subarray(0, 2), { flag: "wx" });
    await new Promise(r => setTimeout(r, 20));
    fs.appendFileSync(p, d.subarray(2));
  } };
  const bytes = Buffer.from("G1 X1\n");
  const [a, b] = await Promise.all([1, 2].map(() => archivePush({ fsApi: slow, root, userLabel: "x", name: "a.gcode", bytes, now: NOON })));
  assert.deepEqual([a.status, b.status].sort(), ["archived", "duplicate"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "x", "2026-10-05")).filter(n => !n.startsWith(".")), ["a.gcode"]);
});

test("a missing or malformed archive folder is an error result, not a throw", async () => {
  for (const root of [null, "", true, 42]) {
    const r = await archivePush({ fsApi, root, userLabel: "x", name: "a.gcode", bytes: Buffer.from("G1\n"), now: NOON });
    assert.equal(r.status, "error", "root " + JSON.stringify(root));
  }
});

test("replayRootFor: default under the G-code folder, relative to the app, absolute kept, junk refused", () => {
  const base = path.resolve("/app"), gcode = path.resolve("/app/gcode");
  assert.equal(replayRootFor(undefined, base, gcode), path.join(gcode, "Archive"));
  assert.equal(replayRootFor("", base, gcode), path.join(gcode, "Archive"));
  assert.equal(replayRootFor("replays", base, gcode), path.join(base, "replays"));
  assert.equal(replayRootFor(path.resolve("/nas/replays"), base, gcode), path.resolve("/nas/replays"));
  assert.equal(replayRootFor(true, base, gcode), null);
  assert.equal(replayRootFor({}, base, gcode), null);
});

test("server.js archives in the push route, in the background, behind the opt-out, and audits failures", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = src.slice(src.indexOf('app.post("/api/notify-load"'));
  const end = route.indexOf("uploadNotifiedFile(idx, { file: tmpFile");
  const block = route.slice(0, end);
  const at = block.indexOf("archivePush({");
  assert.ok(at > 0, "the push route must call archivePush before the temp copy is handed off");
  assert.ok(block.lastIndexOf("CFG.archivePushes !== false", at) > 0, "behind the archivePushes opt-out");
  assert.ok(!/await\s+archivePush\(/.test(block), "never awaited: a slow share must not hold up the print");
  assert.ok(block.includes("replayRootFor("), "the folder is resolved by replayRootFor, which cannot throw");
  assert.ok(/event:\s*"file-archive-failed"/.test(block), "a failed archive is audited");
  assert.ok(/event:\s*"file-archived"/.test(block), "a kept copy is audited");
});
