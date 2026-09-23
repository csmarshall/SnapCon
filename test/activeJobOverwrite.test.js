// test/activeJobOverwrite.test.js — refusing to send a file that would
// overwrite the one a printer is printing right now.
//
// Why this is a safety rule and not a convenience check:
//   - Moonraker's /server/files/upload takes no overwrite flag and replaces a
//     same-named file in place (connectors/http-utils.js uploadWithProgress
//     sends only the `file` part).
//   - Klipper's virtual_sdcard streams the RUNNING job out of that same file
//     by byte offset.
// So overwriting it mid-print can feed a 22-hour job garbage. Whether
// Moonraker truncates in place is deliberately NOT tested against hardware —
// the point is to never find out.
//
// Nothing guarded this before: /api/print consults isPrinterIdle only when
// `start` is false (server.js ~1426), /api/printfile has no idle gate at all,
// and queue dispatch uploads unconditionally.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function extractFn(name) {
  const a = serverSrc.indexOf("async function " + name + "(");
  const b = serverSrc.indexOf("function " + name + "(");
  const at = a >= 0 ? a : b;
  assert.ok(at > 0, name + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2);
}

const sandbox = { path };
vm.createContext(sandbox);
vm.runInContext(extractFn("activeJobConflict"), sandbox);
const conflict = (state, active, target) => vm.runInContext("activeJobConflict", sandbox)(state, active, target);

// ---- the rule ----

test("a printer printing this exact file conflicts", () => {
  assert.equal(conflict("printing", "Rose Dragon (21h58m).gcode", "Rose Dragon (21h58m).gcode"), true);
});

test("a paused printer still owns its file", () => {
  // Paused is mid-job: the file is still open and will be read again on resume.
  assert.equal(conflict("paused", "job.gcode", "job.gcode"), true);
});

test("a different file on a printing printer is fine", () => {
  assert.equal(conflict("printing", "other.gcode", "job.gcode"), false);
});

test("an idle printer never conflicts, whatever it last ran", () => {
  // The connector deliberately leaves a STALE filename on the payload after a
  // job ends or on a Klippy fault, as a diagnostic
  // (snapmaker-u1-klipper.js ~162) — so the filename alone proves nothing and
  // the state has to carry the decision.
  for (const state of ["standby", "complete", "cancelled", "error", "idle", "", null, undefined]) {
    assert.equal(conflict(state, "job.gcode", "job.gcode"), false, `state ${JSON.stringify(state)} must not block`);
  }
});

test("no active filename means nothing to protect", () => {
  for (const active of ["", null, undefined]) {
    assert.equal(conflict("printing", active, "job.gcode"), false);
  }
});

// ---- the comparison itself ----

test("matched on basename, because the two sides spell paths differently", () => {
  // listFiles/print_stats report a path that can include a subfolder, while an
  // upload lands under a bare basename (server.js ~1418). Comparing the raw
  // strings would miss the very collision this exists to catch.
  assert.equal(conflict("printing", "jobs/batch 2/job.gcode", "job.gcode"), true);
  assert.equal(conflict("printing", "job.gcode", "jobs/job.gcode"), true);
});

test("backslashes in a stored path do not defeat the match", () => {
  assert.equal(conflict("printing", "jobs\\job.gcode", "job.gcode"), true);
});

test("names differing only in case are treated as different files", () => {
  // The printers are Linux; Job.gcode and job.gcode really are two files, and
  // claiming a conflict would block a legitimate send.
  assert.equal(conflict("printing", "Job.gcode", "job.gcode"), false);
});

test("a name that merely contains the other is not a match", () => {
  assert.equal(conflict("printing", "job.gcode", "my job.gcode"), false);
  assert.equal(conflict("printing", "job.gcode.bak", "job.gcode"), false);
});

// ---- where it is enforced ----

test("every path that puts bytes on a printer is guarded", () => {
  // A rule enforced in one of the three is not enforced: the card, the
  // printer-files modal and the queue all reach the same printer.
  const guard = /assertNotActiveJobFile/g;
  const hits = serverSrc.match(guard) || [];
  assert.ok(hits.length >= 4, `expected the guard defined and used on every send path, found ${hits.length} mentions`);

  const route = (name) => {
    const at = serverSrc.indexOf(`app.post("${name}"`);
    assert.ok(at > 0, name + " must exist");
    return serverSrc.slice(at, serverSrc.indexOf("\napp.", at + 10));
  };
  assert.match(route("/api/print"), /assertNotActiveJobFile/, "/api/print uploads — it must check");
  assert.match(route("/api/printfile"), /assertNotActiveJobFile/, "/api/printfile starts a print — it must check");
});

test("the guard runs BEFORE the upload-or-queue decision", () => {
  // Queuing a file that would overwrite the running job just defers the
  // damage; the refusal has to come first.
  const at = serverSrc.indexOf('app.post("/api/print"');
  const body = serverSrc.slice(at, serverSrc.indexOf("\napp.", at + 10));
  const guardAt = body.indexOf("assertNotActiveJobFile");
  const queueAt = body.indexOf("isPrinterIdle");
  const uploadAt = body.indexOf("uploadFile");
  assert.ok(guardAt > 0 && queueAt > 0 && uploadAt > 0);
  assert.ok(guardAt < queueAt, "must precede the queue decision");
  assert.ok(guardAt < uploadAt, "must precede the upload");
});

test("the refusal is a 409, not a generic failure", () => {
  // The client distinguishes this from a transport error: it is a refusal the
  // user can act on by waiting or renaming.
  const fn = extractFn("assertNotActiveJobFile");
  assert.match(fn, /409/);
});
