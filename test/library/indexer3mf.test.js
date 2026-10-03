// test/library/indexer3mf.test.js — M3 end to end: 3MFs in a real location,
// read through netfs and the Library worker, into Projects, Plates and
// Variants; printer Claims only on printable plates; lineage Claims only where
// the evidence supports them; and nothing of M4 (no Models, no member_of).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibraryService, GCODE_ROOT } = require("../../library/LibraryService");
const { createNetFs } = require("../../netfs/NetFs");
const { build3mf, PNG } = require("./helpers/zip");
const { gcodeFile } = require("./helpers/gcode");

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-3mf-"));
const put = (dir, rel, data) => { const p = path.join(dir, ...rel.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };

async function make(t, files, svc = {}) {
  const base = tmp();
  const gcode = path.join(base, "gcode");
  fs.mkdirSync(gcode);
  for (const [rel, data] of Object.entries(files)) put(gcode, rel, data);
  const nf = createNetFs({ log: quiet, opTimeoutMs: 5000, probeEveryMs: 60000 });
  const lib = createLibraryService({ baseDir: base, getGcodeFolder: () => gcode, log: quiet, netfs: nf, scanBudget: 1024 * 1024 * 1024, workerOptions: { log: quiet }, ...svc });
  t.after(async () => { await lib.stop(); await nf.stop(); });
  lib.start();
  return { lib, gcode };
}
// The first scan, and the full hash and lineage that follow it.
async function settle(lib) {
  for (let i = 0; i < 800; i++) {
    const s = lib.scanReport().scans[GCODE_ROOT];
    if (s && s.finishedAt) { await lib._idle(); return lib.scanReport(); }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("no scan");
}
const fileOf = (lib, rel) => lib.diagnosticsRaw({}).files.find(f => f.path === rel);

const MAKERWORLD = { Title: "Keyrambit", Designer: "TR10_", License: "BY-NC-SA", DesignModelId: "USec11953facc500", DesignProfileId: "808246553",
  ProfileTitle: "With PLA supports", ProfileUserName: "TR10_" };

test("sliced, unsliced and multi-plate 3MFs become Projects, Plates and printable Variants — and only printable plates get a printer Claim", async t => {
  const big = build3mf({ application: "BambuStudio-2.3.5", modelExtraBytes: 3 * 1024 * 1024,
    settings: { printer_model: "Snapmaker U1", printer_settings_id: "PixelPrints U1 (0.4mm)", print_compatible_printers: ["Snapmaker U1 (0.4 nozzle)"], version: "2.3.5", filament_type: ["PLA", "PLA"], filament_colour: ["#FFFFFF", "#000000"] },
    plates: [{ no: 1, objects: ["1"] }, { no: 2, objects: ["1"] }] });
  const { lib } = await make(t, {
    "Bambu/ams.gcode.3mf": build3mf({ metadata: MAKERWORLD, objects: [], plates: [{ no: 1, sliced: true, printerModelId: "N7", sliceObjects: ["Keyrambit rivals main.stl"] }],
      aux: [{ name: "Auxiliaries/Model Pictures/1.png", data: PNG }, { name: "Auxiliaries/Profile Pictures/notes.pdf", data: Buffer.from("%PDF-1.4") }] }),
    "U1/santa.3mf": big,
    "mixed.3mf": build3mf({ objects: [{ id: "1", name: "A.stl", parts: [] }], plates: [{ no: 1, objects: ["1"] }, { no: 2, objects: ["1"], sliced: true, printerModelId: "N7" }, { no: 3 }] }),
  });
  const rep = await settle(lib);
  assert.equal(rep.scans.gcode.threemf, 3);

  const ams = fileOf(lib, "Bambu/ams.gcode.3mf");
  assert.equal(ams.role, "sliced");
  assert.equal(ams.threemf.flavour, "bambu");
  assert.equal(ams.threemf.title, "Keyrambit");
  assert.deepEqual({ ...ams.threemf.externalIds, DesignRegion: undefined, DesignerUserId: undefined, ProfileUserId: undefined }, { DesignModelId: "USec11953facc500", DesignProfileId: "808246553", DesignRegion: undefined, DesignerUserId: undefined, ProfileUserId: undefined });
  assert.equal(ams.threemf.profileUserName, "TR10_");
  const plate = ams.threemf.plates[0];
  assert.equal(plate.printable, true);
  assert.equal(plate.variant.printer.family, "bambu-p2s");
  assert.equal(plate.variant.printer.confidence, "high");
  assert.equal(plate.variant.printer.state, "applied");
  const idEv = plate.variant.printer.evidence.find(e => e.signal === "printer_model_id");
  assert.equal(idEv.source, "3mf:Metadata/slice_info.config");
  assert.equal(idEv.group, "identity");
  assert.deepEqual(ams.threemf.entries.map(e => [e.entry, e.role]).sort(), [["Auxiliaries/Model Pictures/1.png", "image"], ["Auxiliaries/Profile Pictures/notes.pdf", "document"]]);
  assert.ok(ams.threemf.entries.find(e => e.role === "image").thumb, "a small picture becomes a thumbnail");
  assert.ok(ams.thumb);
  assert.deepEqual([ams.printer.family, ams.printer.state, ams.printer.plate], ["bambu-p2s", "applied", 1], "the file-level summary is its printable plate's Claim");

  const santa = fileOf(lib, "U1/santa.3mf");
  assert.equal(santa.role, "project");
  assert.equal(santa.threemf.flavour, "snapmaker_orca");
  assert.equal(santa.threemf.plates.length, 2);
  assert.ok(santa.threemf.plates.every(p => !p.printable && !p.variant));
  assert.equal(santa.printer.state, "not printable");
  assert.equal(santa.threemf.configuredPrinter.family, "snapmaker-u1", "what the project is set up for, shown as such");
  assert.ok(santa.threemf.read.bytes < santa.size / 4, `read ${santa.threemf.read.bytes} of ${santa.size}`);

  const mixed = fileOf(lib, "mixed.3mf");
  assert.equal(mixed.role, "sliced", "sliced by content: one plate's G-code is inside");
  assert.deepEqual(mixed.threemf.plates.map(p => [p.plate, p.printable, !!p.variant]), [[1, false, false], [2, true, true], [3, false, false]]);

  const db = lib._store.db;
  const tp = db.prepare("SELECT subject_key FROM claims WHERE relation = 'targets_printer'").all().map(r => r.subject_key);
  assert.ok(tp.every(k => /#\d+$/.test(k)), "printer Claims on plates (content key#plate) only");
  assert.equal(tp.length, 2, "one for each printable plate, none for unsliced projects");
  assert.equal(db.prepare("SELECT count(*) AS n FROM projects").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM variants").get().n, 2);
  // M4's territory stays untouched.
  assert.equal(db.prepare("SELECT count(*) AS n FROM models").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM claims WHERE relation IN ('member_of', 'same_model_as')").get().n, 0);
});

test("a malformed 3MF is an unreadable file, and the scan goes on", async t => {
  const good = build3mf({});
  const broken = Buffer.from(good); broken.writeUInt32LE(broken.length + 999, broken.length - 6);   // central directory points outside
  const { lib } = await make(t, { "good.3mf": good, "broken.3mf": broken, "notzip.3mf": Buffer.from("plain text") });
  const rep = await settle(lib);
  assert.equal(rep.scans.gcode.outcome, "ok");
  assert.equal(fileOf(lib, "good.3mf").state, "present");
  for (const p of ["broken.3mf", "notzip.3mf"]) {
    const f = fileOf(lib, p);
    assert.equal(f.state, "unreadable", p);
    assert.match(f.error, /^ZIP_/, p);
  }
});

test("lineage: a G-code byte-identical to a plate's G-code is sliced_from that project, exactly", async t => {
  const g = gcodeFile({ printerModel: "Bambu Lab P2S", objects: [["Keyrambit.stl", 1]] }).toString("utf8");
  const { lib } = await make(t, {
    "ams.gcode.3mf": build3mf({ objects: [], plates: [{ no: 1, sliced: true, printerModelId: "N7", gcode: g }] }),
    "exported/plate_1.gcode": g,
  });
  await settle(lib);
  for (let i = 0; i < 200 && !fileOf(lib, "exported/plate_1.gcode").fullHash; i++) await new Promise(r => setTimeout(r, 25));
  await lib._idle();
  const gf = fileOf(lib, "exported/plate_1.gcode");
  const l = gf.lineage.find(x => x.relation === "sliced_from");
  assert.ok(l, JSON.stringify(gf.lineage));
  assert.deepEqual([l.method, l.confidence, l.state, l.direction, l.other], ["plate_md5", "exact", "applied", "out", ["gcode:ams.gcode.3mf"]]);
  assert.equal(l.evidence[0].source, "3mf:Metadata/plate_1.gcode.md5");
});

test("lineage: same object names as one project's plate is a suggestion; as two projects', recorded ambiguity", async t => {
  const proj = () => build3mf({ objects: [{ id: "1", name: "Dragon_Body.stl", parts: [{ name: "Dragon_Body.stl" }] }], plates: [{ no: 1, objects: ["1"] }] });
  const g = gcodeFile({ printerModel: "Snapmaker U1", objects: [["Dragon_Body.stl", 2]] });
  const one = await make(t, { "projects/dragon.3mf": proj(), "dragon (2x).gcode": g });
  await settle(one.lib);
  const l1 = fileOf(one.lib, "dragon (2x).gcode").lineage.filter(x => x.relation === "sliced_from");
  assert.deepEqual(l1.map(x => [x.method, x.confidence, x.state]), [["object_names", "medium", "suggested"]]);

  const two = await make(t, { "projects/dragon.3mf": proj(), "projects/dragon copy.3mf": build3mf({ metadata: { Title: "copy" }, objects: [{ id: "1", name: "Dragon_Body.stl", parts: [] }], plates: [{ no: 1, objects: ["1"] }] }), "dragon (2x).gcode": g });
  await settle(two.lib);
  const l2 = fileOf(two.lib, "dragon (2x).gcode").lineage.filter(x => x.relation === "sliced_from");
  assert.equal(l2.length, 2);
  assert.ok(l2.every(x => x.confidence === "low" && x.state === "recorded"), "ties never share credit");
});

test("lineage: a source_file naming exactly one indexed file is source_of it; a generic object name is never matched", async t => {
  const { lib } = await make(t, {
    "Dragon_Body.stl": "solid d\nendsolid d\n",
    "dragon.3mf": build3mf({ objects: [{ id: "1", name: "Dragon", parts: [{ name: "Dragon_Body.stl", sourceFile: "C:\\Users\\x\\Downloads\\Dragon_Body.stl" }] }] }),
    "dragon.gcode": gcodeFile({ printerModel: "Snapmaker U1", objects: [["Dragon_Body.stl", 1], ["Assembly", 1]] }),
    "Assembly.stl": "solid a\nendsolid a\n",
  });
  await settle(lib);
  const stl = fileOf(lib, "Dragon_Body.stl");
  const out = stl.lineage.filter(x => x.relation === "source_of");
  assert.ok(out.some(x => x.method === "source_file_meta" && x.confidence === "high" && x.state === "applied" && x.other[0] === "gcode:dragon.3mf"), JSON.stringify(out));
  assert.ok(out.some(x => x.method === "object_name=mesh_basename" && x.confidence === "medium" && x.state === "suggested"));
  const asm = fileOf(lib, "Assembly.stl");
  assert.equal(asm.lineage.length, 0, "\"Assembly\" is generic: never Evidence");
});

test("lineage: a common test print (3DBenchy) in a project and a G-code is no evidence they are related", async t => {
  const { lib } = await make(t, {
    "Bambu/benchy.3mf": build3mf({ settings: { printer_model: "Bambu Lab A1 mini" }, objects: [{ id: "1", name: "3DBenchy", parts: [{ name: "3DBenchy" }] }], plates: [{ no: 1, objects: ["1"] }] }),
    "U1/3DBenchy_PLA_51m47s.gcode": gcodeFile({ printerModel: "Snapmaker U1", objects: [["3DBenchy", 1]] }),
  });
  await settle(lib);
  assert.deepEqual(fileOf(lib, "U1/3DBenchy_PLA_51m47s.gcode").lineage, []);
});
