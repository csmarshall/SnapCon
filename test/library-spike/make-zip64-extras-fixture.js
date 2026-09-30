// test/library-spike/make-zip64-extras-fixture.js — writes
// fixtures/fixture-zip64-extras.3mf, the one fixture libarchive would not
// produce: every 32-bit size and offset saturated to 0xFFFFFFFF, with the real
// values carried in 0x0001 (zip64) extra fields, plus one entry named through
// the 0x7075 Info-ZIP unicode-path extra field. This is the layout a large
// PrusaSlicer or CLI-written 3MF uses.
//
//   node test/library-spike/make-zip64-extras-fixture.js
//
// Because this script and the reader share an author, the fixture was checked
// with two independent readers when it was made: Windows' bsdtar (libarchive)
// and .NET's Expand-Archive both extracted every entry byte-identically.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const files = [
  ["[Content_Types].xml", Buffer.from('<?xml version="1.0"?><Types/>\n')],
  ["3D/3dmodel.model", Buffer.from('<?xml version="1.0"?>\n<model><metadata name="Title">Zip64 Dragon</metadata></model>\n')],
  ["Metadata/model_settings.config", Buffer.from('<config><object id="2"><part id="1"><metadata key="source_file" value="Dragon_Body.stl"/></part></object></config>\n')],
  // Raw name is plain ASCII; the real name travels in the 0x7075 field.
  ["Auxiliaries/Model Pictures/Bild-U.webp", Buffer.from("524946461a00000057454250", "hex"), "Auxiliaries/Model Pictures/Bild-Ü.webp"],
];

const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const FF = 0xffffffff;

const parts = [], central = [];
let offset = 0;
for (const [rawName, data, unicodeName] of files) {
  const name = Buffer.from(rawName, "latin1");
  const crc = zlib.crc32(data);
  const localExtra = Buffer.concat([u16(0x0001), u16(16), u64(data.length), u64(data.length)]);
  const local = Buffer.concat([u32(0x04034b50), u16(45), u16(0), u16(0), u16(0), u16(0x21), u32(crc), u32(FF), u32(FF),
    u16(name.length), u16(localExtra.length), name, localExtra]);
  let cenExtra = Buffer.concat([u16(0x0001), u16(24), u64(data.length), u64(data.length), u64(offset)]);
  if (unicodeName) {
    const uni = Buffer.from(unicodeName, "utf8");
    cenExtra = Buffer.concat([cenExtra, u16(0x7075), u16(5 + uni.length), Buffer.from([1]), u32(zlib.crc32(name)), uni]);
  }
  central.push(Buffer.concat([u32(0x02014b50), u16(45), u16(45), u16(0), u16(0), u16(0), u16(0x21), u32(crc), u32(FF), u32(FF),
    u16(name.length), u16(cenExtra.length), u16(0), u16(0), u16(0), u32(0), u32(FF), name, cenExtra]));
  parts.push(local, data);
  offset += local.length + data.length;
}
const cd = Buffer.concat(central);
const cdOffset = offset;
const eocd64Offset = cdOffset + cd.length;
const eocd64 = Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
  u64(files.length), u64(files.length), u64(cd.length), u64(cdOffset)]);
const locator = Buffer.concat([u32(0x07064b50), u32(0), u64(eocd64Offset), u32(1)]);
const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(FF), u32(FF), u16(0)]);

const out = path.join(__dirname, "fixtures", "fixture-zip64-extras.3mf");
fs.writeFileSync(out, Buffer.concat([...parts, cd, eocd64, locator, eocd]));
console.log("wrote", out);
