// test/topbar.test.js — the top bar's three pure decisions:
//   topbarVisibility()   which cells show, from role, Settings/first run, the
//                        /orca/<name> deep link and Queue Management;
//   topbarActiveCells()  which cell looks active for each page, menu and the
//                        file list (the design mockup left a cell active after
//                        another page took over);
//   fleetStatusSummary() the fleet-wide status pills and "next done".
//
// Each is loaded from public/app.js into a sandbox.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
function fnSource(name) {
  const m = appSrc.match(new RegExp("function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}"));
  assert.ok(m, "missing in public/app.js: function " + name + "()");
  return m[0];
}
const sandbox = vm.createContext({});
vm.runInContext(["topbarVisibility", "topbarActiveCells", "camBucket", "printRemaining", "fleetStatusSummary"].map(fnSource).join("\n"), sandbox);
const call = (name, arg) => JSON.parse(JSON.stringify(vm.runInContext(name, sandbox)(arg)));

const shown = vis => Object.keys(vis).filter(k => vis[k]).sort();
const base = { settingsOpen: false, deepLink: false, admin: true, canAct: true, queueEnabled: true, signedIn: true };

// ---- visibility ----

test("an admin on the fleet sees every cell", () => {
  assert.deepEqual(shown(call("topbarVisibility", base)),
    ["clock", "files", "gear", "health", "heat", "library", "queue", "search", "sort", "theme", "user", "view"]);
});

test("Settings (and first run, which is Settings opened for you) hides the fleet controls but keeps the way back", () => {
  assert.deepEqual(shown(call("topbarVisibility", { ...base, settingsOpen: true })),
    ["clock", "gear", "theme", "user"]);
});

test("the /orca/<name> deep link hides search, files, sort, view, theme, Settings and the clock — for an admin too", () => {
  // The bug this replaces: init() hid gear and filesBtn, then applyRoleUI()
  // showed them again for admins / canAct() users.
  assert.deepEqual(shown(call("topbarVisibility", { ...base, deepLink: true })),
    ["health", "heat", "library", "queue", "user"]);
});

test("first run on a deep link still shows Settings' cell, so setup can be left", () => {
  assert.equal(call("topbarVisibility", { ...base, deepLink: true, settingsOpen: true }).gear, true);
});

test("role and feature gating", () => {
  const viewer = call("topbarVisibility", { ...base, admin: false, canAct: false });
  assert.equal(viewer.gear, false, "Settings is admin only");
  assert.equal(viewer.files, false, "the file list needs canAct()");
  assert.equal(call("topbarVisibility", { ...base, queueEnabled: false }).queue, false);
  assert.equal(call("topbarVisibility", { ...base, signedIn: false }).user, false, "no user cells without a signed-in user");
});

// ---- active cell ----

const page = { settingsOpen: false, healthOpen: false, queueOpen: false, libraryOpen: false, filesOpen: false, popup: null, heatOpen: false };
const active = s => call("topbarActiveCells", { ...page, ...s }).sort();

test("exactly one page cell is active, and View stands for the fleet", () => {
  assert.deepEqual(active({}), ["view"]);
  assert.deepEqual(active({ healthOpen: true }), ["health"]);
  assert.deepEqual(active({ queueOpen: true }), ["queue"]);
  assert.deepEqual(active({ libraryOpen: true }), ["library"]);
  assert.deepEqual(active({ settingsOpen: true }), ["gear"]);
});

test("a cell loses the active state when another page takes over", () => {
  // Fleet -> Health -> Library -> Settings -> back to Fleet, one state at a
  // time, as the open/close functions leave it.
  const steps = [
    [{}, ["view"]],
    [{ healthOpen: true }, ["health"]],
    [{ libraryOpen: true }, ["library"]],
    [{ queueOpen: true }, ["queue"]],
    [{ settingsOpen: true }, ["gear"]],
    [{}, ["view"]],
  ];
  for (const [state, want] of steps) assert.deepEqual(active(state), want, JSON.stringify(state));
});

test("Files adds to the page cell, and an open menu's cell is active while it's open", () => {
  assert.deepEqual(active({ filesOpen: true }), ["files", "view"]);
  assert.deepEqual(active({ filesOpen: true, healthOpen: true }), ["files", "health"]);
  assert.deepEqual(active({ popup: "sort" }), ["sort", "view"]);
  assert.deepEqual(active({ popup: "view" }), ["view"], "the View menu on the fleet doesn't add a second cell");
  assert.deepEqual(active({ queueOpen: true, popup: "view" }), ["queue", "view"]);
  assert.deepEqual(active({ popup: null }), ["view"], "closing the menu drops its cell");
});

test("while the Heat dialog is open, Heat is the only highlighted cell", () => {
  // Reported: opening Heat from Health left Health highlighted.
  assert.deepEqual(active({ heatOpen: true }), ["heat"]);
  assert.deepEqual(active({ heatOpen: true, healthOpen: true, filesOpen: true }), ["heat"]);
  assert.deepEqual(active({ heatOpen: false, healthOpen: true }), ["health"], "the page's highlight returns when it closes");
});

// ---- fleet status ----

const printer = o => ({ online: true, state: "idle", ...o });

test("counts the same buckets as the status tabs, paused included in printing", () => {
  const sum = call("fleetStatusSummary", [
    printer({ state: "printing", progress: 0.5, elapsed: 600 }),
    printer({ state: "paused", progress: 0.2, elapsed: 100 }),
    printer({ state: "printing", errorCode: "E1" }),          // an error wins over printing
    printer({ state: "complete" }),
    printer({ state: "idle" }),
    printer({ online: false, state: "printing" }),             // offline wins over everything
  ]);
  assert.deepEqual({ ...sum, nextDone: undefined }, { printing: 2, attention: 1, idle: 2, offline: 1, nextDone: undefined });
});

test("next done is the soonest estimate the time-remaining sort can make", () => {
  const sum = call("fleetStatusSummary", [
    printer({ state: "printing", progress: 0.5, elapsed: 1800 }),   // 1800 s left
    printer({ state: "printing", progress: 0.9, elapsed: 7848 }),   // 872 s left
    printer({ state: "paused", progress: 0.99, elapsed: 9999 }),    // paused: no estimate
    printer({ state: "printing", progress: 0, elapsed: 50 }),        // no progress yet
    printer({ state: "printing", progress: 0.5 }),                   // no elapsed time
  ]);
  assert.ok(Math.abs(sum.nextDone - 872) < 1e-6, String(sum.nextDone));
});

test("nothing printing: no next done", () => {
  assert.equal(call("fleetStatusSummary", [printer({}), printer({ online: false })]).nextDone, null);
  assert.equal(call("fleetStatusSummary", []).nextDone, null);
});

// ---- the cell maps name real elements ----

test("every element id the top bar's maps refer to exists in index.html", () => {
  // TB_CELLS / TB_ACTIVE_CELLS / TB_POPUPS address cells by id string; a typo
  // would silently leave a cell (or its menu-sheet stand-in) unmanaged.
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const maps = vm.createContext({});
  for (const name of ["TB_CELLS", "TB_ACTIVE_CELLS", "TB_POPUPS"]) {
    const m = appSrc.match(new RegExp("const " + name + " = (\\{[\\s\\S]*?\\n?\\});"));
    assert.ok(m, "missing in public/app.js: const " + name);
    vm.runInContext("var " + name + " = " + m[1] + ";", maps);
  }
  const referenced = [
    ...Object.values(vm.runInContext("TB_CELLS", maps)).flat(),
    ...Object.values(vm.runInContext("TB_ACTIVE_CELLS", maps)),
    ...Object.values(vm.runInContext("TB_POPUPS", maps)).flatMap(p => [p.btn, p.panel]),
  ];
  assert.ok(referenced.length > 20);
  for (const id of referenced) assert.ok(ids.has(id), `index.html has no element with id="${id}"`);
});
