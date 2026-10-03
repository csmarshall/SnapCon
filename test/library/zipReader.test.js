// test/library/zipReader.test.js — the hardened zip reader (library/zipReader.js)
// that the Library and threemf.js share: malformed and hostile archives are
// refused with a reason, never a crash or a hang; head reads stay heads; and
// threemf.js — the Bambu connector's reader — now reads saturated zip64.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const zlib = require("zlib");
const { openZipSync, ZipError } = require("../../library/zipReader");
const { buildZip } = require("./helpers/zip");

// ---- malformed and hostile archives: errors, never crashes or hangs ----

const syncOpen = buf => openZipSync((pos, len) => { if (pos < 0 || pos + len > buf.length) throw new ZipError("ZIP_TRUNCATED", "short read"); return buf.subarray(pos, pos + len); }, buf.length);

test("malformed archives are refused with a reason", async () => {
  const good = buildZip([{ name: "a.txt", data: "hello world, hello world" }]);
  assert.throws(() => syncOpen(Buffer.from("not a zip at all, not even close")), { code: "ZIP_NO_EOCD" });
  assert.throws(() => syncOpen(good.subarray(0, good.length - 10)), { code: "ZIP_NO_EOCD" }, "truncated tail");
  const badOffset = Buffer.from(good); badOffset.writeUInt32LE(good.length + 1000, good.length - 6);   // EOCD: central directory offset
  assert.throws(() => syncOpen(badOffset), { code: "ZIP_BAD_CD" });
  const manyEntries = Buffer.from(good); manyEntries.writeUInt16LE(60000, good.length - 12); manyEntries.writeUInt16LE(60000, good.length - 14);
  assert.throws(() => openZipSync((p, l) => manyEntries.subarray(p, p + l), manyEntries.length, { maxEntries: 20000 }), { code: "ZIP_TOO_MANY_ENTRIES" });
  // a corrupted byte inside the data: the CRC catches it
  const flipped = Buffer.from(buildZip([{ name: "a.txt", data: "hello world, hello world", deflate: false }]));
  flipped[30 + 5 + 2] ^= 0xff;
  assert.throws(() => syncOpen(flipped).read("a.txt"), { code: "ZIP_CRC" });
  // an entry claiming a huge size is not inflated
  assert.throws(() => syncOpen(good).read("a.txt", { maxBytes: 4 }), { code: "ZIP_ENTRY_TOO_LARGE" });
  // encryption and unknown methods
  const enc = Buffer.from(good); const cen = enc.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  enc.writeUInt16LE(1, cen + 8);
  assert.throws(() => syncOpen(enc).read("a.txt"), { code: "ZIP_ENCRYPTED" });
  const meth = Buffer.from(good); meth.writeUInt16LE(12, cen + 10);
  assert.throws(() => syncOpen(meth).read("a.txt"), { code: "ZIP_METHOD" });
});

test("threemf.js (the Bambu connector's reader) now reads a saturated zip64 3MF", () => {
  const threemf = require("../../threemf");
  const m0 = path.join(__dirname, "..", "library-spike", "fixtures", "fixture-zip64-extras.3mf");
  const info = threemf.read(m0);
  assert.equal(info.error, null, "formerly: zip64 archives are not supported");
});

test("a head read of a highly compressible entry inflates only its head, never the whole entry", () => {
  const { inflate } = require("../../library/zipReader");
  const huge = Buffer.alloc(50 * 1024 * 1024, "<vertex/>\n");             // 50 MB that deflates ~1000:1
  const comp = zlib.deflateRawSync(huge);
  const t0 = Date.now();
  const out = inflate(comp.subarray(0, 64 * 1024), { name: "3D/3dmodel.model", method: 8 }, { partial: true, maxOut: 1024 * 1024 });
  assert.ok(out.length <= 1024 * 1024 && out.length > 0, `${out.length} bytes`);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(out.toString("utf8", 0, 10), "<vertex/>\n");
});
