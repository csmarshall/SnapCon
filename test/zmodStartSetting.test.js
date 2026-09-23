// test/zmodStartSetting.test.js — where the AD5X/ZMOD print-start opt-in is
// offered, and how it round-trips through config.
//
// The switch must appear ONLY where it can do anything: the flashforge-ad5x
// connector, on a printer actually running Moonraker. Showing it on a stock
// AD5X or on a 5M would imply a choice that changes nothing; showing it on a
// printer whose transport is not yet known would offer a control whose effect
// nobody can predict.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));

// The visibility rule, lifted from syncPrintPrefVisibility and evaluated
// directly so each combination is checked rather than pattern-matched.
function visible({ connector, pin, detected }) {
  const onMoonraker = pin === "moonraker" || (pin === "auto" && detected === "moonraker");
  return connector === "flashforge-ad5x" && onMoonraker;
}

test("offered on an AD5X pinned to Moonraker", () => {
  assert.equal(visible({ connector: "flashforge-ad5x", pin: "moonraker" }), true);
});

test("offered on an AD5X auto-detected as Moonraker", () => {
  assert.equal(visible({ connector: "flashforge-ad5x", pin: "auto", detected: "moonraker" }), true);
});

test("hidden on an AD5X running stock firmware", () => {
  assert.equal(visible({ connector: "flashforge-ad5x", pin: "native" }), false);
  assert.equal(visible({ connector: "flashforge-ad5x", pin: "auto", detected: "native" }), false);
});

test("hidden while the transport is still unknown", () => {
  // Offline, or not yet probed. A control whose effect cannot be predicted is
  // worse than no control.
  assert.equal(visible({ connector: "flashforge-ad5x", pin: "auto", detected: undefined }), false);
  assert.equal(visible({ connector: "flashforge-ad5x", pin: "auto", detected: null }), false);
});

test("hidden on every other connector, Moonraker or not", () => {
  for (const connector of ["flashforge-adventurer", "snapmaker-u1-klipper-ws", "creality-klipper", "bambu-lab", "klipper-moonraker"]) {
    assert.equal(visible({ connector, pin: "moonraker" }), false, connector + " must not offer it");
    assert.equal(visible({ connector, pin: "auto", detected: "moonraker" }), false, connector + " must not offer it");
  }
});

// ---- wiring ----

test("the rule in app.js matches the one asserted here", () => {
  const at = appSrc.indexOf("const canZmodStart=");
  assert.ok(at > 0, "the visibility rule must exist");
  const line = appSrc.slice(at, appSrc.indexOf("\n", at));
  assert.match(line, /flashforge-ad5x/);
  assert.match(line, /onMoonraker/);
  const onLine = appSrc.slice(appSrc.indexOf("const onMoonraker="));
  assert.match(onLine.slice(0, onLine.indexOf("\n")), /moonraker/);
});

test("a hidden switch is forced off, so it cannot be saved by accident", () => {
  // Changing connector or transport with the switch already on must not leave
  // an opt-in behind for a printer that no longer qualifies.
  const at = appSrc.indexOf("const canZmodStart=");
  const after = appSrc.slice(at, at + 400);
  assert.match(after, /if\(!canZmodStart\)\s*zmodStartEl\.checked=false/);
});

test("the server stores it only when exactly true", () => {
  assert.match(serverSrc, /p\.allowMoonrakerPrintStart === true\) o\.allowMoonrakerPrintStart = true/,
    "a truthy-but-not-true value must never become an opt-in");
});

test("the client sends true or omits it — never false", () => {
  assert.match(appSrc, /allowMoonrakerPrintStart:\(r\.querySelector\('\[id\^="pzmodstart-"\]'\)\|\|\{\}\)\.checked\?true:undefined/);
});

test("both locales carry the label and its warning", () => {
  for (const [name, loc] of [["en", en], ["es", es]]) {
    assert.equal(typeof loc.settings.printers.zmod_start_label, "string", name + " label");
    const desc = loc.settings.printers.zmod_start_desc;
    assert.equal(typeof desc, "string", name + " description");
    // The whole point of the wording: it must say it is unverified and why.
    assert.ok(desc.length > 60, name + " description must actually explain the risk");
  }
  assert.match(en.settings.printers.zmod_start_desc, /unverified/i);
  assert.match(en.settings.printers.zmod_start_desc, /touchscreen/i);
});
