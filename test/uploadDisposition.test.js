// test/uploadDisposition.test.js — what the Upload button does to a printer
// that is already busy, and whether it also schedules a print.
//
// Two problems this settles.
//
// First, "Upload" meant two different things depending on the printer. On one
// without a queue pool it staged a file (pendingLoad: transfer deferred, the
// card shows "Loaded", nothing prints). On a pooled printer the same click
// created a QUEUE ITEM, which the engine later uploads AND starts printing.
// Same button, same look, one stages a file and the other schedules a print.
// Upload now always means upload; scheduling is the separate, explicit
// "Upload into queue" setting, and it applies ALWAYS rather than only when the
// printer happened to be mid-print at the moment of the click.
//
// Second, deferring an upload was guarding against racing a transfer against a
// running print. The dangerous half of that race — writing over the file being
// streamed — is now refused outright by assertNotActiveJobFile, so the
// deferral is a setting rather than a rule. What is NOT allowed either way is
// upload-AND-print against a busy printer, which had no server-side guard at
// all: only the disabled button stopped it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

const at = serverSrc.indexOf("function uploadDisposition(");
assert.ok(at > 0, "uploadDisposition must exist in server.js");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2), sandbox);
const decide = o => vm.runInContext("uploadDisposition", sandbox)(o);

// Defaults: uploading while printing is allowed, queueing is not.
const D = { start: false, busy: false, allowWhilePrinting: true, uploadIntoQueue: false, pooled: false };
const on = over => decide({ ...D, ...over });

// ---- upload-and-print against a busy printer ----

test("printing a file onto a printer that is already printing is refused", () => {
  // The gap: /api/print never consulted isPrinterIdle when start was true.
  assert.equal(on({ start: true, busy: true }).action, "refuse");
});

test("the refusal stands however the settings are set", () => {
  // "Allow uploading while printing" is about UPLOADING. It must not be read
  // as permission to start a second print.
  assert.equal(on({ start: true, busy: true, allowWhilePrinting: true }).action, "refuse");
  assert.equal(on({ start: true, busy: true, uploadIntoQueue: true, pooled: true }).action, "refuse");
});

test("printing to an idle printer is unaffected", () => {
  assert.equal(on({ start: true, busy: false }).action, "upload");
});

// ---- uploading while printing ----

test("with the setting on, an upload to a busy printer goes straight through", () => {
  assert.equal(on({ busy: true, allowWhilePrinting: true }).action, "upload");
});

test("with the setting off, it is deferred exactly as before", () => {
  assert.equal(on({ busy: true, allowWhilePrinting: false }).action, "defer");
});

test("an idle printer uploads immediately whatever the setting says", () => {
  assert.equal(on({ busy: false, allowWhilePrinting: false }).action, "upload");
  assert.equal(on({ busy: false, allowWhilePrinting: true }).action, "upload");
});

// ---- upload into queue ----

test("queueing is off by default — Upload stages a file and schedules nothing", () => {
  // The behaviour change for existing queue users, and the reason it is in the
  // release notes: their Upload click no longer produces a print.
  assert.equal(on({ pooled: true }).queue, false);
  assert.equal(on({ pooled: true, busy: true }).queue, false);
});

test("with queueing on, a pooled printer gets an item — ALWAYS, not only when busy", () => {
  // The decision that makes the setting mean what its label says: a queue
  // that only happens when the printer was mid-print at the moment of the
  // click is the hidden conditional this replaces.
  assert.equal(on({ uploadIntoQueue: true, pooled: true, busy: false }).queue, true);
  assert.equal(on({ uploadIntoQueue: true, pooled: true, busy: true }).queue, true);
});

test("a printer in no pool has no queue to be inserted into", () => {
  assert.equal(on({ uploadIntoQueue: true, pooled: false }).queue, false);
});

test("printing never creates a queue item — it prints now", () => {
  assert.equal(on({ start: true, uploadIntoQueue: true, pooled: true }).queue, false);
});

// ---- alreadyUploaded: the field this finally gives a meaning ----

test("an item created after an immediate upload says the bytes are already there", () => {
  // alreadyUploaded is written false at all four creation sites in the repo
  // and set true nowhere. Without this, dispatch would upload the same file a
  // second time.
  const d = on({ uploadIntoQueue: true, pooled: true });
  assert.equal(d.action, "upload");
  assert.equal(d.alreadyUploaded, true);
});

test("an item created for a DEFERRED upload does not claim the bytes are there", () => {
  const d = on({ uploadIntoQueue: true, pooled: true, busy: true, allowWhilePrinting: false });
  assert.equal(d.action, "defer");
  assert.equal(d.alreadyUploaded, false, "the file has not been sent yet — the queue must upload it");
});

test("alreadyUploaded is never claimed without a queue item to carry it", () => {
  assert.equal(on({ uploadIntoQueue: false }).queue, false);
});

// ---- wiring ----

test("the route uses it, and both settings round-trip with their stated defaults", () => {
  assert.match(serverSrc, /uploadDisposition\(/, "the route must consult it");
  assert.match(serverSrc, /allowUploadWhilePrinting: CFG\.allowUploadWhilePrinting !== false/,
    "allow-while-printing defaults ON");
  assert.match(serverSrc, /uploadIntoQueue: CFG\.uploadIntoQueue === true/,
    "upload-into-queue defaults OFF");
});
