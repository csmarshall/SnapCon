// library/WorkerHost.js — starts and supervises the Library's worker thread.
//
// request(cmd, payload) sends one command and resolves with its result. If
// the worker exits unexpectedly, pending requests fail with WORKER_EXITED and
// it is restarted with backoff. If a Worker cannot be started at all, the same
// handlers run in-process (the fallback M0 kept open; M0 proved the pkg build
// on Windows starts the real Worker).
//
// The worker file is named with a path.join(__dirname, …) literal and is also
// listed in package.json → pkg.scripts, so the packaged build carries it
// without relying on pkg's discovery heuristic (P5).
"use strict";
const path = require("path");
const { Worker } = require("node:worker_threads");

const WORKER_FILE = path.join(__dirname, "indexer-worker.js");
const RESTART_DELAYS_MS = [1000, 5000, 30000];

function createWorkerHost({ log = console, forceInline = false } = {}) {
  let worker = null, mode = null, stopping = false, restarts = 0, nextId = 1;
  const pending = new Map();

  function failAll(code, message) {
    for (const [, p] of pending) { clearTimeout(p.timer); const e = new Error(message); e.code = code; p.reject(e); }
    pending.clear();
  }

  function start() {
    if (forceInline) { mode = "inline"; return; }
    try {
      worker = new Worker(WORKER_FILE);
      mode = "thread";
    } catch (e) {
      log.warn("[library] worker thread unavailable, running its jobs in-process: " + e.message);
      worker = null; mode = "inline";
      return;
    }
    worker.on("message", ({ id, ok, result, error }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id); clearTimeout(p.timer); syncRef();
      if (ok) { restarts = 0; p.resolve(result); }
      else { const e = new Error(error && error.message); e.code = error && error.code; if (error && error.status) e.status = error.status; if (error && error.extra) e.extra = error.extra; p.reject(e); }
    });
    worker.on("error", e => log.error("[library] worker error: " + e.message));
    worker.on("exit", code => {
      worker = null;
      failAll("WORKER_EXITED", `library worker exited (code ${code})`);
      if (stopping) return;
      const delay = RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)];
      restarts++;
      log.warn(`[library] worker exited with code ${code}; restarting in ${delay / 1000} s`);
      const t = setTimeout(() => { if (!stopping) start(); }, delay);
      if (t.unref) t.unref();
    });
    // Idle, it never keeps the process alive on its own; with a request
    // pending it does, so a backup is not cut off by an otherwise idle
    // process exiting (see request()).
    worker.unref();
  }
  const syncRef = () => { if (worker) { if (pending.size) worker.ref(); else worker.unref(); } };

  function request(cmd, payload, { timeoutMs = 10 * 60 * 1000 } = {}) {
    // A static require, so pkg bundles it for the fallback too.
    if (mode === "inline") return require("./indexer-worker").handle(cmd, payload);
    if (!worker) { const e = new Error("library worker is not running"); e.code = "WORKER_DOWN"; return Promise.reject(e); }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id); syncRef();
        const e = new Error(`library worker did not answer "${cmd}" within ${timeoutMs / 1000} s`); e.code = "WORKER_TIMEOUT"; reject(e);
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      syncRef();
      worker.postMessage({ id, cmd, payload });
    });
  }

  async function stop() {
    stopping = true;
    failAll("WORKER_STOPPED", "library worker stopped");
    if (worker) { const w = worker; worker = null; await w.terminate(); }
  }

  start();
  return { request, stop, get mode() { return mode; }, get running() { return mode === "inline" || !!worker; } };
}

module.exports = { createWorkerHost, WORKER_FILE };
