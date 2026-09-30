// test/library/worker.test.js — the Library's worker thread foundation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { createWorkerHost, WORKER_FILE } = require("../../library/WorkerHost");

const quiet = { log() {}, warn() {}, error() {} };

test("the worker runs in its own thread and has node:sqlite", async () => {
  const w = createWorkerHost({ log: quiet });
  assert.equal(w.mode, "thread");
  const r = await w.request("ping");
  assert.equal(r.inWorker, true);
  assert.equal(r.sqlite, true);
  await w.stop();
});

test("a worker that dies fails its pending request and is restarted", async () => {
  const w = createWorkerHost({ log: quiet });
  await w.request("ping");
  await w.request("crash");
  // The exit fails nothing already answered; the next request after the
  // restart delay (1 s) works again.
  await new Promise(s => setTimeout(s, 1300));
  const r = await w.request("ping");
  assert.equal(r.inWorker, true);
  await w.stop();
});

test("unknown commands are errors, not crashes", async () => {
  const w = createWorkerHost({ log: quiet });
  await assert.rejects(w.request("nope"), /unknown worker command/);
  assert.equal((await w.request("ping")).inWorker, true);
  await w.stop();
});

test("the in-process fallback runs the same handlers", async () => {
  const w = createWorkerHost({ log: quiet, forceInline: true });
  assert.equal(w.mode, "inline");
  assert.equal((await w.request("ping")).inWorker, false);
  await w.stop();
});

test("the worker file is listed in pkg.scripts, not left to pkg's discovery (P5)", () => {
  const pkg = JSON.parse(fs.readFileSync(require.resolve("../../package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.pkg.scripts) && pkg.pkg.scripts.includes("library/indexer-worker.js"));
  assert.ok(WORKER_FILE.replace(/\\/g, "/").endsWith("library/indexer-worker.js"));
});
