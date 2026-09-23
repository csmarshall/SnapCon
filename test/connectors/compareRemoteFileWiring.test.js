// test/connectors/compareRemoteFileWiring.test.js — a capability that exists
// in the shared layer but is never exported from a connector does nothing.
//
// This is the bug this file was written for. compareRemoteFile() was
// implemented in http-utils and unit-tested there, the server guarded its call
// with `if (!c.compareRemoteFile) return false`, and every unit test passed —
// but no connector re-exported it, so the guard declined every single time and
// SnapCon uploaded a 6,379,213-byte file it had just proven was already on the
// printer. Caught only by an end-to-end run against real hardware.
//
// The same shape as the /api/printer-files bug that test/connectorCoreMethods
// documents: an optional method politely guarded at the call site, and absent
// at the other end.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("../../connectors/http-utils");

// Every connector that stores files through the shared Moonraker layer: if it
// lists files with http.listFiles, it talks to a Moonraker that can also serve
// Range reads, so it can answer "do you already have this?".
const MOONRAKER_FILE_CONNECTORS = [
  "snapmaker-u1-klipper",
  "snapmaker-u1-klipper-ws",
  "klipper-moonraker",
  "creality-klipper",
];

for (const name of MOONRAKER_FILE_CONNECTORS) {
  test(`${name}: exports compareRemoteFile`, () => {
    const mod = require("../../connectors/" + name);
    assert.equal(typeof mod.compareRemoteFile, "function",
      `${name} lists files through the shared Moonraker layer, so it must also be able to compare one`);
  });

  test(`${name}: it is the shared implementation, not a divergent copy`, () => {
    const mod = require("../../connectors/" + name);
    assert.equal(mod.compareRemoteFile, http.compareRemoteFile,
      "a second implementation would be a second set of identity rules");
  });
}

test("a connector that lists files through http-utils also compares through it", () => {
  // Guards the omission directly rather than by list maintenance: any
  // connector wired to the shared listFiles must be wired to the shared
  // compareRemoteFile too, or a skip decision silently never happens for it.
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "..", "connectors");
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const usesShared = /exports\.listFiles\s*=\s*(http|base)\.listFiles/.test(src);
    if (!usesShared) continue;
    assert.match(src, /exports\.compareRemoteFile\s*=\s*(http|base)\.compareRemoteFile/,
      `${f} uses the shared listFiles but not the shared compareRemoteFile`);
  }
});

test("connectors with their own file protocol are not required to have it", () => {
  // Bambu and FlashForge-native speak different file APIs; the server's
  // `if (!c.compareRemoteFile)` guard is what lets them fall through to a
  // normal upload, so they must NOT be forced to fake one.
  for (const name of ["bambu-lab", "dummy-simulator"]) {
    const mod = require("../../connectors/" + name);
    assert.notEqual(typeof mod.compareRemoteFile, "function",
      `${name} has no Moonraker file layer and must not claim the capability`);
  }
});
