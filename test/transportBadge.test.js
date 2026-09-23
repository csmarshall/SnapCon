// test/transportBadge.test.js — the "(NATIVE)" / "(MOONRAKER)" tag beside a
// FlashForge card's brand.
//
// The tag names the PROTOCOL SnapCon is driving the printer over, not the
// firmware mod — see connectors/flashforge-transport-label.test.js for why a
// mod name would be a fabrication.
//
// Two things here are easy to get wrong and invisible when wrong:
//  - p.brand is a user-editable free-text field. The tag is presentation
//    only; writing it into the brand would corrupt a value the user owns.
//  - cardSignature() is the incremental-render dedup key. A tag that is not
//    part of it renders once and then never updates, which defeats the entire
//    point: a printer that switches transport would keep the stale label.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function extractFn(name) {
  const start = appSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in public/app.js");
  return appSrc.slice(start, appSrc.indexOf("\n}", start) + 2);
}

const sandbox = {
  esc: s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  t: k => ({ "fleet.card.transport_native": "Native", "fleet.card.transport_moonraker": "Moonraker" }[k] || k),
};
vm.createContext(sandbox);
vm.runInContext(extractFn("transportLabel"), sandbox);
vm.runInContext(extractFn("brandHtml"), sandbox);
const call = (n, ...a) => vm.runInContext(n, sandbox)(...a);

test("a printer with no transport renders its brand exactly as before", () => {
  assert.equal(call("brandHtml", { brand: "SnapMaker" }), "SnapMaker");
  assert.equal(call("brandHtml", {}), "SnapMaker", "the existing default is kept");
  assert.equal(call("brandHtml", { brand: "Creality", transport: null }), "Creality");
});

test("a FlashForge on either transport is tagged", () => {
  const native = call("brandHtml", { brand: "FlashForge", transport: "native" });
  assert.match(native, /FlashForge/);
  assert.match(native, /\(Native\)/);

  const moon = call("brandHtml", { brand: "FlashForge", transport: "moonraker" });
  assert.match(moon, /\(Moonraker\)/);
});

test("the tag is presentation only — a renamed brand keeps its name and still gets tagged", () => {
  // p.brand is a free-text field the user owns (.pbrand, maxlength 30).
  const html = call("brandHtml", { brand: "Shop printer #2", transport: "moonraker" });
  assert.match(html, /Shop printer #2/, "the user's own brand text survives verbatim");
  assert.match(html, /\(Moonraker\)/);
});

test("an unrecognised transport is not echoed into the page", () => {
  // The value crosses from config.json and a connector into HTML; only the
  // two known transports may ever be rendered.
  assert.equal(call("transportLabel", { transport: "sideways" }), null);
  assert.equal(call("brandHtml", { brand: "FlashForge", transport: "sideways" }), "FlashForge");
});

test("brand text is escaped", () => {
  const html = call("brandHtml", { brand: '<img src=x onerror="alert(1)">', transport: "native" });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("both the card and the list view use the shared renderer", () => {
  // Two separate call sites render the brand; a tag added to only one is a
  // silent inconsistency between views of the same fleet.
  const uses = appSrc.match(/brandHtml\(p\)/g) || [];
  assert.ok(uses.length >= 2, `expected the card and list view to share it, found ${uses.length} call site(s)`);
  assert.doesNotMatch(appSrc, /hdr-brand">\$\{esc\(p\.brand\|\|'SnapMaker'\)\}/,
    "no call site may still inline the old brand-only markup");
});

test("cardSignature covers the transport, or the tag would never update", () => {
  const src = appSrc.slice(appSrc.indexOf("function cardSignature("));
  const body = src.slice(0, src.indexOf("\n}") + 2);
  assert.match(body, /transport/, "a transport switch must repaint the card");
});

test("the fleet row carries the transport, and only where a connector reports one", () => {
  assert.match(serverSrc, /transport:\s*conn\.getTransport/,
    "the row is fed by the connector, not by a brand check in shared code");
});
