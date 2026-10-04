// test/queueItemSub.test.js — a queue item made by the Upload button must
// remember which subfolder its file lives in.
//
// The bug: /api/print built its queue item as `file: { name, sub: "" }`, keeping
// only the basename. Dispatch rebuilds the path as `sub + "/" + name` and
// re-verifies the file BEFORE it looks at alreadyUploaded, so any file below
// the top of the G-code folder failed as "file-missing" — even one already
// sitting on the printer. Nearly every file in a real library is in a
// subfolder, and "Upload into queue" sends every pooled upload down this path.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { resolveWithinFolder } = require("../pathSafety");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const at = serverSrc.indexOf("function queueFileRef(");
assert.ok(at > 0, "queueFileRef must exist in server.js");
const sandbox = { path };
vm.createContext(sandbox);
vm.runInContext(serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2), sandbox);
const queueFileRef = (fp, folder) => vm.runInContext("queueFileRef", sandbox)(fp, folder);

const FOLDER = path.resolve(__dirname, "fixtures-gcode-root");
// Exactly how attemptQueueDispatch turns an item back into a path.
const dispatchPath = f => resolveWithinFolder((f.sub ? f.sub + "/" : "") + f.name, FOLDER);

test("a file in a nested subfolder keeps its subfolder", () => {
  const fp = path.join(FOLDER, "U1", "Cinderwin 3D", "Hippocampus (Unicorn) (9h48m).gcode");
  const ref = queueFileRef(fp, FOLDER);
  assert.equal(ref.name, "Hippocampus (Unicorn) (9h48m).gcode");
  assert.equal(ref.sub, "U1/Cinderwin 3D", "sub is '/'-separated, whatever the platform");
  assert.equal(dispatchPath(ref), fp, "dispatch must find the same file the upload used");
});

test("a file at the top of the folder has an empty sub", () => {
  const fp = path.join(FOLDER, "K1C.gcode");
  const ref = queueFileRef(fp, FOLDER);
  assert.deepEqual({ ...ref }, { name: "K1C.gcode", sub: "" });
  assert.equal(dispatchPath(ref), fp);
});

test("/api/print's queue item is built from the real location, not a bare name", () => {
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/print"'));
  const body = route.slice(0, route.indexOf("\napp."));
  assert.doesNotMatch(body, /sub:\s*""/, "a hard-coded empty sub drops the subfolder");
  // M7: relative to the folder the file was resolved in — the G-code folder,
  // or the Library location it came from, which the item then names as root.
  assert.match(body, /queueFileRef\(fp, ref\.dir\)/);
  assert.match(body, /ref\.root !== GCODE_ROOT \? \{ root: ref\.root \}/);
  const resolver = serverSrc.slice(serverSrc.indexOf("async function resolveFileRef("));
  assert.match(resolver.slice(0, resolver.indexOf("\n}")), /return fp \? \{ fp, root: GCODE_ROOT, dir: FOLDER \} : null;/, "no root: the G-code folder, exactly as before");
});
