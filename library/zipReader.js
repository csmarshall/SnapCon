// library/zipReader.js — reads a zip (a 3MF) without reading the whole file:
// the end-of-central-directory record, the central directory, and then only
// the entries actually wanted (docs/library-design.md §6.2, M0 §21).
//
// The parsing is pure and works on buffers; the caller supplies the bytes
// through readAt(pos, len). That lets one implementation serve both the
// Library's scanner (asynchronous reads through netfs, throttled) and
// threemf.js (synchronous reads for the Bambu connector and the file browser).
//
// Supports STORE and DEFLATE; zip64 (EOCD64 locator and record, the 0x0001
// extra field); the Info-ZIP unicode path field (0x7075, trusted only when its
// CRC matches the raw name); UTF-8 names (flag bit 11); data descriptors
// (sizes always come from the central directory). Refuses — with a ZipError,
// never a crash — encryption, other methods, offsets or sizes outside the
// file, more entries or a larger directory than the limits, and any entry
// larger than the caller allows. Untrusted input: every length is checked
// before it is used.
"use strict";
const zlib = require("zlib");

const SIG = { EOCD: 0x06054b50, EOCD64_LOC: 0x07064b50, EOCD64: 0x06064b50, CEN: 0x02014b50, LOC: 0x04034b50 };
const U32 = 0xffffffff, U16 = 0xffff;
const TAIL_MAX = 22 + 65535 + 20;   // EOCD + longest comment + zip64 locator
const DEFAULTS = { maxEntries: 20000, maxCdBytes: 16 * 1024 * 1024 };

class ZipError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function u64(buf, off) {
  const lo = buf.readUInt32LE(off), hi = buf.readUInt32LE(off + 4);
  const v = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(v)) throw new ZipError("ZIP_TOO_LARGE", "zip64 value beyond 2^53");
  return v;
}

// From the file's tail: where the central directory is. `zip64Record` is set
// when a zip64 record must be read (at that offset, 56 bytes) to finish.
function parseTail(tail, size) {
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    // A real EOCD's comment runs exactly to the end of the file; a signature
    // that happens to appear inside a comment does not.
    if (tail.readUInt32LE(i) === SIG.EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("ZIP_NO_EOCD", "not a zip archive (no end-of-central-directory)");
  const out = { count: tail.readUInt16LE(eocd + 10), cdSize: tail.readUInt32LE(eocd + 12), cdOffset: tail.readUInt32LE(eocd + 16), zip64Record: null };
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG.EOCD64_LOC) {
    out.zip64Record = u64(tail, eocd - 20 + 8);
    if (out.zip64Record + 56 > size) throw new ZipError("ZIP_BAD_EOCD64", "zip64 record outside the file");
  } else if (out.count === U16 || out.cdSize === U32 || out.cdOffset === U32) {
    throw new ZipError("ZIP_BAD_EOCD64", "zip64 markers without a zip64 locator");
  }
  return out;
}

function parseZip64Record(rec, at) {
  if (rec.readUInt32LE(0) !== SIG.EOCD64) throw new ZipError("ZIP_BAD_EOCD64", "zip64 locator points at no zip64 record");
  at.count = u64(rec, 32); at.cdSize = u64(rec, 40); at.cdOffset = u64(rec, 48);
  return at;
}

function checkDirectory(at, size, limits) {
  if (at.count > limits.maxEntries) throw new ZipError("ZIP_TOO_MANY_ENTRIES", `${at.count} entries (limit ${limits.maxEntries})`);
  if (at.cdSize > limits.maxCdBytes) throw new ZipError("ZIP_CD_TOO_LARGE", `central directory of ${at.cdSize} bytes (limit ${limits.maxCdBytes})`);
  if (at.cdOffset + at.cdSize > size) throw new ZipError("ZIP_BAD_CD", "central directory outside the file");
}

// The central directory: every entry's name, method, sizes, CRC and where its
// local header is.
function parseCentralDirectory(cd, count, size) {
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG.CEN) throw new ZipError("ZIP_BAD_CEN", `bad central directory entry #${n}`);
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
    let compSize = cd.readUInt32LE(p + 20), rawSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipError("ZIP_BAD_CEN", `central directory entry #${n} runs past the directory`);
    const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
    let name = (flags & 0x800) ? nameBuf.toString("utf8") : nameBuf.toString("latin1");
    let e = p + 46 + nameLen; const extraEnd = e + extraLen;
    let zip64 = false;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2); let q = e + 4;
      if (e + 4 + len > extraEnd) break;
      if (id === 0x0001) {          // zip64: only the saturated fields, in this order
        zip64 = true;
        if (rawSize === U32 && q + 8 <= e + 4 + len) { rawSize = u64(cd, q); q += 8; }
        if (compSize === U32 && q + 8 <= e + 4 + len) { compSize = u64(cd, q); q += 8; }
        if (localOffset === U32 && q + 8 <= e + 4 + len) { localOffset = u64(cd, q); q += 8; }
      } else if (id === 0x7075 && len >= 5) {   // unicode path, trusted only if it matches this raw name
        if (cd.readUInt32LE(e + 5) === zlib.crc32(nameBuf)) name = cd.subarray(e + 9, e + 4 + len).toString("utf8");
      }
      e += 4 + len;
    }
    if (localOffset + 30 > size || localOffset + compSize > size) throw new ZipError("ZIP_BAD_CEN", `${name}: entry outside the file`);
    entries.set(name, { name, flags, method, crc, compSize, rawSize, localOffset, zip64, encrypted: !!(flags & 1), dir: name.endsWith("/") });
    p = extraEnd + commentLen;
  }
  return entries;
}

function checkEntry(en, maxBytes) {
  if (en.encrypted) throw new ZipError("ZIP_ENCRYPTED", `${en.name} is encrypted`);
  if (en.method !== 0 && en.method !== 8) throw new ZipError("ZIP_METHOD", `${en.name}: compression method ${en.method}`);
  if (maxBytes != null && en.rawSize > maxBytes) throw new ZipError("ZIP_ENTRY_TOO_LARGE", `${en.name}: entry is too large to read (${en.rawSize} bytes, limit ${maxBytes})`);
}

// Where an entry's data starts: the local header's own name/extra lengths
// decide it; its size fields are ignored (a data descriptor leaves them zero).
function dataStart(loc, en) {
  if (loc.readUInt32LE(0) !== SIG.LOC) throw new ZipError("ZIP_BAD_LOC", `${en.name}: bad local header`);
  return en.localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
}

// Decompress an entry's bytes and verify them. `partial` (a head-only read of
// a large entry) skips the size/CRC checks, which need the whole entry.
function inflate(comp, en, { partial = false, maxOut } = {}) {
  let out;
  if (en.method === 0) out = partial ? comp.subarray(0, maxOut || comp.length) : comp;
  else if (partial) {
    // Only the start is wanted. Deflate can expand ~1000:1, so a fixed
    // compressed prefix could still inflate to megabytes: grow the prefix
    // until there is enough output, and never let one step exceed the cap.
    const want = maxOut || 1024 * 1024, CAP = 16 * 1024 * 1024;
    out = Buffer.alloc(0);
    for (let len = Math.min(comp.length, 4096); ; len = Math.min(comp.length, len * 4)) {
      try { out = zlib.inflateRawSync(comp.subarray(0, len), { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: CAP }); }
      catch (e) {
        if (e.code === "ERR_BUFFER_TOO_LARGE") break;   // keep the previous, smaller head
        throw new ZipError("ZIP_INFLATE", `${en.name}: ${e.message}`);
      }
      if (out.length >= want || len >= comp.length) break;
    }
    out = out.subarray(0, want);
  } else {
    try { out = zlib.inflateRawSync(comp, { maxOutputLength: Math.max(en.rawSize, 1) }); }
    catch (e) { throw new ZipError("ZIP_INFLATE", `${en.name}: ${e.message}`); }
  }
  if (!partial) {
    if (out.length !== en.rawSize) throw new ZipError("ZIP_SIZE", `${en.name}: ${out.length} bytes, expected ${en.rawSize}`);
    if (zlib.crc32(out) !== en.crc) throw new ZipError("ZIP_CRC", `${en.name}: CRC mismatch`);
  }
  return out;
}

// ---- drivers ----

// Asynchronous: readAt(pos, len) -> Promise<Buffer>. Returns the directory and
// the raw (still compressed) reader; inflating is left to the caller, so it
// can happen somewhere else (the Library worker).
async function openZipAsync(readAt, size, opts = {}) {
  const limits = { ...DEFAULTS, ...opts };
  if (size < 22) throw new ZipError("ZIP_NO_EOCD", "too small to be a zip archive");
  const tailLen = Math.min(size, TAIL_MAX);
  const at = parseTail(await readAt(size - tailLen, tailLen), size);
  if (at.zip64Record != null) parseZip64Record(await readAt(at.zip64Record, 56), at);
  checkDirectory(at, size, limits);
  const entries = parseCentralDirectory(at.cdSize ? await readAt(at.cdOffset, at.cdSize) : Buffer.alloc(0), at.count, size);
  async function readRaw(name, { maxBytes, headBytes } = {}) {
    const en = entries.get(name);
    if (!en) throw new ZipError("ZIP_NO_ENTRY", `no entry ${name}`);
    checkEntry(en, headBytes ? null : maxBytes);
    const start = dataStart(await readAt(en.localOffset, 30), en);
    if (start + en.compSize > size) throw new ZipError("ZIP_BAD_LOC", `${name}: data outside the file`);
    const len = headBytes ? Math.min(en.compSize, headBytes) : en.compSize;
    // The directory's compressed size is untrusted too: never fetch more than this for one entry.
    if (len > (opts.maxCompBytes || 32 * 1024 * 1024)) throw new ZipError("ZIP_ENTRY_TOO_LARGE", `${name}: ${len} compressed bytes`);
    // A head read is always treated as partial: even when the whole compressed
    // entry fits, inflating all of it is what the head read exists to avoid.
    return { entry: en, comp: len ? await readAt(start, len) : Buffer.alloc(0), partial: !!headBytes };
  }
  return { size, zip64: at.zip64Record != null, count: at.count, entries, readRaw };
}

// Synchronous, for threemf.js: readAt(pos, len) -> Buffer.
function openZipSync(readAt, size, opts = {}) {
  const limits = { ...DEFAULTS, ...opts };
  if (size < 22) throw new ZipError("ZIP_NO_EOCD", "too small to be a zip archive");
  const tailLen = Math.min(size, TAIL_MAX);
  const at = parseTail(readAt(size - tailLen, tailLen), size);
  if (at.zip64Record != null) parseZip64Record(readAt(at.zip64Record, 56), at);
  checkDirectory(at, size, limits);
  const entries = parseCentralDirectory(at.cdSize ? readAt(at.cdOffset, at.cdSize) : Buffer.alloc(0), at.count, size);
  function read(name, { maxBytes } = {}) {
    const en = entries.get(name);
    if (!en) throw new ZipError("ZIP_NO_ENTRY", `no entry ${name}`);
    checkEntry(en, maxBytes);
    const start = dataStart(readAt(en.localOffset, 30), en);
    if (start + en.compSize > size) throw new ZipError("ZIP_BAD_LOC", `${name}: data outside the file`);
    return inflate(en.compSize ? readAt(start, en.compSize) : Buffer.alloc(0), en);
  }
  return { size, zip64: at.zip64Record != null, count: at.count, entries, read };
}

module.exports = { openZipAsync, openZipSync, inflate, ZipError, parseTail, parseCentralDirectory };
