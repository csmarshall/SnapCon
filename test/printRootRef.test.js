// test/printRootRef.test.js — printing and queueing from any Library location
// (docs/library-design.md §12, M7): a file is named by a location and its path
// inside it, and must resolve to somewhere inside that location — by its real
// path, so a link or junction inside the location can't lead out of it. No
// location (or "gcode") is the G-code folder exactly as before.
//
// resolveFileRef is extracted from server.js and run against the real
// pathSafety functions and the real filesystem (the project has no express
// harness; see test/printFileAsyncJob.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { isPathWithinFolder, resolveWithinFolder } = require("../pathSafety");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const fnSrc = name => { const at = serverSrc.indexOf("async function " + name + "("); assert.ok(at > 0, name); return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2); };

class LibraryError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

function harness(t, { realpath } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ref-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const gcode = path.join(base, "gcode"), nas = path.join(base, "nas"), outside = path.join(base, "outside");
  for (const d of [gcode, nas, outside]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(nas, "Frog.gcode"), "G1");
  fs.writeFileSync(path.join(outside, "secret.gcode"), "G1");
  let linked = true;
  try { fs.symlinkSync(outside, path.join(nas, "escape"), "junction"); } catch { linked = false; }
  const calls = [];
  const env = {
    path, GCODE_ROOT: "gcode", FOLDER: gcode, LibraryError, isPathWithinFolder, resolveWithinFolder,
    safePath: sub => resolveWithinFolder(sub, gcode),
    library: { printLocation: (user, id, opts) => { calls.push([user && user.id, id, !!(opts && opts.system)]); if (id === "nas") return { id, path: nas }; throw new LibraryError(404, "location_not_found", "no"); } },
    netfs: { realpath: realpath || (async p => fs.realpathSync.native(p)) },
  };
  vm.createContext(env);
  vm.runInContext(fnSrc("resolveFileRef"), env);
  return { resolve: (...a) => env.resolveFileRef(...a), base, gcode, nas, linked, calls };
}

test("no location is the G-code folder, exactly as before", async t => {
  const h = harness(t);
  assert.deepEqual({ ...(await h.resolve({ id: "u" }, undefined, "A/B.gcode")) }, { fp: path.join(h.gcode, "A", "B.gcode"), root: "gcode", dir: h.gcode });
  assert.deepEqual({ ...(await h.resolve({ id: "u" }, "gcode", "B.gcode")) }, { fp: path.join(h.gcode, "B.gcode"), root: "gcode", dir: h.gcode });
  assert.equal(await h.resolve({ id: "u" }, "", "../x.gcode"), null);
  assert.equal(h.calls.length, 0, "the Library is not asked about the G-code folder");
});

test("a Library location: inside it, by its real path, with the person's permission checked by the Library", async t => {
  const h = harness(t);
  const r = await h.resolve({ id: "u" }, "nas", "Frog.gcode");
  assert.deepEqual({ ...r }, { fp: path.join(h.nas, "Frog.gcode"), root: "nas", dir: h.nas });
  assert.deepEqual(h.calls[0], ["u", "nas", false]);
  assert.equal(await h.resolve({ id: "u" }, "nas", "../outside/secret.gcode"), null, "out of the location by ..");
  assert.equal(await h.resolve({ id: "u" }, "nas", "Nope.gcode"), null, "no such file");
  if (!h.linked) return t.skip("could not create a junction here");
  assert.equal(await h.resolve({ id: "u" }, "nas", "escape/secret.gcode"), null, "out of the location through a junction");
});

test("an unreachable share or an unusable location is an error, never 'not found'", async t => {
  const h = harness(t, { realpath: async () => { const e = new Error("down"); e.code = "NAS_UNREACHABLE"; throw e; } });
  await assert.rejects(h.resolve({ id: "u" }, "nas", "Frog.gcode"), { code: "NAS_UNREACHABLE" });
  await assert.rejects(h.resolve({ id: "u" }, "gone", "Frog.gcode"), { code: "location_not_found" });
  await h.resolve(null, "nas", "Frog.gcode", { system: true }).catch(() => {});
  assert.deepEqual(h.calls.at(-1), [null, "nas", true], "dispatch asks as the system");
});

test("dispatch: a moved file is used only after its full hash matches, and every started job is recorded once", () => {
  const at = serverSrc.indexOf("async function relocateQueuedFile(");
  const reloc = serverSrc.slice(at, serverSrc.indexOf("\n}", at));
  assert.match(reloc, /computeFileHash\(ref\.fp, \{ force: true \}\)/);
  assert.ok(reloc.indexOf("h.sha256 !== item.file.sha256") < reloc.indexOf("return { fp: ref.fp"), "compared before it is used");
  const d = serverSrc.slice(serverSrc.indexOf("async function attemptQueueDispatch("));
  const fn = d.slice(0, d.search(/\r?\n\}\r?\n/));   // whatever the checkout's line endings
  // A Library location that does not answer at all is offline: the item
  // waits, before any copy elsewhere is considered and before "missing".
  const offlineAt = fn.indexOf("!(await locationAnswers(nextDir))");
  assert.ok(offlineAt > 0 && offlineAt < fn.indexOf("relocateQueuedFile(item)"), "offline is decided before relocation");
  assert.ok(fn.indexOf("QueueEngine.onDispatchDeferred, item.id", offlineAt) < fn.indexOf("relocateQueuedFile(item)"));
  assert.ok(offlineAt < fn.indexOf('"missing", { code: "file-missing", message: "File no longer exists: "'), "and never failed as missing");
  assert.equal(fn.split("library.recordPrintStart(").length - 1, 1);
  assert.ok(fn.indexOf("library.recordPrintStart(") > fn.indexOf("c.startPrintFile(p, name)"), "only after the printer accepted the start");
  assert.match(fn, /jobKey: "queue:" \+ item\.id/);
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/print"'));
  const body = route.slice(0, route.indexOf("\napp."));
  assert.equal(body.split("library.recordPrintStart(").length - 1, 1);
  assert.ok(body.indexOf("library.recordPrintStart(") > body.indexOf("await c.startPrintFile(p, name)"));
  assert.match(body, /if \(start\) \{\s*library\.recordPrintStart\(/, "an upload without a start is not a print");
});

test("accepting a changed file hashes it where the item lives, not in the G-code folder (M8 review)", () => {
  const at = serverSrc.indexOf('app.post("/api/queue/:printerId/accept-file-change"');
  const route = serverSrc.slice(at, at + serverSrc.slice(at).search(/\r?\n\}\);\r?\n/));
  assert.match(route, /resolveFileRef\(req\.user, item\.file\.root, /, "the item's own location, as the person accepting");
  assert.doesNotMatch(route, /safePath\(/, "never the G-code folder's path for a Library item");
  assert.match(route, /replyFileRefError\(res, e, item\.file\.root\)/);
});

test("the queue refuses a file no printer can start, before reading it (M8 review)", () => {
  const at = serverSrc.indexOf("async function resolveQueuedFile(");
  const fn = serverSrc.slice(at, at + serverSrc.slice(at).search(/\r?\n\}\r?\n/));
  const refuse = fn.indexOf('fileTypeRefusal(null, name, "The queue")');
  assert.ok(refuse > 0 && refuse < fn.indexOf("resolveFileRef("), "checked before the file is even resolved");
  const env = { DEFAULT_FILE_TYPES: ["gcode", "gco", "g", "gx", "3mf"] };
  vm.createContext(env);
  const ft = serverSrc.indexOf("function fileTypeRefusal(");
  vm.runInContext(serverSrc.slice(ft, ft + serverSrc.slice(ft).search(/\r?\n\}\r?\n/) + 3), env);
  assert.match(env.fileTypeRefusal(null, "Beardie.stl", "The queue"), /cannot print/);
  assert.equal(env.fileTypeRefusal(null, "Beardie.gcode", "The queue"), null);
});
