// test/queue/queuePersistRetry.test.js — saving the queue while another process
// has queue-data.json open (M7.1).
//
// On Windows a file another process holds open cannot be replaced: the atomic
// rename fails at once with EPERM. Before: one such moment failed the
// person's queue action and degraded the whole store until the 15-second
// retry. Now a short bounded retry rides it out; a hold longer than that still
// fails exactly as before — the action is not applied, nothing reports
// success, the file on disk stays the last valid queue.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { createQueueStore } = require("../../queue/QueueStore");

const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-qretry-"));
const addItem = id => s => ({ ...s, queue: [...s.queue, { id, status: "queued", file: { name: id + ".gcode", sub: "" } }], updatedAt: Date.now() });
const onDisk = base => JSON.parse(fs.readFileSync(path.join(base, "data", "queue-data.json"), "utf8"));
const quiet = t => { const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; t.after(() => { console.log = log; console.error = err; }); };
// fs with a rename that fails `n` times with `code`, then works.
function flakyFs(n, code = "EPERM") {
  let left = n;
  return { ...fs, renameSync: (a, b) => { if (left > 0) { left--; throw Object.assign(new Error(code + ": operation not permitted, rename"), { code }); } return fs.renameSync(a, b); },
    get left() { return left; } };
}

test("a rename refused for a moment (EPERM, EBUSY, EACCES) is retried and the action saved once", t => {
  quiet(t);
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const base = tmpBase(), slept = [];
    const store = createQueueStore({ baseDir: base, fsImpl: flakyFs(2, code), retry: { sleep: ms => slept.push(ms) } });
    const r = store.applyIntent("pr1", addItem("qi_1"));
    assert.equal(r.ok, true, code);
    assert.deepEqual(slept, [10, 25], "bounded backoff");
    assert.deepEqual(onDisk(base).pr1.queue.map(i => i.id), ["qi_1"], "saved exactly once");
    assert.equal(store.getGlobalStatus().storeDegraded, false);
  }
});

test("a hold longer than the retry window fails as before: not applied, not reported as success, the file still valid", t => {
  quiet(t);
  const base = tmpBase();
  const ok = createQueueStore({ baseDir: base });
  assert.equal(ok.applyIntent("pr1", addItem("qi_1")).ok, true);
  const held = flakyFs(1000);
  const slept = [];
  const store = createQueueStore({ baseDir: base, fsImpl: held, retry: { sleep: ms => slept.push(ms) } });
  store.load();
  const r = store.applyIntent("pr1", addItem("qi_2"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "persist-failed");
  assert.equal(slept.length, 5, "gave up after the bounded retries");
  assert.deepEqual(store.getPrinterState("pr1").queue.map(i => i.id), ["qi_1"], "memory not mutated");
  assert.deepEqual(onDisk(base).pr1.queue.map(i => i.id), ["qi_1"], "the last valid queue is still on disk");
  assert.equal(store.getGlobalStatus().storeDegraded, true, "the failure is surfaced");
  assert.equal(store.applyIntent("pr1", addItem("qi_3")).reason, "store-degraded", "no new action while it cannot be saved");
  // A non-transient error is not retried at all.
  const slept2 = [];
  const bad = createQueueStore({ baseDir: tmpBase(), fsImpl: { ...fs, renameSync: () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } }, retry: { sleep: ms => slept2.push(ms) } });
  assert.equal(bad.applyIntent("pr1", addItem("x")).ok, false);
  assert.deepEqual(slept2, []);
});

// The real thing: another process holds the file open.
function holdOpen(file, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e",
      `const fs=require("fs");const fd=fs.openSync(${JSON.stringify(file)},"r");process.stdout.write("open\\n");setTimeout(()=>{fs.closeSync(fd);process.exit(0)},${ms});`]);
    child.stdout.once("data", () => resolve(child));
    child.once("error", reject);
  });
}
const exited = child => new Promise(r => (child.exitCode != null ? r() : child.once("exit", r)));

test("Windows: another process holding queue-data.json open briefly does not lose or fail the save", { skip: process.platform !== "win32" && "Windows sharing semantics" }, async t => {
  quiet(t);
  const base = tmpBase();
  const store = createQueueStore({ baseDir: base });
  assert.equal(store.applyIntent("pr1", addItem("qi_1")).ok, true);
  // Without the retry, this is the observed failure.
  const child = await holdOpen(path.join(base, "data", "queue-data.json"), 120);
  const t0 = Date.now();
  const r = store.applyIntent("pr1", addItem("qi_2"));
  assert.equal(r.ok, true, r.error && r.error.message);
  assert.ok(Date.now() - t0 < 1000);
  await exited(child);
  assert.deepEqual(onDisk(base).pr1.queue.map(i => i.id), ["qi_1", "qi_2"]);
});

test("Windows: a hold longer than the retry window is reported, the file stays valid, and the next save recovers", { skip: process.platform !== "win32" && "Windows sharing semantics" }, async t => {
  quiet(t);
  const base = tmpBase();
  const store = createQueueStore({ baseDir: base, degradedRetryMs: 60000 });
  assert.equal(store.applyIntent("pr1", addItem("qi_1")).ok, true);
  const child = await holdOpen(path.join(base, "data", "queue-data.json"), 1500);
  const r = store.applyIntent("pr1", addItem("qi_2"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "persist-failed");
  assert.deepEqual(onDisk(base).pr1.queue.map(i => i.id), ["qi_1"], "valid, and the last good queue");
  await exited(child);
  assert.equal(store.retrySave().ok, true);
  assert.equal(store.getGlobalStatus().storeDegraded, false);
  assert.equal(store.applyIntent("pr1", addItem("qi_2")).ok, true, "the person can do it again");
  assert.deepEqual(onDisk(base).pr1.queue.map(i => i.id), ["qi_1", "qi_2"]);
});
