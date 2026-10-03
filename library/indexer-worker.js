// library/indexer-worker.js — the Library's worker thread.
//
// The work that must not run on the main thread, because node:sqlite is
// synchronous: backups (VACUUM INTO) and, from M2, the indexer's parsing and
// database writes. File access is NOT done here: the main thread reads files
// through netfs (netfs/NetFs.js), whose own worker threads, timeouts and
// availability breaker keep a dead share from hanging anything, and hands
// the bytes over. See library/Scanner.js.
//
// Loaded two ways, both through handle():
//   - as a worker_threads Worker (the normal case), answering messages
//     { id, cmd, payload } with { id, ok, result | error }
//   - in-process, by WorkerHost's fallback, when a Worker cannot be started
"use strict";
const { isMainThread, parentPort, threadId } = require("node:worker_threads");
const { runBackup } = require("./LibraryStore");
const indexStore = require("./indexStore");
const gcodeExtract = require("./gcodeExtract");
const threemfExtract = require("./threemfExtract");
const grouping = require("./grouping");

const dbs = new Map();   // dbPath -> connection, opened on first use
function dbFor(dbPath) {
  if (!dbs.has(dbPath)) {
    const DatabaseSync = loadSqlite();
    if (!DatabaseSync) throw new Error("node:sqlite unavailable");
    dbs.set(dbPath, indexStore.openDb(DatabaseSync, dbPath));
  }
  return dbs.get(dbPath);
}
const streams = new Map();   // streamed-fallback sessions
let nextStream = 1;
// A structured-cloned Buffer arrives as a Uint8Array.
const asBuffer = u => (u ? Buffer.from(u.buffer, u.byteOffset, u.byteLength) : null);

const handlers = {
  ping: () => ({ threadId, inWorker: !isMainThread, node: process.version, sqlite: !!loadSqlite() }),
  backup: ({ dbPath, backupsDir, reason, keep }) => {
    const DatabaseSync = loadSqlite();
    if (!DatabaseSync) throw new Error("node:sqlite unavailable");
    return runBackup({ DatabaseSync, dbPath, backupsDir, reason, keep });
  },

  "index.begin": ({ dbPath, rootId, now }) => indexStore.beginScan(dbFor(dbPath), { rootId, now }),
  // A file read through the adaptive window (head/tail) or already extracted
  // by the streamed fallback (extract); or neither, for a file M2 does not read.
  // A 3MF arrives as its directory and the raw (compressed) entries the
  // scanner chose; inflating, CRC checks and parsing happen here.
  "index.file": ({ dbPath, thumbsDir, now, file, head, tail, wholeFile, extract, threemf }) => {
    let ex = extract || null, x3 = null;
    const t0 = Date.now();
    if (!ex && head) ex = gcodeExtract.extractFromWindow(asBuffer(head), asBuffer(tail), { wholeFile });
    if (ex && ex.thumbnail && ex.thumbnail.data && !Buffer.isBuffer(ex.thumbnail.data)) ex.thumbnail.data = asBuffer(ex.thumbnail.data);
    if (threemf) {
      const raw = {};
      for (const [name, r] of Object.entries(threemf.raw)) raw[name] = { ...r, comp: asBuffer(r.comp) };
      x3 = threemfExtract.extract3mf({ directory: threemf.directory, raw, zip64: threemf.zip64 });
    }
    const parseMs = Date.now() - t0;
    const r = indexStore.writeFile(dbFor(dbPath), { ...file, extract: ex, threemf: x3 }, { now, thumbsDir });
    return { ...r, parseMs, objects: ex ? ex.objects.length : x3 ? x3.objects.length : 0, plates: x3 ? x3.plates.length : null, problems: x3 ? x3.problems : null };
  },
  // Lineage between files (source_of, sliced_from), from what is indexed.
  "index.lineage": ({ dbPath, now }) => indexStore.lineage(dbFor(dbPath), { now }),
  // Models from the index (M4), in one transaction: all of it or none of it.
  // The report is written once the transaction has committed.
  "index.group": ({ dbPath, now, reportPath }) => {
    const db = dbFor(dbPath);
    const { report, ...out } = indexStore.inTransaction(db, () => grouping.run(db, { now }));
    if (reportPath) grouping.writeReport(reportPath, report);
    return out;
  },
  // The streamed fallback (§6.2: no config block within 3 MB of the end): the
  // main thread reads the file in chunks and the parsing happens here, line by
  // line, so a 200 MB file never costs the server's thread anything but I/O.
  "index.streamBegin": () => { const sid = nextStream++; streams.set(sid, { ex: gcodeExtract.createExtractor(), rest: "" }); return { sid }; },
  "index.streamFeed": ({ sid, chunk }) => {
    const s = streams.get(sid);
    if (!s) throw new Error("unknown stream " + sid);
    const lines = (s.rest + asBuffer(chunk).toString("utf8")).split(/\r?\n/);
    s.rest = lines.pop();
    for (const l of lines) s.ex.feed(l);
    return { ok: true };
  },
  "index.streamEnd": ({ sid, discard }) => {
    const s = streams.get(sid);
    streams.delete(sid);
    if (!s || discard) return null;
    if (s.rest) s.ex.feed(s.rest);
    return s.ex.result();
  },
  "index.touch": ({ dbPath, ids, now }) => indexStore.touch(dbFor(dbPath), { ids, now }),
  "index.restat": ({ dbPath, ...p }) => indexStore.restat(dbFor(dbPath), p),
  "index.move": ({ dbPath, ...p }) => indexStore.move(dbFor(dbPath), p),
  "index.finish": ({ dbPath, ...p }) => indexStore.finishScan(dbFor(dbPath), p),
  "index.hash": ({ dbPath, ...p }) => indexStore.setHash(dbFor(dbPath), p),
  "index.removeRoot": ({ dbPath, ...p }) => indexStore.removeRootRows(dbFor(dbPath), p),
  "index.close": ({ dbPath }) => { const db = dbs.get(dbPath); if (db) { db.close(); dbs.delete(dbPath); } return { ok: true }; },

  // For tests of the host's restart handling only.
  crash: () => { if (!isMainThread) setImmediate(() => process.exit(3)); return { exiting: !isMainThread }; },
};

function loadSqlite() { try { return require("node:sqlite").DatabaseSync; } catch { return null; } }

async function handle(cmd, payload) {
  const fn = handlers[cmd];
  if (!fn) throw new Error("unknown worker command: " + cmd);
  return fn(payload || {});
}

if (!isMainThread && parentPort) {
  parentPort.on("message", async ({ id, cmd, payload }) => {
    try { parentPort.postMessage({ id, ok: true, result: await handle(cmd, payload) }); }
    catch (e) { parentPort.postMessage({ id, ok: false, error: { message: e.message, code: e.code || null } }); }
  });
}

module.exports = { handle };
