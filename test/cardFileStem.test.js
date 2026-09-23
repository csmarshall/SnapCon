// test/cardFileStem.test.js — which file a printer's card is actually about.
//
// Reported live on two AD5Xs: files were uploaded through SnapCon, then a
// DIFFERENT job was started at the printer itself. The card showed the right
// status and the right progress bar, but the wrong filename and the wrong
// thumbnail. The fleet row was correct all along:
//
//   filename   = "MatMireMakes - Beardie (PLA_5h41m).gcode"   <- actually printing
//   queuedFile = "Ferret (11h21m).gcode"  status: ready       <- staged, never started
//
// Five places all resolved this the same way — `queuedReady ? queuedReady.name
// : p.filename` — on the documented reasoning that a staged file is "the more
// relevant what's-up-next" compared with the printer's LAST-PRINTED filename.
// That reasoning is right for an idle printer and wrong for a running one:
// while a print is in progress, p.filename is not history, it is the job on
// the machine, and it outranks anything merely waiting its turn.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

const start = appSrc.indexOf("function cardFileStem(");
assert.ok(start > 0, "cardFileStem must exist in public/app.js");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(appSrc.slice(start, appSrc.indexOf("\n}", start) + 2), sandbox);
const stem = p => vm.runInContext("cardFileStem", sandbox)(p);

const staged = { name: "Ferret (11h21m).gcode", status: "ready", ts: 1 };
const RUNNING = "MatMireMakes - Beardie (PLA_5h41m).gcode";

test("a printing printer shows the job it is running, not a staged file", () => {
  // THE regression, with the exact values reported.
  assert.equal(stem({ state: "printing", filename: RUNNING, queuedFile: staged }), RUNNING);
});

test("a paused printer still shows its own job", () => {
  assert.equal(stem({ state: "paused", filename: RUNNING, queuedFile: staged }), RUNNING);
});

test("an idle printer still shows the staged file — unchanged behaviour", () => {
  // This is what the precedence was built for and must keep doing: a card
  // sitting idle with something loaded points at what will print next, not at
  // what it last finished.
  for (const state of ["standby", "complete", "cancelled", "idle"]) {
    assert.equal(stem({ state, filename: "old-job.gcode", queuedFile: staged }), staged.name,
      `state ${state} must still prefer the staged file`);
  }
});

test("a staged file still mid-upload never wins", () => {
  // Only status:"ready" was ever the trigger; an in-flight upload has nothing
  // to show yet.
  assert.equal(stem({ state: "standby", filename: "old.gcode", queuedFile: { name: "x.gcode", status: "uploading" } }),
    "old.gcode");
});

test("with nothing staged the printer's own file is used in every state", () => {
  for (const state of ["printing", "standby", "complete", "paused"]) {
    assert.equal(stem({ state, filename: RUNNING }), RUNNING);
    assert.equal(stem({ state, filename: RUNNING, queuedFile: null }), RUNNING);
  }
});

test("nothing at all is an empty stem, not undefined", () => {
  // The callers test it for truthiness to decide whether to render a
  // thumbnail cell at all.
  assert.equal(stem({ state: "standby" }), "");
  assert.equal(stem({}), "");
  assert.equal(stem(null), "");
});

test("a printing printer with no filename falls back to the staged name", () => {
  // Briefly true at print start, before print_stats catches up — showing
  // nothing there would be a worse answer than showing what was staged.
  assert.equal(stem({ state: "printing", filename: "", queuedFile: staged }), staged.name);
});

// ---- every site resolves it the same way ----

test("no call site still inlines the old precedence", () => {
  // Five copies drifted into one bug; the point of the helper is that they
  // cannot disagree again.
  assert.doesNotMatch(appSrc, /queuedReady\?queuedReady\.name:\(p\.filename\|\|""\)/,
    "the inlined rule must be gone");
  assert.doesNotMatch(appSrc, /const name=queuedReady\|\|p\.filename;/,
    "including the enlarge-thumbnail dialog's copy");
});

test("the card, the list view and the enlarged thumbnail all use the helper", () => {
  const uses = appSrc.match(/cardFileStem\(p\)/g) || [];
  assert.ok(uses.length >= 5, `expected every file-name slot to share it, found ${uses.length}`);
});

test("cardSignature resolves it through the helper too", () => {
  // Otherwise the card would not repaint when the running job changes.
  const at = appSrc.indexOf("function cardSignature(");
  const body = appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
  assert.match(body, /cardFileStem\(p\)/);
});
