// test/skipIdenticalUpload.test.js — not re-uploading a file the printer
// already has, byte for byte.
//
// Measured on real hardware: verifying a 65,705,578-byte job on U1 Gold took
// 309ms and moved 192KB. The upload it replaces moves the whole file.
//
// The rule this pins down is that verification may only ever SKIP work, never
// block it. Every uncertain answer — an old printer, a refused Range read, a
// connector with no comparison at all, the setting off — has to fall through
// to the upload SnapCon performs today. A false "identical" would start a
// print from the wrong bytes, so ambiguity must never resolve that way.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

function extractFn(name) {
  const a = serverSrc.indexOf("async function " + name + "(");
  const b = serverSrc.indexOf("function " + name + "(");
  const at = a >= 0 ? a : b;
  assert.ok(at > 0, name + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2);
}

function harness({ cfg = {}, connector = {}, compare } = {}) {
  const calls = [];
  const sandbox = {
    console: { log() {}, error() {} },
    CFG: cfg,
    getConnector: () => Object.assign({
      compareRemoteFile: compare === undefined
        ? async (...a) => { calls.push(a); return { present: true, sameSize: true, identical: true }; }
        : compare,
    }, connector),
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn("decideUpload"), sandbox);
  const decide = (p, name, fp) => vm.runInContext("decideUpload", sandbox)(p, name, fp);
  return { calls, decide, run: async (...a) => (await decide(...a)).action === "skip" };
}
const P = { connector: "snapmaker-u1-klipper-ws", name: "U1 Gold", url: "http://x" };

// ---- the setting ----

test("skips when the printer already has the identical file", async () => {
  const h = harness();
  assert.equal(await h.run(P, "job.gcode", "/local/job.gcode"), true);
});

test("the setting defaults ON when absent from config", async () => {
  // Matches allowMapping/suggestMatching: absence means enabled.
  const h = harness({ cfg: {} });
  assert.equal(await h.run(P, "job.gcode", "/local/job.gcode"), true);
});

test("turning the setting off restores today's behaviour exactly", async () => {
  const h = harness({ cfg: { skipIdenticalUploads: false } });
  assert.equal(await h.run(P, "job.gcode", "/local/job.gcode"), false);
  assert.equal(h.calls.length, 0, "the printer must not even be asked when the feature is off");
});

// ---- failing closed ----

test("a file the printer does not have is uploaded", async () => {
  const h = harness({ compare: async () => ({ present: false, sameSize: false, identical: false }) });
  assert.equal(await h.run(P, "job.gcode", "/local/job.gcode"), false);
});

test("same name, different content is uploaded", async () => {
  const h = harness({ compare: async () => ({ present: true, sameSize: true, identical: false }) });
  assert.equal(await h.run(P, "job.gcode", "/local/job.gcode"), false);
});

test("an unverifiable answer is uploaded, never assumed identical", async () => {
  // A printer that refuses Range reads reports sameSize with unverified:true.
  const h = harness({ compare: async () => ({ present: true, sameSize: true, identical: false, unverified: true }) });
  assert.equal(await h.run(P, "job.gcode", "/local/job.gcode"), false);
});

test("a comparison that throws is uploaded, not skipped", async () => {
  const h = harness({ compare: async () => { throw new Error("Moonraker 500"); } });
  assert.equal(await h.run(P, "job.gcode", "/local/job.gcode"), false);
});

test("a connector with no comparison support is uploaded", async () => {
  // FlashForge native, Bambu, the simulator: no compareRemoteFile at all.
  const h = harness({ connector: { compareRemoteFile: undefined } });
  assert.equal(await h.run(P, "job.gcode", "/local/job.gcode"), false);
});

test("a truthy-but-not-true identical value is not consent", async () => {
  for (const v of ["yes", 1, {}, "true"]) {
    const h = harness({ compare: async () => ({ present: true, sameSize: true, identical: v }) });
    assert.equal(await h.run(P, "job.gcode", "/local/job.gcode"), false, `identical=${JSON.stringify(v)} must not skip`);
  }
});

// ---- overwriteDifferentFiles: refusing to replace a file that differs ----

test("overwriting a differing file is allowed by default", async () => {
  // Re-slicing and re-sending under the same name is the normal iterate loop,
  // so today's behaviour has to survive an upgrade untouched.
  const h = harness({ compare: async () => ({ present: true, sameSize: false, identical: false }) });
  assert.equal((await h.decide(P, "job.gcode", "/local/job.gcode")).action, "upload");
});

test("with the guard on, a proven-different file of the same name is refused", async () => {
  const h = harness({
    cfg: { overwriteDifferentFiles: false },
    compare: async () => ({ present: true, sameSize: false, identical: false }),
  });
  const d = await h.decide(P, "job.gcode", "/local/job.gcode");
  assert.equal(d.action, "refuse");
  assert.match(d.reason, /already has a different file/i);
  assert.match(d.reason, /Settings/, "the message must say where to change it");
});

test("the guard never refuses a file the printer does not have", async () => {
  const h = harness({
    cfg: { overwriteDifferentFiles: false },
    compare: async () => ({ present: false, sameSize: false, identical: false }),
  });
  assert.equal((await h.decide(P, "job.gcode", "/local/job.gcode")).action, "upload");
});

test("the guard never refuses on an UNVERIFIABLE difference", async () => {
  // A printer that cannot be sampled tells us nothing about whether the copy
  // differs. Refusing there would block every send to that printer — far worse
  // than the clobber being guarded against.
  const h = harness({
    cfg: { overwriteDifferentFiles: false },
    compare: async () => ({ present: true, sameSize: true, identical: false, unverified: true }),
  });
  assert.equal((await h.decide(P, "job.gcode", "/local/job.gcode")).action, "upload");
});

test("an identical file is still skipped while the guard is on", async () => {
  const h = harness({ cfg: { overwriteDifferentFiles: false } });
  assert.equal((await h.decide(P, "job.gcode", "/local/job.gcode")).action, "skip");
});

test("the guard still works when skipping is switched off", async () => {
  // The two settings are independent; one being off must not disable the other.
  const h = harness({
    cfg: { skipIdenticalUploads: false, overwriteDifferentFiles: false },
    compare: async () => ({ present: true, sameSize: false, identical: false }),
  });
  assert.equal((await h.decide(P, "job.gcode", "/local/job.gcode")).action, "refuse");
});

test("both settings off asks the printer nothing at all", async () => {
  // No decision either could change — the round trip would be pure waste.
  const h = harness({ cfg: { skipIdenticalUploads: false, overwriteDifferentFiles: true } });
  assert.equal((await h.decide(P, "job.gcode", "/local/job.gcode")).action, "upload");
  assert.equal(h.calls.length, 0);
});

test("a refusal reaches the user as a 409, not as a failed job", async () => {
  const at = serverSrc.indexOf('app.post("/api/print"');
  const route = serverSrc.slice(at, serverSrc.indexOf("\napp.", at + 10));
  assert.match(route, /plan\.action === "refuse"[\s\S]{0,120}409/,
    "the refusal must be answered before a job id is handed out");
});

test("a queued job that would overwrite a differing file fails loudly", async () => {
  const at = serverSrc.indexOf("async function attemptQueueDispatch(");
  const fn = serverSrc.slice(at, serverSrc.indexOf("\n}\n", at));
  assert.match(fn, /plan\.action === "refuse"[\s\S]{0,120}throw/,
    "a queue item must not silently print whatever was already there");
});

test("the overwrite setting round-trips with an ON default", async () => {
  assert.match(serverSrc, /overwriteDifferentFiles: CFG\.overwriteDifferentFiles !== false/);
  assert.match(serverSrc, /overwriteDifferentFiles: \(typeof b\.overwriteDifferentFiles === "boolean"\)/);
});

// ---- wiring ----

test("the upload path consults it, and still uploads when it says no", async () => {
  const at = serverSrc.indexOf('app.post("/api/print"');
  const route = serverSrc.slice(at, serverSrc.indexOf("\napp.", at + 10));
  assert.match(route, /decideUpload/, "/api/print must consult it");
  assert.match(route, /uploadFile/, "and must still be able to upload");
});

test("the queue consults it too", async () => {
  const at = serverSrc.indexOf("async function attemptQueueDispatch(");
  const fn = serverSrc.slice(at, serverSrc.indexOf("\n}\n", at));
  assert.match(fn, /decideUpload/, "the queue reaches the same printers and was asked to behave the same");
});

test("the job reports whether the upload was skipped", async () => {
  // Otherwise a skipped transfer is indistinguishable from a broken one.
  const at = serverSrc.indexOf('app.get("/api/print-status"');
  const route = serverSrc.slice(at, serverSrc.indexOf("\n});", at));
  assert.match(route, /skippedUpload/);
  assert.match(appSrc, /skippedUpload/, "and the client must be able to say so");
});

test("the setting round-trips through config with an ON default", async () => {
  assert.match(serverSrc, /skipIdenticalUploads: CFG\.skipIdenticalUploads !== false/,
    "publicCfg must report the default-ON value");
  assert.match(serverSrc, /skipIdenticalUploads: \(typeof b\.skipIdenticalUploads === "boolean"\)/,
    "the save path must preserve an explicit false");
});
