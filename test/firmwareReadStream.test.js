// test/firmwareReadStream.test.js — folding the /api/firmware NDJSON stream
// into rows and a progress figure. (Not to be confused with
// firmwareProgress.test.js, which is about upload byte progress during a
// deploy; this one is about READING the fleet's versions.)
//
// The Firmware tab used to make one request that answered only when every
// printer had, so the wait looked identical whether the fleet was slow or the
// request had hung outright (which it did — see firmwareInventory.test.js).
// Rows now arrive in batches and the tab shows how far along it is.
//
// The fold is the part worth pinning: a dropped or duplicated batch silently
// produces a short printer list, which looks like printers having vanished.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

function extractFn(name) {
  const start = appSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in public/app.js");
  return appSrc.slice(start, appSrc.indexOf("\n}", start) + 2);
}
const sandbox = { Math };
vm.createContext(sandbox);
vm.runInContext(extractFn("firmwareStreamFold"), sandbox);
const fold = (payload, rows) => vm.runInContext("firmwareStreamFold", sandbox)(payload, rows);

test("the opening payload reports zero read without inventing rows", () => {
  const rows = [];
  const p = fold({ total: 16, read: 0 }, rows);
  assert.equal(rows.length, 0);
  // Field-by-field: the object is built inside the vm realm, so a strict deep
  // compare against a literal from this realm fails on identity alone.
  assert.equal(p.total, 16);
  assert.equal(p.read, 0);
  assert.equal(p.pct, 0);
});

test("each batch appends its rows and advances the bar", () => {
  const rows = [];
  fold({ total: 4, read: 2, rows: [{ id: 0 }, { id: 1 }] }, rows);
  const p = fold({ total: 4, read: 4, rows: [{ id: 2 }, { id: 3 }] }, rows);
  assert.equal(rows.length, 4, "every batch must be kept");
  assert.deepEqual(rows.map(r => r.id), [0, 1, 2, 3], "and kept in order");
  assert.equal(p.pct, 100);
});

test("progress is clamped and never divides by a zero total", () => {
  // An empty fleet is a legitimate answer, not a crash or a NaN-width bar.
  assert.equal(fold({ total: 0, read: 0 }, []).pct, 0);
  assert.equal(fold({ total: 4, read: 99, rows: [] }, []).pct, 100);
});

test("a payload with no rows key leaves the list alone", () => {
  const rows = [{ id: 7 }];
  fold({ total: 3, read: 1 }, rows);
  assert.deepEqual(rows, [{ id: 7 }]);
});

test("read falls back to what has actually arrived when the server omits it", () => {
  const rows = [];
  const p = fold({ total: 2, rows: [{ id: 0 }] }, rows);
  assert.equal(p.read, 1);
});

test("the connector filter hides itself when there is nothing to filter between", () => {
  // Now that the tab lists only printers SnapCon can flash — U1 today — the
  // dropdown would offer "All connectors" plus exactly one connector. That is
  // the same dead end the function's own comment rejects for unmatched
  // options, so it is hidden below two.
  const src = appSrc.slice(appSrc.indexOf("function syncFirmwareConnectorFilter("));
  const body = src.slice(0, src.indexOf("\n}") + 2);
  assert.match(body, /present\.length\s*<\s*2|present\.length\s*>=?\s*2|present\.length\s*>\s*1/,
    "must decide visibility on how many connectors are present");
  assert.match(body, /display/, "and actually hide the control");
});

test("the client asks for the stream and survives a server that never says done", () => {
  // streamNdjson returns the last done/error payload, or null if the stream
  // ended early (printer unplugged mid-sweep, server restarted). loadFirmware
  // must fall back to the rows it did receive rather than blanking the list.
  const src = appSrc.slice(appSrc.indexOf("async function loadFirmware("));
  const body = src.slice(0, src.indexOf("\n}") + 2);
  assert.match(body, /streamNdjson\("\/api\/firmware\?stream=1"/,
    "must ASK for the stream — the bare endpoint still answers with a JSON array");
  assert.match(body, /firmwareStreamFold/, "must fold batches as they arrive");
  assert.match(body, /d&&d\.rows|d\?\.rows|acc/, "must cope with no final done payload");
});
