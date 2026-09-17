// test/connectors/u1-filament-material.test.js — the U1's per-slot filament
// MATERIAL write (vendor/type/sub-type), alongside the colour write that
// already shared the same firmware command.
//
// Everything asserted here about the firmware's own contract was taken from
// Snapmaker/u1-klipper's klippy/extras/print_task_config.py
// (cmd_SET_PRINT_FILAMENT_CONFIG) and then confirmed against a live U1:
//
//   - the parameters are VENDOR / FILAMENT_TYPE / FILAMENT_SUBTYPE — NOT the
//     filament_vendor / filament_sub_type spellings the STATUS fields use.
//     Getting this wrong is not a silent no-op: the firmware raises a gcode
//     error, which the U1's touchscreen surfaces as "System Anomaly".
//   - if FILAMENT_TYPE is given, VENDOR and FILAMENT_SUBTYPE are MANDATORY
//     ("filament_config, incomplete parameters" otherwise), so the three are
//     always written as one group.
//   - colour and material are separate branches of the same command, so both
//     can be written in a single call — which matters, because every accepted
//     call also runs FLOW_RESET_K on that extruder. One call, one reset.
const test = require("node:test");
const assert = require("node:assert/strict");
const conn = require("../../connectors/snapmaker-u1-klipper");

function withMockFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}
const scriptOf = url => decodeURIComponent(new URL(url).searchParams.get("script"));

// A printer whose slot 0 holds an editable, non-RFID Generic PLA spool —
// the shape every U1 in the test fleet actually reports.
function statusJson(over) {
  const s = Object.assign({
    state: "standby",
    vendor: ["Generic", "Generic", "Generic", "NONE"],
    type: ["PLA", "PLA", "PLA", "NONE"],
    subType: ["", "", "", "NONE"],
    rgba: ["6F4C2FFF", "2D9E59FF", "E0E0E0FF", "FFFFFFFF"],
    exist: [true, true, true, false],
    edit: [true, true, true, false],
  }, over || {});
  return {
    result: {
      status: {
        print_stats: { state: s.state },
        print_task_config: {
          filament_vendor: s.vendor, filament_type: s.type, filament_sub_type: s.subType,
          filament_color_rgba: s.rgba, filament_exist: s.exist, filament_edit: s.edit,
        },
      },
    },
  };
}

// Answers the pre-flight query, records the gcode, then answers the read-back
// with whatever the printer should now report.
function mockPrinter({ before, after }) {
  const sent = [];
  const handler = async (url) => {
    const u = String(url);
    if (u.includes("/printer/gcode/script")) {
      sent.push(scriptOf(u));
      return { ok: true, status: 200, text: async () => "" };
    }
    const body = sent.length ? (after || before) : before;
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  return { sent, handler };
}

const P = { url: "http://127.0.0.1:1" };

// ---- The material table itself ----

test("filamentMaterials: exposes the printer's own tuned filament list", () => {
  const list = conn.filamentMaterials;
  assert.ok(Array.isArray(list), "filamentMaterials must be an array");
  assert.equal(list.length, 41, "41 tuned filaments were captured from the printer's FILAMENT_PARA_GET_ALL_INFO");
  for (const m of list) {
    assert.equal(typeof m.vendor, "string");
    assert.equal(typeof m.type, "string");
    assert.equal(typeof m.subType, "string");
    assert.ok(m.vendor && m.type, "vendor and type are never empty — only subType may be");
  }
});

test("filamentMaterials: the lookup wildcard never leaks into a written value", () => {
  // The firmware's parameter TABLE uses a lowercase `generic` token meaning
  // "any vendor"/"any sub-type" (print_task_config's _search_filament_param_
  // value, default_fill='generic'). The values actually STORED on a slot use
  // "Generic" and "" instead — confirmed against 16 live printers. Shipping
  // the raw table token would write a value no printer ever writes itself.
  for (const m of conn.filamentMaterials) {
    assert.notEqual(m.vendor, "generic", "vendor wildcard must be written as 'Generic'");
    assert.notEqual(m.subType, "generic", "sub-type wildcard must be written as ''");
  }
});

test("filamentMaterials: contains the triples observed on real printers", () => {
  // Each of these was read back off a live U1's print_task_config. The
  // Polymaker one is the load-bearing case: it is human-set (not RFID), so it
  // proves the table key -> stored value mapping for a non-generic vendor.
  const want = [
    { vendor: "Generic", type: "PLA", subType: "" },
    { vendor: "Polymaker", type: "PLA", subType: "PolyTerra" },
    { vendor: "Snapmaker", type: "PLA", subType: "Silk" },
    { vendor: "Snapmaker", type: "PLA", subType: "SnapSpeed" },
  ];
  for (const w of want) {
    assert.ok(
      conn.filamentMaterials.some(m => m.vendor === w.vendor && m.type === w.type && m.subType === w.subType),
      `missing observed material ${w.vendor}/${w.type}/${w.subType || '""'}`
    );
  }
});

test("findFilamentMaterial: resolves to the table's OWN entry, not the caller's strings", () => {
  const got = conn.findFilamentMaterial({ vendor: "Generic", type: "PLA", subType: "" });
  assert.ok(got);
  assert.ok(conn.filamentMaterials.includes(got), "must return the table entry itself");
  assert.equal(conn.findFilamentMaterial({ vendor: "Generic", type: "Unobtainium", subType: "" }), null);
  assert.equal(conn.findFilamentMaterial(null), null);
});

// ---- Writing a material ----

test("setFilamentColor: a material write uses VENDOR/FILAMENT_TYPE/FILAMENT_SUBTYPE together", async () => {
  const { sent, handler } = mockPrinter({
    before: statusJson(),
    after: statusJson({ type: ["PETG", "PLA", "PLA", "NONE"], rgba: ["112233FF", "2D9E59FF", "E0E0E0FF", "FFFFFFFF"] }),
  });
  await withMockFetch(handler, () =>
    conn.setFilamentColor(P, 0, "#112233", { material: { vendor: "Generic", type: "PETG", subType: "" } }));

  assert.equal(sent.length, 1, "colour and material go out as ONE command — one FLOW_RESET_K");
  const cmd = sent[0];
  assert.match(cmd, /^SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER='0' /);
  assert.match(cmd, /VENDOR='Generic'/);
  assert.match(cmd, /FILAMENT_TYPE='PETG'/);
  assert.match(cmd, /FILAMENT_SUBTYPE=''/);
  assert.match(cmd, /FILAMENT_COLOR_RGBA='112233FF'/);
  // The status-field spellings are the ones that got rejected on real
  // hardware; make sure neither can creep back in.
  assert.doesNotMatch(cmd, /FILAMENT_VENDOR=/);
  assert.doesNotMatch(cmd, /FILAMENT_SUB_TYPE=/);
});

test("setFilamentColor: a colour-only call sends no material parameters at all", async () => {
  const { sent, handler } = mockPrinter({
    before: statusJson(),
    after: statusJson({ rgba: ["112233FF", "2D9E59FF", "E0E0E0FF", "FFFFFFFF"] }),
  });
  await withMockFetch(handler, () => conn.setFilamentColor(P, 0, "#112233"));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /FILAMENT_COLOR_RGBA='112233FF'/);
  assert.doesNotMatch(sent[0], /VENDOR=/);
  assert.doesNotMatch(sent[0], /FILAMENT_TYPE=/);
  assert.doesNotMatch(sent[0], /FILAMENT_SUBTYPE=/);
});

test("setFilamentColor: a material outside the printer's table is refused before anything is sent", async () => {
  const { sent, handler } = mockPrinter({ before: statusJson() });
  await withMockFetch(handler, async () => {
    await assert.rejects(
      () => conn.setFilamentColor(P, 0, "#112233", { material: { vendor: "Acme", type: "PLA", subType: "" } }),
      /not a filament this printer has settings for/i
    );
  });
  assert.equal(sent.length, 0, "nothing may reach the printer");
});

test("setFilamentColor: caller strings are never interpolated — only table entries are", async () => {
  // The firmware does NO validation of these values, and they land in a gcode
  // line, so the write must be built from the matched table entry rather than
  // from whatever the caller passed (CLAUDE.md section 8: values interpolated
  // into G-code are a trust boundary).
  const { sent, handler } = mockPrinter({ before: statusJson() });
  await withMockFetch(handler, async () => {
    await assert.rejects(() => conn.setFilamentColor(P, 0, "#112233", {
      material: { vendor: "Generic", type: "PLA' FORCE=1 X='", subType: "" },
    }), /not a filament this printer has settings for/i);
  });
  assert.equal(sent.length, 0);
});

test("setFilamentColor: read-back must confirm the material, not just the colour", async () => {
  const { handler } = mockPrinter({
    before: statusJson(),
    // Colour lands, material silently does not.
    after: statusJson({ rgba: ["112233FF", "2D9E59FF", "E0E0E0FF", "FFFFFFFF"] }),
  });
  await withMockFetch(handler, async () => {
    await assert.rejects(
      () => conn.setFilamentColor(P, 0, "#112233", { material: { vendor: "Generic", type: "PETG", subType: "" } }),
      /not confirmed/i
    );
  });
});

test("setFilamentColor: a slot that reports no material at all says so", async () => {
  // Regression: the fallback was written as `"…reports " + parts || "nothing"`,
  // which binds as `("…reports " + parts) || "nothing"` — always truthy, so
  // the fallback was dead and an empty read-back produced a message ending in
  // a bare space.
  const { handler } = mockPrinter({
    before: statusJson(),
    after: statusJson({ vendor: ["", "", "", ""], type: ["", "", "", ""], subType: ["", "", "", ""],
      rgba: ["112233FF", "2D9E59FF", "E0E0E0FF", "FFFFFFFF"] }),
  });
  await withMockFetch(handler, async () => {
    await assert.rejects(
      () => conn.setFilamentColor(P, 0, "#112233", { material: { vendor: "Generic", type: "PETG", subType: "" } }),
      e => {
        assert.match(e.message, /printer reports nothing$/);
        return true;
      }
    );
  });
});

test("setFilamentColor: existing safety refusals still apply to a material write", async () => {
  for (const [label, over, re] of [
    ["printing", { state: "printing" }, /can only be changed while idle/i],
    ["empty slot", { exist: [false, true, true, false] }, /no filament loaded/i],
    ["RFID spool", { edit: [false, true, true, false] }, /RFID/i],
  ]) {
    const { sent, handler } = mockPrinter({ before: statusJson(over) });
    await withMockFetch(handler, async () => {
      await assert.rejects(
        () => conn.setFilamentColor(P, 0, "#112233", { material: { vendor: "Generic", type: "PETG", subType: "" } }),
        re, `${label} must still refuse`
      );
    });
    assert.equal(sent.length, 0, `${label}: nothing may reach the printer`);
  }
});
