// test/printFarmViewMode.test.js — entering and leaving the Print farm view
// must leave the fleet display classes matching VIEW_MODE.
//
// Bug, reproduced in a browser on 2026-10-04: in List view, open Print farm
// with the Queue button, then click it again to go back. VIEW_MODE came back
// as 'regular' but body.listview was still on, so the Full-view cards rendered
// in List view's single-column layout with List view's toolbar. The same
// happened from Camera view (body.camview, and no closeAllCamRtc()).
// openQueueDashboard()/closeQueueDashboard() assigned VIEW_MODE directly
// instead of going through applyViewMode(), the one place that keeps the body
// classes, Camera View sessions and grid-toolbar state in step with it.
//
// The real functions are loaded from public/app.js into a sandbox with just
// enough of a DOM to run them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function fnSource(name) {
  const m = appSrc.match(new RegExp("function " + name + "\\(\\)\\{[\\s\\S]*?\\n\\}"));
  assert.ok(m, "missing in public/app.js: function " + name + "()");
  return m[0];
}

function classList() {
  const set = new Set();
  return {
    add: c => set.add(c),
    remove: c => set.delete(c),
    contains: c => set.has(c),
    toggle: (c, on) => { if (on === undefined) on = !set.has(c); if (on) set.add(c); else set.delete(c); return on; },
    has: c => set.has(c),
  };
}

function load(startMode) {
  const els = {};
  const el = id => (els[id] = els[id] || { id, title: "", style: {}, classList: classList() });
  const calls = { closeAllCamRtc: 0 };
  const sandbox = {
    $: el,
    document: { body: { classList: classList() }, querySelectorAll: () => [] },
    window: {},
    t: k => k,
    setInterval: () => 1,
    clearInterval: () => {},
    closeHealthPage: () => {},
    closeAllCamRtc: () => { calls.closeAllCamRtc++; },
    syncViewModeButtonIcon: () => {},
    updateTopbarViewLabel: () => {},
    startFleetRefresh: () => {},
    refreshQueueDashboard: () => {},
    applyRoleUI: () => {},
    CAM_SELECTED: new Set(),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    "var VIEW_MODE=" + JSON.stringify(startMode) + "; var QUEUE_VIEW_TIMER=null; var CAM_TAB='all'; var CAM_TAG_FILTER='';\n" +
    ["gridToolbarActive", "applyViewMode", "openQueueDashboard", "closeQueueDashboard"].map(fnSource).join("\n"),
    sandbox
  );
  // Start from a correctly applied view, as the page would be.
  vm.runInContext("applyViewMode()", sandbox);
  calls.closeAllCamRtc = 0;
  const body = sandbox.document.body.classList;
  const viewClasses = () => ["compact", "camview", "listview"].filter(c => body.has(c));
  return { run: code => vm.runInContext(code, sandbox), viewClasses, calls };
}

test("List view → Print farm → back leaves no List view class behind", () => {
  const s = load("list");
  assert.deepEqual(s.viewClasses(), ["listview"]);
  s.run("openQueueDashboard()");
  assert.equal(s.run("VIEW_MODE"), "printfarm");
  assert.deepEqual(s.viewClasses(), [], "Print farm is not List view");
  s.run("closeQueueDashboard()");
  assert.equal(s.run("VIEW_MODE"), "regular");
  assert.deepEqual(s.viewClasses(), [], "back on the Full view, which has no view class");
});

test("Camera view → Print farm releases Camera View sessions and its class", () => {
  const s = load("camera");
  s.run("openQueueDashboard()");
  assert.deepEqual(s.viewClasses(), []);
  assert.ok(s.calls.closeAllCamRtc > 0, "live camera sessions are closed on the way to Print farm");
  s.run("closeQueueDashboard()");
  assert.deepEqual(s.viewClasses(), []);
});

test("Compact view → Print farm → back returns to Full, as before", () => {
  const s = load("compact");
  s.run("openQueueDashboard()");
  s.run("closeQueueDashboard()");
  assert.equal(s.run("VIEW_MODE"), "regular");
  assert.deepEqual(s.viewClasses(), []);
});
