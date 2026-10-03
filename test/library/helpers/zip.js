// test/library/helpers/zip.js — builds zip archives (3MFs) for tests, in the
// shapes real writers produce: deflate and store, UTF-8 names (flag bit 11),
// Info-ZIP unicode-path extras (0x7075), data descriptors (streamed writers
// leave the local sizes zero), and zip64 with every 32-bit field saturated.
// Plus build3mf(): a Bambu/Orca-family project, shaped like the owner's files.
"use strict";
const zlib = require("zlib");
const crypto = require("crypto");

const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const FF = 0xffffffff;

// entries: [{ name, data, deflate = true, utf8 = false, unicodeName, dataDescriptor = false }]
function buildZip(entries, { zip64 = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const method = e.deflate === false ? 0 : 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, e.utf8 ? "utf8" : "latin1");
    const crc = zlib.crc32(data);
    const flags = (e.utf8 ? 0x800 : 0) | (e.dataDescriptor ? 0x8 : 0);
    const localSizes = e.dataDescriptor ? [0, 0, 0] : zip64 ? [crc, FF, FF] : [crc, comp.length, data.length];
    const localExtra = zip64 && !e.dataDescriptor ? Buffer.concat([u16(0x0001), u16(16), u64(data.length), u64(comp.length)]) : Buffer.alloc(0);
    const local = Buffer.concat([u32(0x04034b50), u16(zip64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x21),
      u32(localSizes[0]), u32(localSizes[1]), u32(localSizes[2]), u16(name.length), u16(localExtra.length), name, localExtra]);
    const descriptor = e.dataDescriptor ? Buffer.concat([u32(0x08074b50), u32(crc), u32(comp.length), u32(data.length)]) : Buffer.alloc(0);
    let cenExtra = zip64 ? Buffer.concat([u16(0x0001), u16(24), u64(data.length), u64(comp.length), u64(offset)]) : Buffer.alloc(0);
    if (e.unicodeName) {
      const uni = Buffer.from(e.unicodeName, "utf8");
      cenExtra = Buffer.concat([cenExtra, u16(0x7075), u16(5 + uni.length), Buffer.from([1]), u32(zlib.crc32(name)), uni]);
    }
    central.push(Buffer.concat([u32(0x02014b50), u16(zip64 ? 45 : 20), u16(zip64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x21),
      u32(crc), u32(zip64 ? FF : comp.length), u32(zip64 ? FF : data.length), u16(name.length), u16(cenExtra.length), u16(0), u16(0), u16(0), u32(0),
      u32(zip64 ? FF : offset), name, cenExtra]));
    parts.push(local, comp, descriptor);
    offset += local.length + comp.length + descriptor.length;
  }
  const cd = Buffer.concat(central);
  if (!zip64) {
    return Buffer.concat([...parts, cd, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  }
  const eocd64 = Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(entries.length), u64(entries.length), u64(cd.length), u64(offset)]);
  const locator = Buffer.concat([u32(0x07064b50), u32(0), u64(offset + cd.length), u32(1)]);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(FF), u32(FF), u16(0)]);
  return Buffer.concat([...parts, cd, eocd64, locator, eocd]);
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c30000000049454e44ae426082", "hex");
// Mesh data compresses like real meshes do, not 1000:1.
const meshLines = n => {
  const out = [];
  for (let len = 0; len < n;) { const l = `  <vertex x="${crypto.randomBytes(4).readUInt32LE() / 1e5}" y="${crypto.randomBytes(4).readUInt32LE() / 1e5}" z="${crypto.randomBytes(2).readUInt16LE() / 100}"/>\n`; out.push(l); len += l.length; }
  return out.join("");
};
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// A Bambu/Orca-family project. plates: [{ no, name, objects: [object ids],
// sliced: bool, gcode, printerModelId, filaments: [{type,color,usedG}],
// sliceObjects: [names] }]; objects: [{ id, name, parts: [{ name, sourceFile }] }].
function build3mf({
  application = "BambuStudio-02.06.00.51", metadata = {}, settings = { printer_model: "Bambu Lab P2S", printer_settings_id: "Bambu Lab P2S 0.4 nozzle",
    print_compatible_printers: ["Bambu Lab P2S 0.4 nozzle"], filament_type: ["PETG"], filament_colour: ["#000000"], layer_height: "0.2", nozzle_diameter: ["0.4"] },
  objects = [{ id: "1", name: "Dragon_Body.stl", parts: [{ name: "Dragon_Body.stl", sourceFile: "C:\\models\\Dragon_Body.stl" }] }],
  plates = [{ no: 1, name: "", objects: ["1"], sliced: false }],
  aux = [], modelExtraBytes = 0, zip64 = false, omit = [], extra = [],
} = {}) {
  const md = { Application: application, ...metadata };
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    Object.entries(md).map(([k, v]) => ` <metadata name="${esc(k)}">${esc(v)}</metadata>`).join("\n") +
    `\n <resources>\n${meshLines(modelExtraBytes)} </resources>\n</model>\n`;
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n` +
    objects.map(o => `  <object id="${o.id}">\n    <metadata key="name" value="${esc(o.name)}"/>\n` +
      o.parts.map((p, i) => `    <part id="${i + 1}" subtype="normal_part">\n      <metadata key="name" value="${esc(p.name)}"/>\n` +
        (p.sourceFile ? `      <metadata key="source_file" value="${esc(p.sourceFile)}"/>\n` : "") + `    </part>\n`).join("") + `  </object>\n`).join("") +
    plates.map(p => `  <plate>\n    <metadata key="plater_id" value="${p.no}"/>\n    <metadata key="plater_name" value="${esc(p.name || "")}"/>\n` +
      (p.sliced ? `    <metadata key="gcode_file" value="Metadata/plate_${p.no}.gcode"/>\n` : "") +
      (p.objects || []).map(id => `    <model_instance>\n      <metadata key="object_id" value="${id}"/>\n    </model_instance>\n`).join("") + `  </plate>\n`).join("") +
    `</config>\n`;
  const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Version" value="${application.split("-")[1] || ""}"/>\n  </header>\n` +
    plates.filter(p => p.sliced).map(p => `  <plate>\n    <metadata key="index" value="${p.no}"/>\n` +
      (p.printerModelId ? `    <metadata key="printer_model_id" value="${p.printerModelId}"/>\n` : "") +
      `    <metadata key="nozzle_diameters" value="0.4"/>\n    <metadata key="prediction" value="${p.prediction || 3600}"/>\n    <metadata key="weight" value="${p.weight || 12.5}"/>\n` +
      (p.sliceObjects || []).map(n => `    <object identify_id="1" name="${esc(n)}" skipped="false" />\n`).join("") +
      (p.filaments || [{ type: "PETG", color: "#000000", usedG: 12.5 }]).map((f, i) => `    <filament id="${i + 1}" tray_info_idx="GFG00" type="${f.type}" color="${f.color}" used_m="1" used_g="${f.usedG}"/>\n`).join("") +
      `  </plate>\n`).join("") + `</config>\n`;
  const entries = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types/>' },
    { name: "3D/3dmodel.model", data: model },
    { name: "Metadata/project_settings.config", data: JSON.stringify(settings) },
    { name: "Metadata/model_settings.config", data: modelSettings },
    { name: "Metadata/slice_info.config", data: sliceInfo },
  ];
  for (const p of plates) {
    entries.push({ name: `Metadata/plate_${p.no}.png`, data: PNG, deflate: false });
    entries.push({ name: `Metadata/plate_${p.no}_small.png`, data: Buffer.concat([PNG, Buffer.from([p.no])]), deflate: false });
    if (p.sliced) {
      const gcode = p.gcode || `; HEADER_BLOCK_START\n; generated by BambuStudio\n; plate ${p.no}\nG1 X1 Y1\n`;
      entries.push({ name: `Metadata/plate_${p.no}.gcode`, data: gcode });
      entries.push({ name: `Metadata/plate_${p.no}.gcode.md5`, data: crypto.createHash("md5").update(gcode).digest("hex").toUpperCase() });
    }
  }
  for (const a of aux) entries.push({ name: a.name, data: a.data, deflate: false, utf8: !!a.utf8, unicodeName: a.unicodeName });
  return buildZip([...entries.filter(e => !omit.includes(e.name)), ...extra], { zip64 });
}

module.exports = { buildZip, build3mf, PNG };
