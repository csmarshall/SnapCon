// test/library-spike/zipRangeReader.test.js — M0 spike: the range-read zip
// reader that M3 will build the 3MF extractor on.
//
// Fixtures were written by libarchive (Windows' bsdtar 3.8.8), not by this
// reader's author, so the tests are not a writer checking its own output:
//   fixture-deflate.3mf       DEFLATE, data descriptors, no zip64
//   fixture-zip64.3mf         forced zip64 (EOCD64 record + locator, 0x0001 extras), data descriptors
//   fixture-zip64-store.3mf   forced zip64, STORE
// Each holds a 3MF-shaped tree, including a non-ASCII file name.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openZip } = require("../../spike/library-m0/zipRangeReader");

const FX = path.join(__dirname, "fixtures");
const FIXTURES = ["fixture-deflate.3mf", "fixture-zip64.3mf", "fixture-zip64-store.3mf"];
const PICTURE = "Auxiliaries/Model Pictures/Drachen-Übersicht.webp";

for (const name of FIXTURES) {
  test(`${name}: lists the 3MF entries and reads each one with a verified CRC`, async () => {
    const z = await openZip(path.join(FX, name));
    try {
      assert.equal(z.zip64, name.includes("zip64"));
      for (const want of ["[Content_Types].xml", "3D/3dmodel.model", "3D/Objects/object_1.model",
        "Metadata/model_settings.config", "Metadata/project_settings.config", "Metadata/plate_1.png", PICTURE]) {
        assert.ok(z.entries.has(want), `missing ${want}`);
      }
      for (const e of z.entries.values()) if (!e.dir) await z.read(e.name);   // throws on size or CRC mismatch
      const settings = (await z.read("Metadata/model_settings.config")).toString("utf8");
      assert.match(settings, /key="source_file" value="Dragon_Body.stl"/);
      assert.equal((await z.read("Metadata/plate_1.png")).subarray(1, 4).toString(), "PNG");
    } finally { await z.close(); }
  });
}

test("zip64 extra fields: saturated 32-bit sizes and offsets resolve from 0x0001, names from 0x7075", async () => {
  // fixture-zip64-extras.3mf (see make-zip64-extras-fixture.js) was extracted
  // byte-identically by bsdtar and by .NET Expand-Archive when it was made.
  const z = await openZip(path.join(FX, "fixture-zip64-extras.3mf"));
  try {
    assert.equal(z.zip64, true);
    assert.ok([...z.entries.values()].every(e => e.zip64), "every entry carries a 0x0001 extra");
    assert.ok(z.entries.has("Auxiliaries/Model Pictures/Bild-Ü.webp"), "the unicode-path name wins over the raw ASCII one");
    assert.match((await z.read("Metadata/model_settings.config")).toString(), /Dragon_Body\.stl/);
    assert.match((await z.read("3D/3dmodel.model")).toString(), /Zip64 Dragon/);
  } finally { await z.close(); }
});

test("metadata is read without touching the mesh: bytes read stay far below the file", async () => {
  // Opening reads up to 64 KB of tail (the whole of this small fixture), so
  // measure what the entry reads cost on their own.
  const z = await openZip(path.join(FX, "fixture-zip64-store.3mf"));
  try {
    const before = z.stats.bytesRead;
    const wanted = ["3D/3dmodel.model", "Metadata/model_settings.config", "Metadata/project_settings.config", "Metadata/plate_1.png"];
    for (const n of wanted) await z.read(n);
    const spent = z.stats.bytesRead - before;
    const mesh = z.entries.get("3D/Objects/object_1.model").rawSize;
    const needed = wanted.reduce((s, n) => s + z.entries.get(n).compSize + 30 + 200, 0);   // data + local header allowance
    assert.ok(spent <= needed, `entry reads cost ${spent} bytes; expected at most ${needed}`);
    assert.ok(spent < mesh, `the ${mesh}-byte mesh must not be read`);
  } finally { await z.close(); }
});

test("a non-zip, a truncated zip and an over-limit zip fail with a code, never a crash", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m0zip-"));
  const bad = path.join(tmp, "not.3mf"); fs.writeFileSync(bad, "hello, this is not a zip archive at all");
  await assert.rejects(openZip(bad), { code: "ZIP_NO_EOCD" });
  const whole = fs.readFileSync(path.join(FX, "fixture-zip64.3mf"));
  const cut = path.join(tmp, "cut.3mf"); fs.writeFileSync(cut, whole.subarray(0, whole.length - 30));
  await assert.rejects(openZip(cut), e => typeof e.code === "string" && e.code.startsWith("ZIP_"));
  await assert.rejects(openZip(path.join(FX, "fixture-deflate.3mf"), { maxEntries: 2 }), { code: "ZIP_TOO_MANY_ENTRIES" });
  const z = await openZip(path.join(FX, "fixture-deflate.3mf"), { maxEntryBytes: 100 });
  try { await assert.rejects(z.read("3D/Objects/object_1.model"), { code: "ZIP_ENTRY_TOO_LARGE" }); }
  finally { await z.close(); }
});

test("a corrupted entry is caught by its CRC", async () => {
  const whole = Buffer.from(fs.readFileSync(path.join(FX, "fixture-zip64-store.3mf")));
  const z0 = await openZip(path.join(FX, "fixture-zip64-store.3mf"));
  const en = z0.entries.get("Metadata/project_settings.config"); await z0.close();
  // Flip one byte inside the stored data (after the 30-byte local header + name + extra).
  const nameLen = whole.readUInt16LE(en.localOffset + 26), extraLen = whole.readUInt16LE(en.localOffset + 28);
  whole[en.localOffset + 30 + nameLen + extraLen + 5] ^= 0xff;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "m0zip-")), "flip.3mf");
  fs.writeFileSync(tmp, whole);
  const z = await openZip(tmp);
  try { await assert.rejects(z.read("Metadata/project_settings.config"), { code: "ZIP_CRC" }); }
  finally { await z.close(); }
});
