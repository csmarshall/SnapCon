// test/netfs/races.test.js — what happens when the G-code folder's share goes
// away (or comes back) in the middle of real work: an upload to a printer, a
// queue dispatch, a sync run, a Library check, two requests at once, and a
// recovery check running beside an interactive request.
//
// The share is a temp folder registered as a root; "the NAS goes away" is the
// breaker being told so (noteError with UNKNOWN, what Windows returns for an
// unreachable SMB share) or a worker op that hangs past its timeout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createNetFs } = require("../../netfs/NetFs");
const { getNetFs } = require("../../netfs");
const QueueEngine = require("../../queue/QueueEngine");
const { createQueueStore } = require("../../queue/QueueStore");
const { createSyncEngine } = require("../../sync/SyncEngine");
const { checkReachable, netfsFsp } = require("../../library/locations");

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-races-"));
function make(t, o = {}) {
  const nf = createNetFs({ log: quiet, opTimeoutMs: 400, probeEveryMs: 60000, ...o });
  t.after(() => nf.stop());
  return nf;
}
const UNKNOWN = Object.assign(new Error("UNKNOWN: unknown error, stat"), { code: "UNKNOWN" });
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");

// ---------------------------------------------------------------------------
// online → the NAS disappears during a request
// ---------------------------------------------------------------------------

test("the NAS disappears during an upload: the upload fails and the printer never gets a whole-looking file", async t => {
  const nf = getNetFs();                      // the instance the connectors use
  const nas = tmp();
  nf.registerRoot("race-upload", nas);
  t.after(() => nf.registerRoot("race-upload", null));
  const file = path.join(nas, "big.gcode");
  // Large enough that it cannot all sit in socket buffers before the outage.
  fs.writeFileSync(file, Buffer.alloc(48 * 1024 * 1024, 0x47));
  t.after(() => fs.rmSync(nas, { recursive: true, force: true }));

  // A printer that stalls briefly at the start (so the upload backs up behind
  // it) and records what it got.
  let received = 0, declared = 0, completed = false, aborted = false;
  const printer = http.createServer((req, res) => {
    declared = Number(req.headers["content-length"]);
    req.pause(); setTimeout(() => req.resume(), 300);
    req.on("data", c => { received += c.length; });
    req.on("end", () => { completed = true; res.end("{}"); });
    req.on("aborted", () => { aborted = true; });
    req.on("close", () => { if (!completed) aborted = true; });
  });
  await new Promise(r => printer.listen(0, "127.0.0.1", r));
  t.after(() => printer.close());

  const { uploadFile } = require("../../connectors/http-utils");
  const job = { sent: 0, total: 0 };
  // Once the first megabyte has left, the share goes away.
  // Every read of the share from then on fails the way Windows reports it.
  const watch = setInterval(() => { if (job.sent > 1024 * 1024) { nf._setFault((op, p) => p.startsWith(nas) ? "UNKNOWN" : null); clearInterval(watch); } }, 5);
  t.after(() => { clearInterval(watch); nf._setFault(null); });
  await assert.rejects(uploadFile({ url: `http://127.0.0.1:${printer.address().port}` }, file, "big.gcode", job), { code: "NAS_UNREACHABLE" });
  await new Promise(r => setTimeout(r, 600));   // past the printer stall
  assert.equal(completed, false, "the printer must not see a completed upload");
  assert.ok(aborted, "the request was torn down");
  assert.ok(received < declared, `received ${received} of ${declared} bytes`);
});

test("the NAS disappears during the identity check: compareRemoteFile never answers 'identical'", async t => {
  const nf = getNetFs();
  const nas = tmp();
  nf.registerRoot("race-compare", nas);
  t.after(() => nf.registerRoot("race-compare", null));
  const file = path.join(nas, "same.gcode");
  const body = Buffer.alloc(300 * 1024, 0x31);
  fs.writeFileSync(file, body);
  const printer = http.createServer((req, res) => {
    if (req.url.startsWith("/server/files/list")) return res.end(JSON.stringify({ result: [{ path: "same.gcode", size: body.length, modified: 1 }] }));
    // The share goes away while the printer is answering the first window.
    nf.noteError(file, UNKNOWN);
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
    res.writeHead(206); res.end(body.subarray(Number(m[1]), Number(m[2]) + 1));
  });
  await new Promise(r => printer.listen(0, "127.0.0.1", r));
  t.after(() => printer.close());
  const { compareRemoteFile } = require("../../connectors/http-utils");
  await assert.rejects(compareRemoteFile({ url: `http://127.0.0.1:${printer.address().port}` }, "same.gcode", file), { code: "NAS_UNREACHABLE" });
});

// ---------------------------------------------------------------------------
// the NAS disappears between queue validation and dispatch
// ---------------------------------------------------------------------------

test("queue: the forced dispatch-time hash fails NAS_UNREACHABLE, never a stale cached answer", async t => {
  const nf = make(t);
  const nas = tmp(); nf.registerRoot("gcode", nas);
  const base = tmp();
  const store = createQueueStore({ baseDir: base, fileIO: { stat: p => nf.stat(p), hashFile: p => nf.hashFile(p) } });
  const file = path.join(nas, "job.gcode");
  fs.writeFileSync(file, "G1 X1\n");
  const queued = await store.computeFileHash(file);            // validation when queued
  assert.ok(queued.sha256);
  nf.noteError(file, UNKNOWN);                                  // ...and then the share goes
  await assert.rejects(store.computeFileHash(file, { force: true }), { code: "NAS_UNREACHABLE" });
  // Even the cached path does not answer from the cache: it stats first.
  await assert.rejects(store.computeFileHash(file), { code: "NAS_UNREACHABLE" });
});

test("queue: an item whose file could not be checked goes back to the front, unverified", () => {
  const item = { id: "i1", status: "queued", file: { name: "a.gcode", sha256: "x" } };
  const other = { id: "i2", status: "queued", file: { name: "b.gcode", sha256: "y" } };
  const idle = { queueState: "idle", queuePaused: false, queueStopped: false, queue: [item, other], currentItem: null, recentHistory: [] };
  const claim = QueueEngine.claimTransition(idle);
  assert.equal(claim.canClaim, true);
  const back = QueueEngine.onDispatchDeferred(claim.nextState, "i1");
  assert.equal(back.queueState, "idle");
  assert.deepEqual(back.queue.map(i => i.id), ["i1", "i2"], "same order as before the claim");
  assert.equal(back.queue[0].status, "queued");
  assert.equal(back.currentItem, null);
  assert.equal(back.attentionReason, undefined, "a NAS blip is not an attention state");
  assert.throws(() => QueueEngine.onDispatchDeferred(idle, "i1"), /no matching dispatching item/);
});

test("queue dispatch: skips claiming while the folder is down, and an outage found by the check defers rather than fails", () => {
  const i = serverSrc.indexOf("async function attemptQueueDispatch(printerId) {");
  const fn = serverSrc.slice(i, serverSrc.indexOf("\n}\n", i));
  // M7: the folder is the next item's — the G-code folder, or the Library
  // location it was queued from.
  const gate = fn.indexOf('if (nextDir && netfs.availability(nextDir).status !== "online") return;');
  assert.match(fn, /let nextDir = FOLDER;/, "the G-code folder unless the item names a Library location");
  const claim = fn.indexOf("queueStore.claimNextForDispatch(printerId)");
  assert.ok(gate > 0 && gate < claim, "the availability shortcut runs before anything is claimed");
  assert.match(fn, /await queueStore\.computeFileHash\(fp, \{ force: true \}\)/, "the forced identity check still runs every time");
  assert.match(fn, /if \(e && e\.code === "NAS_UNREACHABLE"\) \{[\s\S]*?QueueEngine\.onDispatchDeferred, item\.id\);[\s\S]*?return;/);
  // and a deferred item is never uploaded: the return precedes the upload
  assert.ok(fn.indexOf("onDispatchDeferred") < fn.indexOf("c.uploadFile("));
});

// ---------------------------------------------------------------------------
// two requests discover the outage together / a recovery check overlaps
// ---------------------------------------------------------------------------

test("two interactive requests that hit a hanging share both fail at the timeout, and the outage is reported once", async t => {
  const nf = make(t, { opTimeoutMs: 300 });
  const nas = tmp(); nf.registerRoot("gcode", nas);
  const events = [];
  nf.onChange(s => events.push(s.status));
  const t0 = Date.now();
  const r = await Promise.allSettled([nf._submit("__sleep", [1500], { path: nas }), nf._submit("__sleep", [1500], { path: nas })]);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(r.map(x => x.reason && x.reason.code), ["NAS_UNREACHABLE", "NAS_UNREACHABLE"]);
  assert.deepEqual(events, ["offline"]);
});

test("a recovery check in progress does not hold up interactive work", async t => {
  const nf = make(t, { opTimeoutMs: 300, probeEveryMs: 50 });
  const nas = tmp(), local = tmp();
  nf.registerRoot("gcode", nas);
  nf.noteError(nas, UNKNOWN);
  // The probe lane is busy with a recovery check that hangs (one probe worker).
  const hungProbe = nf._submit("__sleep", [1200], { lane: "probe", timeoutMs: 5000 });
  await new Promise(r => setTimeout(r, 120));                 // the scheduled probe queues behind it
  const t0 = Date.now();
  assert.equal((await nf.stat(local)).isDirectory, true, "other storage is unaffected");
  await assert.rejects(nf.stat(path.join(nas, "x.gcode")), { code: "NAS_UNREACHABLE" }, "the share itself fails fast");
  assert.ok(Date.now() - t0 < 150, `interactive work waited ${Date.now() - t0} ms`);
  await hungProbe;
  // ...and once the probe lane is free, recovery completes.
  await new Promise(r => setTimeout(r, 400));
  assert.equal(nf.availability(nas).status, "online");
});

test("waiting behind other work on a busy lane never marks a healthy share offline", async t => {
  const nf = make(t, { lanes: { interactive: 1, background: 1, probe: 1 }, opTimeoutMs: 300, queueWaitMs: 5000 });
  const nas = tmp(); nf.registerRoot("gcode", nas);
  // A slow but answering share: each op takes 200 ms, under the 300 ms timeout,
  // but the fourth waits ~600 ms in the queue before it even starts.
  const ops = [0, 1, 2, 3].map(() => nf._submit("__sleep", [200], { path: nas }));
  await Promise.all(ops);
  assert.equal(nf.availability(nas).status, "online");
});

test("a lane stuck on a dead share bounds the wait of unrelated work instead of hanging it", async t => {
  const nf = make(t, { lanes: { interactive: 1, background: 1, probe: 1 }, opTimeoutMs: 200, queueWaitMs: 400 });
  const nas = tmp(), local = tmp();
  nf.registerRoot("gcode", nas);
  const hung = nf._submit("__sleep", [1500], { path: nas }).catch(e => e);   // the worker stays stuck ~1.5 s
  const t0 = Date.now();
  const err = await nf.stat(local).catch(e => e);
  assert.equal(err.code, "NETFS_BUSY");
  assert.ok(Date.now() - t0 < 900, `waited ${Date.now() - t0} ms`);
  assert.equal(nf.availability(local).status, "online", "congestion is not an outage of the other storage");
  await hung;
});

// ---------------------------------------------------------------------------
// offline → the NAS returns; starting while it is offline
// ---------------------------------------------------------------------------

test("starting with the share already offline: registering and creating the folder neither block nor throw, and it is used once it answers", async t => {
  const nf = make(t, { opTimeoutMs: 300, probeEveryMs: 100 });
  const parent = tmp();
  const nas = path.join(parent, "gcode");
  nf.registerRoot("gcode", nas);
  // What loadConfig does at startup, while the share hangs:
  let maxGap = 0, last = Date.now();
  const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 20);
  const h = await nf._submit("__sleep", [1000], { path: nas }).catch(e => e);   // the first touch hangs
  const t0 = Date.now();
  const m = await nf.mkdir(nas, { recursive: true }).catch(e => e);            // ensureFolder's mkdir
  clearInterval(iv);
  assert.ok(maxGap < 150, `the event loop stalled ${maxGap} ms`);
  assert.equal(h.code, "NAS_UNREACHABLE");
  assert.equal(m.code, "NAS_UNREACHABLE", "the folder creation fails fast once the outage is known");
  assert.ok(Date.now() - t0 < 50);
  // The share "comes back": the probe notices without anyone retrying by hand.
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(nf.availability(nas).status, "online");
  await nf.mkdir(nas, { recursive: true });
  assert.ok(fs.existsSync(nas));
});

// ---------------------------------------------------------------------------
// The sync engine and the Library share the same availability state
// ---------------------------------------------------------------------------

function syncHarness(nf, files, { onDownload } = {}) {
  const connector = {
    querySyncFiles: async () => files.map(f => ({ path: f, size: 3, modified: 1 })),
    downloadSyncFile: async (_b, _r, rel, dest) => { if (onDownload) await onDownload(rel, dest); fs.writeFileSync(dest, "abc"); },
  };
  return createSyncEngine({
    baseDir: tmp(), getConnector: () => connector,
    fileIO: {
      stat: p => nf.stat(p), mkdir: (p, o) => nf.mkdir(p, o),
      isNetworkPath: () => true, availability: p => nf.availability(p), noteError: (p, e) => nf.noteError(p, e),
    },
  });
}

test("sync: runs to a network destination go one at a time", async t => {
  const nf = make(t, { opTimeoutMs: 5000 });
  const dest = tmp(); nf.registerRoot("logs", dest);
  let active = 0, peak = 0;
  const engine = syncHarness(nf, ["a.log", "b.log"], {
    onDownload: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 50)); active--; },
  });
  t.after(() => engine.store.close && engine.store.close());
  const p1 = { id: "p1", name: "One", url: "http://127.0.0.1:1", connector: "x" };
  const p2 = { id: "p2", name: "Two", url: "http://127.0.0.1:1", connector: "x" };
  const [r1, r2] = await Promise.all([engine.runSync(p1, "logs", dest, 0), engine.runSync(p2, "logs", dest, 0)]);
  assert.equal(r1.downloaded + r2.downloaded, 4);
  assert.equal(peak, 1, "never two network downloads at once");
});

test("sync: a run stops when its destination stops answering, instead of failing file after file", async t => {
  const nf = make(t, { opTimeoutMs: 5000 });
  const dest = tmp(); nf.registerRoot("logs", dest);
  const engine = syncHarness(nf, ["a.log", "b.log", "c.log"], {
    onDownload: async rel => { if (rel === "a.log") nf.noteError(dest, UNKNOWN); },
  });
  t.after(() => engine.store.close && engine.store.close());
  const p = { id: "p1", name: "One", url: "http://127.0.0.1:1", connector: "x" };
  await assert.rejects(engine.runSync(p, "logs", dest, 0), /stopped answering/);
  assert.equal(engine.getStatus("p1", "logs").phase, "error");
  // and a new run is refused at once while it is down
  await assert.rejects(engine.runSync(p, "logs", dest, 0), /unreachable/);
});

test("Library: a location check through netfs tells ok, wrong and offline apart, and shares the breaker", async t => {
  const nf = make(t, { opTimeoutMs: 300 });
  const lib = tmp();
  const fsp = netfsFsp(nf);
  assert.equal((await checkReachable(lib, { fsp })).status, "ok");
  assert.equal((await checkReachable(path.join(lib, "missing"), { fsp })).status, "error", "missing under a parent that answers");
  fs.writeFileSync(path.join(lib, "f.txt"), "x");
  assert.equal((await checkReachable(path.join(lib, "f.txt"), { fsp })).status, "error", "not a folder");
  nf.registerRoot("lib", lib);
  nf.noteError(lib, UNKNOWN);
  const r = await checkReachable(lib, { fsp });
  assert.equal(r.status, "offline");
  assert.ok(r.ms < 50, "fails fast while the shared breaker says offline");
});

// ---------------------------------------------------------------------------
// Containment: netfs does not follow symlinks where the routes rely on lstat
// ---------------------------------------------------------------------------

test("lstat and listDir do not follow symlinks", async t => {
  const nf = make(t, { opTimeoutMs: 5000 });
  const d = tmp(), outside = tmp();
  fs.writeFileSync(path.join(outside, "secret.bin"), "s");
  try {
    fs.symlinkSync(path.join(outside, "secret.bin"), path.join(d, "link.bin"), "file");
    fs.symlinkSync(outside, path.join(d, "linkdir"), "junction");
  } catch (e) {
    if (e.code === "EPERM") return t.skip("creating symlinks needs Developer Mode or admin on Windows");
    throw e;
  }
  fs.writeFileSync(path.join(d, "real.bin"), "r");
  const st = await nf.lstat(path.join(d, "link.bin"));
  assert.equal(st.isFile, false);
  assert.equal(st.isSymbolicLink, true);
  assert.deepEqual((await nf.listDir(d)).map(e => e.name).sort(), ["real.bin"], "neither link is listed");
});
