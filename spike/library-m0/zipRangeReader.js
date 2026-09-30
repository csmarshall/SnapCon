// spike/library-m0/zipRangeReader.js — M0 prototype of the M3 zip reader.
//
// Reads a zip (3MF) the way the Library must over a network share: never the
// whole file. One range read for the tail (end-of-central-directory, plus the
// zip64 locator), one for the central directory, and one per entry actually
// wanted. Sizes and offsets always come from the central directory, so local
// headers written with data descriptors (streamed writers) are fine.
//
// Supports: STORE and DEFLATE; zip64 (EOCD64 locator/record and the 0x0001
// extra field); the Info-ZIP unicode path extra field (0x7075); UTF-8 names
// (flag bit 11). Refuses: encryption, other methods, more than maxEntries,
// an entry larger than maxEntryBytes. Verifies each entry's CRC-32.
// Asynchronous throughout — nothing blocks the event loop on a slow share.
"use strict";
const fs = require("fs");
const zlib = require("zlib");

const SIG = { EOCD: 0x06054b50, EOCD64_LOC: 0x07064b50, EOCD64: 0x06064b50, CEN: 0x02014b50, LOC: 0x04034b50 };
const U32 = 0xffffffff, U16 = 0xffff;

class ZipError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function u64(buf, off) {
  const lo = buf.readUInt32LE(off), hi = buf.readUInt32LE(off + 4);
  const v = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(v)) throw new ZipError("ZIP_TOO_LARGE", "zip64 value beyond 2^53");
  return v;
}

async function openZip(file, opts = {}) {
  const maxEntries = opts.maxEntries || 20000;
  const maxEntryBytes = opts.maxEntryBytes || 64 * 1024 * 1024;
  const maxCdBytes = opts.maxCdBytes || 16 * 1024 * 1024;
  const fd = await fs.promises.open(file, "r");
  const stats = { reads: 0, bytesRead: 0 };
  const readAt = async (pos, len) => {
    const b = Buffer.allocUnsafe(len);
    const { bytesRead } = await fd.read(b, 0, len, pos);
    stats.reads++; stats.bytesRead += bytesRead;
    if (bytesRead !== len) throw new ZipError("ZIP_TRUNCATED", `short read at ${pos}`);
    return b;
  };
  try {
    const size = (await fd.stat()).size;
    // EOCD is 22 bytes + up to 65535 of comment; the zip64 locator sits 20 bytes before it.
    const tailLen = Math.min(size, 22 + 65535 + 20);
    const tail = await readAt(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      // A real EOCD's comment runs exactly to the end of the file; a signature
      // that happens to appear inside a comment does not.
      if (tail.readUInt32LE(i) === SIG.EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError("ZIP_NO_EOCD", "not a zip archive (no end-of-central-directory)");
    let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
    let zip64 = false;
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG.EOCD64_LOC) {
      const recOff = u64(tail, eocd - 20 + 8);
      const rec = await readAt(recOff, 56);
      if (rec.readUInt32LE(0) !== SIG.EOCD64) throw new ZipError("ZIP_BAD_EOCD64", "zip64 locator points at no zip64 record");
      count = u64(rec, 32); cdSize = u64(rec, 40); cdOffset = u64(rec, 48);
      zip64 = true;
    } else if (count === U16 || cdSize === U32 || cdOffset === U32) {
      throw new ZipError("ZIP_BAD_EOCD64", "zip64 markers without a zip64 locator");
    }
    if (count > maxEntries) throw new ZipError("ZIP_TOO_MANY_ENTRIES", `${count} entries (limit ${maxEntries})`);
    if (cdSize > maxCdBytes) throw new ZipError("ZIP_CD_TOO_LARGE", `central directory ${cdSize} bytes`);
    const cd = await readAt(cdOffset, cdSize);

    const entries = new Map();
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG.CEN) throw new ZipError("ZIP_BAD_CEN", `bad central entry #${n}`);
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20), rawSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      let name = (flags & 0x800) ? nameBuf.toString("utf8") : nameBuf.toString("latin1");
      let e = p + 46 + nameLen; const extraEnd = e + extraLen;
      let entryZip64 = false;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2); let q = e + 4;
        if (id === 0x0001) {           // zip64: only the fields whose 32-bit value is saturated, in this order
          entryZip64 = true;
          if (rawSize === U32) { rawSize = u64(cd, q); q += 8; }
          if (compSize === U32) { compSize = u64(cd, q); q += 8; }
          if (localOffset === U32) { localOffset = u64(cd, q); q += 8; }
        } else if (id === 0x7075 && len >= 5) {   // unicode path: trusted only if it matches this raw name
          const nameCrc = cd.readUInt32LE(e + 5);
          if (nameCrc === zlib.crc32(nameBuf)) name = cd.subarray(e + 9, e + 4 + len).toString("utf8");
        }
        e += 4 + len;
      }
      entries.set(name, { name, flags, method, crc, compSize, rawSize, localOffset, zip64: entryZip64,
        encrypted: !!(flags & 1), dir: name.endsWith("/") });
      p = extraEnd + commentLen;
    }

    async function read(name) {
      const en = entries.get(name);
      if (!en) throw new ZipError("ZIP_NO_ENTRY", `no entry ${name}`);
      if (en.encrypted) throw new ZipError("ZIP_ENCRYPTED", `${name} is encrypted`);
      if (en.method !== 0 && en.method !== 8) throw new ZipError("ZIP_METHOD", `${name}: compression method ${en.method}`);
      if (en.rawSize > maxEntryBytes) throw new ZipError("ZIP_ENTRY_TOO_LARGE", `${name}: ${en.rawSize} bytes (limit ${maxEntryBytes})`);
      // The local header's own name/extra lengths decide where the data starts;
      // its size fields are ignored (a data descriptor leaves them zero).
      const loc = await readAt(en.localOffset, 30);
      if (loc.readUInt32LE(0) !== SIG.LOC) throw new ZipError("ZIP_BAD_LOC", `${name}: bad local header`);
      const start = en.localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
      const comp = en.compSize ? await readAt(start, en.compSize) : Buffer.alloc(0);
      const out = en.method === 0 ? comp : zlib.inflateRawSync(comp, { maxOutputLength: Math.max(en.rawSize, 1) });
      if (out.length !== en.rawSize) throw new ZipError("ZIP_SIZE", `${name}: size ${out.length} != ${en.rawSize}`);
      if (zlib.crc32(out) !== en.crc) throw new ZipError("ZIP_CRC", `${name}: CRC mismatch`);
      return out;
    }
    return { file, size, zip64, count, entries, read, stats, close: () => fd.close() };
  } catch (e) {
    await fd.close().catch(() => {});
    throw e;
  }
}

module.exports = { openZip, ZipError };
