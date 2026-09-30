// test/sendModalPreselect.test.js — which printers the Send modal ticks for you.
//
// Reported live: a file sliced for one printer family opened the modal with
// every idle printer ticked, Crealitys and Bambu included. renderSendList
// already computed `incompatible` one line above the checkbox but used it
// only to STYLE the printer's name. The checkbox itself asked only "is it
// idle?".
//
// The subtlety is the third state, "can't tell": a file whose printer cannot
// be detected, or a printer whose brand is user-typed (generic Klipper
// carrying "Voron", which detection can never return). Requiring a positive
// match would open the modal with NOTHING ticked in those cases — worse than
// the bug. Only a known mismatch may untick (isSendMismatch, backed by
// public/printer-identity.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// The checkbox line as rendered, so the assertions are about what ships.
const row = (() => {
  const at = appSrc.indexOf('class="send-chk checkbox-input"');
  assert.ok(at > 0, "the send row checkbox must exist");
  return appSrc.slice(appSrc.lastIndexOf("<input", at), appSrc.indexOf(">", at) + 1);
})();

test("a known-incompatible printer is not ticked for you", () => {
  assert.match(row, /!incompatible/, "the computed incompatibility must reach the checkbox");
});

test("idleness and blocking still gate it", () => {
  assert.match(row, /idle/);
  assert.match(row, /!blocked/);
  assert.match(row, /\$\{blocked\?'disabled':''\}/, "a blocked row stays disabled, not merely unticked");
});

// ---- what counts as a known mismatch ----
// Run the real functions from app.js against the shared printer-identity
// module, so these are about behaviour, not about how the line is spelled.
const vm = require("node:vm");
const PI = require("../public/printer-identity.js");
function extractFn(name) {
  const start = appSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in public/app.js");
  return appSrc.slice(start, appSrc.indexOf("\n}", start) + 2);
}
const sandbox = { PrinterIdentity: PI, String,
  CONNECTOR_TYPES: ["SnapMaker", "FlashForge", "Creality", "Bambu Lab", "Klipper"].map(brand => ({ brand })) };
vm.createContext(sandbox);
for (const fn of ["isKnownConnectorBrand", "sendMatch", "isSendMismatch"]) vm.runInContext(extractFn(fn), sandbox);
const mismatch = (p, fid) => vm.runInContext("isSendMismatch", sandbox)(p, fid);
const BRANDS = sandbox.CONNECTOR_TYPES.map(c => c.brand);
const V3PLUS_FILE = PI.identifyFile({ printerModel: "Creality Ender-3 V3 Plus" }, BRANDS);

test("the row's incompatibility is the shared known-mismatch test", () => {
  const at = appSrc.indexOf("const incompatible=");
  assert.ok(at > 0);
  assert.match(appSrc.slice(at, appSrc.indexOf("\n", at)), /isSendMismatch\(p,fid\)/);
});

test("an undetectable file still pre-selects every idle printer", () => {
  // The property that keeps the pre-selection from emptying the modal: "can't
  // tell" never unticks.
  const noInfo = PI.identifyFile({}, BRANDS);
  assert.equal(mismatch({ brand: "Creality", printerFamily: "creality-sparkx-i7" }, noInfo), false);
  assert.equal(mismatch({ brand: "SnapMaker" }, null), false);
});

test("a user-typed brand is never a mismatch", () => {
  assert.equal(mismatch({ brand: "Voron" }, V3PLUS_FILE), false);
});

test("another brand, or a confidently different model, is a known mismatch", () => {
  assert.equal(mismatch({ brand: "SnapMaker", printerFamily: "snapmaker-u1" }, V3PLUS_FILE), true);
  // The case brand-only checks let through: K1C/HollowLog is a V3 Plus file.
  assert.equal(mismatch({ brand: "Creality", printerFamily: "creality-sparkx-i7" }, V3PLUS_FILE), true);
  assert.equal(mismatch({ brand: "Creality", printerFamily: "creality-ender3-v3-plus" }, V3PLUS_FILE), false);
});

test("a model that is only 'likely' warns but does not untick", () => {
  const likelyK1 = PI.identifyFile({ printerModel: "Generic Klipper Printer", printerSettingsId: "Creality@K1" }, BRANDS);
  assert.equal(likelyK1.confidence, "medium");
  assert.equal(mismatch({ brand: "Creality", printerFamily: "creality-sparkx-i7" }, likelyK1), false);
  // …and the warning itself is raised by sendIssuesFor.
  assert.match(extractFn("sendIssuesFor"), /issue_other_model_likely/);
});

test("the incompatible name styling is kept, not replaced by the tick", () => {
  // Unticking says "not chosen"; the styling still says WHY.
  assert.match(appSrc, /send-name\$\{incompatible\?' incompatible':''\}/);
});
