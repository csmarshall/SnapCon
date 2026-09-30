// test/sendModalPreselect.test.js — which printers the Send modal ticks for you.
//
// Reported live: a file sliced for one printer family opened the modal with
// every idle printer ticked, Crealitys and Bambu included. renderSendList
// already computed `incompatible` one line above the checkbox — via
// isCompatiblePrinter — but used it only to STYLE the printer's name. The
// checkbox itself asked only "is it idle?".
//
// The subtlety is the third state. isCompatiblePrinter returns null for
// "can't tell": a file whose brand cannot be detected, or a printer whose
// brand is user-typed (generic Klipper carrying "Voron", which brand
// detection can never return). Requiring a positive match would open the
// modal with NOTHING ticked in those cases — worse than the bug. Only a known
// mismatch may untick.
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

test("an undetectable file still pre-selects every idle printer", () => {
  // `incompatible` is `isCompatiblePrinter(...)===false`, so null ("can't
  // tell") is falsy and leaves the row ticked. Asserted on the definition
  // rather than the row, because this is the property that keeps the fix from
  // emptying the modal.
  const at = appSrc.indexOf("const incompatible=");
  assert.ok(at > 0);
  const line = appSrc.slice(at, appSrc.indexOf("\n", at));
  assert.match(line, /isCompatiblePrinter\([^)]*\)===false/,
    "only an explicit false may untick — null means unknown");
});

test("isCompatiblePrinter still answers null when it cannot tell", () => {
  const at = appSrc.indexOf("function isCompatiblePrinter(");
  const fn = appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
  assert.match(fn, /if\s*\(\s*!detectedBrand\s*\|\|\s*!printerBrand\s*\)\s*return null;/);
  assert.match(fn, /if\s*\(\s*!isKnownConnectorBrand\(printerBrand\)\s*\)\s*return null;/);
});

test("the incompatible name styling is kept, not replaced by the tick", () => {
  // Unticking says "not chosen"; the styling still says WHY.
  assert.match(appSrc, /send-name\$\{incompatible\?' incompatible':''\}/);
});
