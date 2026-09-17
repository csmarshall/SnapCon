// test/connectors/u1-head-vendor.test.js — a head must report which VENDOR's
// filament is loaded, not just the type.
//
// Without it the material picker cannot pre-select what is actually loaded:
// the printer's own tuned list contains several (type, sub-type) pairs that
// exist under more than one vendor — Generic PETG HF and Snapmaker PETG HF,
// Generic TPU 90A and Snapmaker TPU 90A — so type+sub alone is ambiguous.
//
// Both U1 connectors decode heads independently (the WS one merges deltas
// from its own subscription rather than delegating probe()), so both are
// asserted here.
const test = require("node:test");
const assert = require("node:assert/strict");

const u1 = require("../../connectors/snapmaker-u1-klipper");
const u1ws = require("../../connectors/snapmaker-u1-klipper-ws");

const PTC = {
  filament_exist: [true, true, true, false],
  filament_color_rgba: ["6F4C2FFF", "2D9E59FF", "E0E0E0FF", "FFFFFFFF"],
  filament_vendor: ["Generic", "Snapmaker", "Polymaker", "NONE"],
  filament_type: ["PETG", "PETG", "PLA", "NONE"],
  filament_sub_type: ["HF", "HF", "PolyTerra", "NONE"],
  filament_official: [false, true, false, false],
};

const decoders = [
  ["snapmaker-u1-klipper", u1._internal && u1._internal.decodeHeads],
  ["snapmaker-u1-klipper-ws", u1ws._internal && u1ws._internal.decodeHeads],
];

for (const [name, decodeHeads] of decoders) {
  test(`${name}: a loaded head reports its filament vendor`, () => {
    assert.equal(typeof decodeHeads, "function", `${name} must expose decodeHeads for tests`);
    const heads = decodeHeads(PTC);
    assert.equal(heads[0].vendor, "Generic");
    assert.equal(heads[1].vendor, "Snapmaker");
    assert.equal(heads[2].vendor, "Polymaker");
  });

  test(`${name}: the two same-named PETG HF spools are told apart by vendor alone`, () => {
    const heads = decodeHeads(PTC);
    assert.equal(heads[0].material, heads[1].material, "same type");
    assert.equal(heads[0].sub, heads[1].sub, "same sub-type");
    assert.notEqual(heads[0].vendor, heads[1].vendor, "vendor is the only thing separating them");
  });

  test(`${name}: an empty head reports no vendor rather than the printer's NONE placeholder`, () => {
    // "NONE" is the firmware's empty-slot filler, not a vendor name — the
    // same reason `sub` already maps it to null (section 2: absence of data
    // is valid state, and must not be dressed up as a real reading).
    const heads = decodeHeads(PTC);
    assert.equal(heads[3].loaded, false);
    assert.equal(heads[3].vendor, null);
  });
}
