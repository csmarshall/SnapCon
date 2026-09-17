// test/connectors/u1-material-capability.test.js — the setMaterial capability
// and its data must travel together, and must not appear on connectors whose
// printers have no such command.
//
// Both U1 connectors matter here: every real U1 in a fleet uses the WebSocket
// variant, which delegates all non-probe work to the HTTP one. A capability
// declared on the base connector but not re-exported by -ws would show the UI
// a picker on no printer at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const REGISTRY = require("../../connectors");

const u1 = require("../../connectors/snapmaker-u1-klipper");
const u1ws = require("../../connectors/snapmaker-u1-klipper-ws");

test("setMaterial is declared on both U1 connectors", () => {
  assert.equal(u1.capabilities.setMaterial, true);
  assert.equal(u1ws.capabilities.setMaterial, true);
});

test("the WS connector re-exports the material table and lookup, not just the capability", () => {
  // A capability with no data behind it renders an empty picker.
  assert.equal(u1ws.filamentMaterials, u1.filamentMaterials);
  assert.equal(u1ws.findFilamentMaterial, u1.findFilamentMaterial);
});

test("no other connector claims setMaterial", () => {
  // U1-only for now, by explicit decision — a connector that starts
  // supporting materials must add the table and the write, not just the flag.
  for (const [type, mod] of Object.entries(REGISTRY.REGISTRY || {})) {
    if (type.startsWith("snapmaker-u1")) continue;
    const caps = (mod && mod.capabilities) || {};
    assert.notEqual(caps.setMaterial, true, `${type} must not declare setMaterial`);
  }
});

test("every connector declaring setMaterial actually ships a material table and lookup", () => {
  for (const [type, mod] of Object.entries(REGISTRY.REGISTRY || {})) {
    if (!mod || mod.capabilities?.setMaterial !== true) continue;
    assert.ok(Array.isArray(mod.filamentMaterials) && mod.filamentMaterials.length,
      `${type} declares setMaterial but ships no filamentMaterials`);
    assert.equal(typeof mod.findFilamentMaterial, "function",
      `${type} declares setMaterial but has no findFilamentMaterial guard`);
  }
});
