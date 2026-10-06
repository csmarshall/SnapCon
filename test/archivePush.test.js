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

const { archivePush, archiveInBackground, archiveAuditEntry, sweepPartials, RENAME_ATTEMPTS, safeSegment, safeFileName, dateStamp, candidateNames, replayRootFor, MAX_QUEUED_PER_FOLDER, ARCHIVE_IO_TIMEOUT_MS } = require("../archivePush");

// Same shape as netfs: mkdir(p, {recursive}), an exclusive writer that rejects
// with code EEXIST rather than overwrite, exists() that is false only for "not
// there", rename, and readFile(p, maxBytes) that reads at most maxBytes.
const fsApi = {
  mkdir: async (p, o) => fs.mkdirSync(p, { recursive: !!(o && o.recursive) }),
  writeFileExclusive: async (p, data) => fs.writeFileSync(p, data, { flag: "wx" }),
  exists: async p => fs.existsSync(p),
  stat: async p => fs.statSync(p),
  rename: async (a, b) => fs.renameSync(a, b),
  unlink: async p => fs.unlinkSync(p),
  readdir: async p => fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })),
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

test("a reservation that fails never deletes anything; an empty leftover is left for the sweep", async () => {
  const root = tmp();
  const dying = { ...fsApi, writeFileExclusive: async (p, data) => { fs.writeFileSync(p, data.subarray(0, 2), { flag: "wx" }); throw new Error("EIO"); } };
  const r = await archivePush({ fsApi: dying, root, userLabel: "x", name: "a.gcode", bytes: Buffer.from("G1 X10\n"), now: NOON });
  assert.equal(r.status, "error");
  assert.deepEqual(fs.readdirSync(path.join(root, "x", "2026-10-05")), ["a.gcode"], "left in place, not guessed at");
  assert.equal(fs.statSync(path.join(root, "x", "2026-10-05", "a.gcode")).size, 0);
});

test("a write that dies part-way never leaves a file under the archived name", async () => {
  const root = tmp();
  // The empty reservation succeeds; the real bytes die half-written.
  const dying = { ...fsApi, writeFileExclusive: async (p, data) => {
    if (!data.length) return fsApi.writeFileExclusive(p, data);
    fs.writeFileSync(p, data.subarray(0, 2), { flag: "wx" }); throw new Error("ENOSPC");
  } };
  const r = await archivePush({ fsApi: dying, root, userLabel: "x", name: "a.gcode", bytes: Buffer.from("G1 X10\n"), now: NOON });
  assert.equal(r.status, "error");
  assert.match(r.error, /ENOSPC/);
  assert.deepEqual(fs.readdirSync(path.join(root, "x", "2026-10-05")), [], "placeholder and partial both removed");
});

test("a failed reservation never removes a file that has content", async () => {
  const root = tmp();
  const dir = path.join(root, "x", "2026-10-05");
  // The create fails with something other than EEXIST, and by the time we look
  // the name holds real bytes (someone else's): it must be left alone.
  const odd = { ...fsApi, writeFileExclusive: async (p, data) => {
    if (!data.length) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "theirs"); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
    return fsApi.writeFileExclusive(p, data);
  } };
  const r = await archivePush({ fsApi: odd, root, userLabel: "x", name: "a.gcode", bytes: Buffer.from("ours\n"), now: NOON });
  assert.equal(r.status, "error");
  assert.equal(fs.readFileSync(path.join(dir, "a.gcode"), "utf8"), "theirs");
});

test("a rename that completes but reports an error never deletes the finished copy", async () => {
  const root = tmp();
  const liar = { ...fsApi, rename: async (a, b) => { fs.renameSync(a, b); throw Object.assign(new Error("EIO after rename"), { code: "EIO" }); } };
  const bytes = Buffer.from("G1 X10\n");
  const r = await archivePush({ fsApi: liar, root, userLabel: "x", name: "a.gcode", bytes, now: NOON });
  assert.equal(r.status, "error");
  assert.deepEqual(read(path.join(root, "x", "2026-10-05", "a.gcode")), bytes, "the complete copy stays");
});

test("a rename refused because something has the placeholder open is retried", async () => {
  const root = tmp();
  let fails = RENAME_ATTEMPTS - 1;
  const busy = { ...fsApi, rename: async (a, b) => { if (fails-- > 0) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); return fsApi.rename(a, b); } };
  const r = await archivePush({ fsApi: busy, root, userLabel: "x", name: "a.gcode", bytes: Buffer.from("G1\n"), now: NOON });
  assert.equal(r.status, "archived");
});

test("a rename that stays refused gives up after RENAME_ATTEMPTS and cleans up", async () => {
  const root = tmp();
  let calls = 0;
  const busy = { ...fsApi, rename: async () => { calls++; throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } };
  const r = await archivePush({ fsApi: busy, root, userLabel: "x", name: "a.gcode", bytes: Buffer.from("G1\n"), now: NOON });
  assert.equal(r.status, "error");
  assert.equal(calls, RENAME_ATTEMPTS);
  assert.deepEqual(fs.readdirSync(path.join(root, "x", "2026-10-05")), []);
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

test("server.js starts the archive in the background, behind the opt-out, audits through archiveAuditEntry, and sweeps partials at startup", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = src.slice(src.indexOf('app.post("/api/notify-load"'));
  const block = route.slice(0, route.indexOf("uploadNotifiedFile(idx, { file: tmpFile"));
  const at = block.indexOf("archiveInBackground({");
  assert.ok(at > 0, "the push route starts the archive before the temp copy is handed off");
  assert.ok(block.lastIndexOf("CFG.archivePushes !== false", at) > 0, "behind the archivePushes opt-out");
  assert.ok(!/archivePush\(\{/.test(block), "the route never calls archivePush directly (archiveInBackground is what cannot block)");
  assert.ok(/auditLog\.log\(archiveAuditEntry\(/.test(block), "the result is audited through archiveAuditEntry");
  assert.ok(/CFG\.archivePushes !== false\) \{\s*sweepPartials\(\{/.test(src), "leftover partials are swept at startup, behind the same opt-out");
});

test("archiveInBackground returns at once even when the share never answers", () => {
  const hung = { ...fsApi, mkdir: () => new Promise(() => {}) };
  let done = false;
  const ret = archiveInBackground({ fsApi: hung, root: tmp(), userLabel: "x", name: "a.gcode", bytes: Buffer.from("G1\n"), onDone: () => { done = true; } });
  assert.equal(ret, undefined, "nothing to await");
  assert.equal(done, false);
});

test("archiveInBackground reports the result, and a throwing onDone is contained", async () => {
  const root = tmp();
  const result = await new Promise(resolve => archiveInBackground({ fsApi, root, userLabel: "x", name: "a.gcode", bytes: Buffer.from("G1\n"), now: NOON, onDone: resolve }));
  assert.equal(result.status, "archived");
  const errors = [];
  const origWarn = console.warn; console.warn = m => errors.push(m);
  try {
    await new Promise(resolve => archiveInBackground({ fsApi, root, userLabel: "y", name: "a.gcode", bytes: Buffer.from("G1\n"), now: NOON, onDone: () => { setTimeout(resolve, 5); throw new Error("audit db gone"); } }));
    await new Promise(r => setTimeout(r, 10));
  } finally { console.warn = origWarn; }
  assert.ok(errors.some(m => /audit db gone/.test(m)), "logged, not an unhandled rejection");
});

test("archiveAuditEntry: kept copies and failures are distinct audit events", () => {
  const ctx = { actor: { userId: "u1", userLabel: "C" }, printer: { id: "p1", name: "U1" }, name: "a.gcode" };
  const ok = archiveAuditEntry({ status: "archived", path: "/r/C/d/a.gcode" }, ctx);
  assert.deepEqual(ok, { category: "job", event: "file-archived", userId: "u1", userLabel: "C", printerId: "p1", printerName: "U1", detail: { file: "a.gcode", result: "archived", archivedAs: "/r/C/d/a.gcode" } });
  const bad = archiveAuditEntry({ status: "error", error: "share down" }, ctx);
  assert.equal(bad.event, "file-archive-failed");
  assert.deepEqual(bad.detail, { file: "a.gcode", error: "share down" });
});

test("a file someone else puts at the name is never overwritten, even if the share reported the name free", async () => {
  const root = tmp();
  const dir = path.join(root, "x", "2026-10-05");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.gcode"), "theirs");
  const liar = { ...fsApi, exists: async () => false };
  const r = await archivePush({ fsApi: liar, root, userLabel: "x", name: "a.gcode", bytes: Buffer.from("ours\n"), now: NOON });
  assert.equal(r.status, "archived");
  assert.equal(fs.readFileSync(path.join(dir, "a.gcode"), "utf8"), "theirs", "the other file is untouched");
  assert.notEqual(r.path, path.join(dir, "a.gcode"));
});

test("on a case-insensitive share, 'Charles' and 'charles' pushing at once both keep their copies", async () => {
  const root = tmp();
  const fold = p => p.toLowerCase();
  const ci = {};
  for (const [k, f] of Object.entries(fsApi)) ci[k] = (...a) => f(...a.map(x => typeof x === "string" ? fold(x) : x));
  const slowWrite = ci.writeFileExclusive;
  ci.writeFileExclusive = async (p, d) => { await new Promise(r => setTimeout(r, 15)); return slowWrite(p, d); };
  const [a, b] = await Promise.all([
    archivePush({ fsApi: ci, root, userLabel: "Charles", name: "a.gcode", bytes: Buffer.from("one\n"), now: NOON }),
    archivePush({ fsApi: ci, root, userLabel: "charles", name: "a.gcode", bytes: Buffer.from("two\n"), now: NOON })
  ]);
  assert.deepEqual([a.status, b.status], ["archived", "archived"]);
  assert.notEqual(fold(a.path), fold(b.path));
  const kept = fs.readdirSync(path.join(fold(root), "charles", "2026-10-05")).filter(n => !n.startsWith(".")).map(n => fs.readFileSync(path.join(fold(root), "charles", "2026-10-05", n), "utf8")).sort();
  assert.deepEqual(kept, ["one\n", "two\n"]);
});

test("on a case-insensitive share, the same bytes from 'Charles' and 'charles' at once are stored once", async () => {
  const root = tmp();
  const fold = p => p.toLowerCase();
  const ci = {};
  for (const [k, f] of Object.entries(fsApi)) ci[k] = (...a) => f(...a.map(x => typeof x === "string" ? fold(x) : x));
  const slowWrite = ci.writeFileExclusive;
  ci.writeFileExclusive = async (p, d) => { await new Promise(r => setTimeout(r, 15)); return slowWrite(p, d); };
  const bytes = Buffer.from("same\n");
  const [a, b] = await Promise.all(["Charles", "charles"].map(u => archivePush({ fsApi: ci, root, userLabel: u, name: "a.gcode", bytes, now: NOON })));
  assert.deepEqual([a.status, b.status].sort(), ["archived", "duplicate"]);
  assert.deepEqual(fs.readdirSync(path.join(fold(root), "charles", "2026-10-05")).filter(n => !n.startsWith(".")), ["a.gcode"]);
});

test("a burst beyond the per-folder queue limit is refused, not held in memory", async () => {
  const root = tmp();
  const slow = { ...fsApi, writeFileExclusive: async (p, d) => { await new Promise(r => setTimeout(r, 5)); return fsApi.writeFileExclusive(p, d); } };
  const n = MAX_QUEUED_PER_FOLDER + 3;
  const results = await Promise.all(Array.from({ length: n }, (_, i) => archivePush({ fsApi: slow, root, userLabel: "x", name: "f" + i + ".gcode", bytes: Buffer.from("G" + i + "\n"), now: NOON })));
  assert.ok(results.filter(r => r.status === "error" && /busy/.test(r.error)).length >= 1, JSON.stringify(results.map(r => r.status)));
  assert.ok(results.filter(r => r.status === "archived").length >= MAX_QUEUED_PER_FOLDER);
});

test("the duplicate check reads with the archive's long timeout, so a big file over a slow link does not mark the share offline", async () => {
  const root = tmp();
  const bytes = Buffer.from("G1\n");
  await archivePush({ fsApi, root, userLabel: "x", name: "a.gcode", bytes, now: NOON });
  let seen = null;
  const spy = { ...fsApi, readFile: async (p, max, o) => { seen = o; return fsApi.readFile(p, max); } };
  await archivePush({ fsApi: spy, root, userLabel: "x", name: "a.gcode", bytes, now: NOON });
  assert.ok(seen && seen.timeoutMs === ARCHIVE_IO_TIMEOUT_MS, JSON.stringify(seen));
});

test("a very long extension cannot turn the name into a hidden file", () => {
  const n = safeFileName("x." + "g".repeat(300));
  assert.ok(!n.startsWith("."), n);
  assert.ok(n.length <= 150, String(n.length));
});

test("sweepPartials removes only old hidden .partial files inside user/date folders", async () => {
  const root = tmp();
  const dir = path.join(root, "x", "2026-10-05");
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, ".a.gcode.1234abcd.partial"), fresh = path.join(dir, ".b.gcode.5678abcd.partial");
  const real = path.join(dir, "c.gcode"), lookalike = path.join(dir, "d.partial"), hidden = path.join(dir, ".keep");
  for (const f of [old, fresh, real, lookalike, hidden]) fs.writeFileSync(f, "x");
  const now = Date.now();
  fs.utimesSync(old, new Date(now - 2 * 86400000), new Date(now - 2 * 86400000));
  const removed = await sweepPartials({ fsApi, root, now, olderThanMs: 86400000 });
  assert.deepEqual(removed, [old]);
  for (const f of [fresh, real, lookalike, hidden]) assert.ok(fs.existsSync(f), f + " kept");
});

test("sweepPartials also removes old empty placeholders, only inside <user>/<YYYY-MM-DD>/", async () => {
  const root = tmp();
  const day = path.join(root, "x", "2026-10-05"), other = path.join(root, "x", "projects");
  fs.mkdirSync(day, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  const now = Date.now(), old = new Date(now - 2 * 86400000);
  const emptyOld = path.join(day, "a.gcode"), emptyFresh = path.join(day, "b.gcode"), full = path.join(day, "c.gcode"), emptyElsewhere = path.join(other, "d.gcode");
  for (const f of [emptyOld, emptyFresh, emptyElsewhere]) fs.writeFileSync(f, "");
  fs.writeFileSync(full, "G1\n");
  for (const f of [emptyOld, full, emptyElsewhere]) fs.utimesSync(f, old, old);
  const removed = await sweepPartials({ fsApi, root, now, olderThanMs: 86400000 });
  assert.deepEqual(removed, [emptyOld]);
  for (const f of [emptyFresh, full, emptyElsewhere]) assert.ok(fs.existsSync(f), f + " kept");
});

test("sweepPartials on a missing or unset folder does nothing and does not throw", async () => {
  assert.deepEqual(await sweepPartials({ fsApi, root: path.join(tmp(), "nope"), now: Date.now(), olderThanMs: 1 }), []);
  assert.deepEqual(await sweepPartials({ fsApi, root: null, now: Date.now(), olderThanMs: 1 }), []);
});
