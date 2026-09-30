// library/indexer-worker.js — the Library's worker thread.
//
// M1 gives it the work that must not run on the main thread: backups.
// node:sqlite is synchronous, so a VACUUM INTO of a large library would
// freeze fleet polling for as long as it takes. M2 adds indexing here.
//
// Loaded two ways, both through handle():
//   - as a worker_threads Worker (the normal case), answering messages
//     { id, cmd, payload } with { id, ok, result | error }
//   - in-process, by WorkerHost's fallback, when a Worker cannot be started
//
// Filesystem reachability checks are NOT done here. Worker threads share
// libuv's thread pool with the main thread, so a worker gives no isolation
// from a share that hangs (measured in M1: 21 s per unreachable host).
"use strict";
const { isMainThread, parentPort, threadId } = require("node:worker_threads");
const { runBackup } = require("./LibraryStore");

const handlers = {
  ping: () => ({ threadId, inWorker: !isMainThread, node: process.version, sqlite: !!loadSqlite() }),
  backup: ({ dbPath, backupsDir, reason, keep }) => {
    const DatabaseSync = loadSqlite();
    if (!DatabaseSync) throw new Error("node:sqlite unavailable");
    return runBackup({ DatabaseSync, dbPath, backupsDir, reason, keep });
  },
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
