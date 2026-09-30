// spike/library-m0/pkg-worker/main.js — M0 risk R3: can a pkg-built SnapCon
// run the Library indexer in a worker_threads Worker that uses node:sqlite?
//
// Mirrors how the real app would do it: the worker script lives beside the
// main module inside the pkg snapshot, and the database lives next to the
// executable (BASE_DIR), never inside the read-only snapshot.
//
// Tries two ways of starting the worker, and reports each:
//   file  new Worker(<path of worker.js inside the snapshot>)
//   eval  new Worker(<worker.js source read out of the snapshot>, { eval: true })
// While a worker runs, the main thread records the longest gap between 10 ms
// timer ticks: a stalled main thread would stall fleet polling in the real app.
// (Windows timers tick at ~15.6 ms, so ~16 ms is the floor there.)
"use strict";
const { Worker } = require("node:worker_threads");
const fs = require("fs");
const path = require("path");
const os = require("os");

const IS_PKG = !!process.pkg;
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const WORKER_FILE = path.join(__dirname, "worker.js");
const ROWS = parseInt(process.argv[2], 10) || 20000;

function run(mode) {
  return new Promise(resolve => {
    const dbPath = path.join(BASE_DIR, `spike-${mode}.db`);
    try { fs.rmSync(dbPath, { force: true }); fs.rmSync(dbPath + "-wal", { force: true }); fs.rmSync(dbPath + "-shm", { force: true }); } catch {}
    const t0 = Date.now();
    let ticks = 0, last = Date.now(), maxGap = 0;
    const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 10);
    let w;
    try {
      w = mode === "file"
        ? new Worker(WORKER_FILE, { workerData: { dbPath, rows: ROWS } })
        : new Worker(fs.readFileSync(WORKER_FILE, "utf8"), { eval: true, workerData: { dbPath, rows: ROWS } });
    } catch (e) {
      clearInterval(iv);
      return resolve({ mode, ok: false, error: "construct: " + e.message });
    }
    w.once("message", m => {
      clearInterval(iv);
      const wall = Date.now() - t0;
      resolve({ mode, ok: !!m.ok, ...m, wallMs: wall,
        mainTicks: ticks, mainMaxGapMs: maxGap });
    });
    w.once("error", e => { clearInterval(iv); resolve({ mode, ok: false, error: e.message }); });
  });
}

(async () => {
  const out = { isPkg: IS_PKG, node: process.version, platform: `${os.platform()}-${os.arch()}`,
    execPath: process.execPath, workerFileInSnapshot: WORKER_FILE, workerFileExists: fs.existsSync(WORKER_FILE),
    results: [] };
  for (const mode of ["file", "eval"]) out.results.push(await run(mode));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
