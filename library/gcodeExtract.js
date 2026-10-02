// library/gcodeExtract.js — what the Library reads out of a sliced G-code file
// (docs/library-design.md §6.2): thumbnails, the slicer that wrote it, object
// names with copy counts, the config block's profile identity, and the
// palette/time/weight parser.js already knows how to read.
//
// Pure: no I/O. The indexer reads an adaptive window (P2) — the first 512 KB
// and the last 256 KB, grown ×4 up to 3 MB when the window ends inside the
// thumbnails/object definitions or holds no config block — and hands the
// bytes here. windowNeeds() is the cheap check that decides the growing.
// A file whose config block is not within 3 MB of its end is parsed whole,
// streamed line by line through the same extractor (createExtractor).
"use strict";
const crypto = require("crypto");
const { parseGcodeMap, _internal: { matchCfgLine } } = require("../parser");

// Bump when the extraction changes what it reads: files indexed under an older
// version are read again on the next scan.
//   2  Creality thumbnail block forms recognised
const RULE_VERSION = 2;
const HEAD_INITIAL = 512 * 1024;
const TAIL_INITIAL = 256 * 1024;
const WINDOW_MAX = 3 * 1024 * 1024;
const EXCERPT_MAX = 200;
const OBJECTS_MAX = 500;         // per file, so a pathological file can't balloon the index
const THUMB_MAX_BYTES = 2 * 1024 * 1024;

// "; thumbnail begin 300x300 …", "; thumbnail_JPG begin …", and the forms
// seen in real Creality files: "; png begin 96*96 …" (Creality Print) and
// "; thumbnail begin 300 300 …" — base64 PNG like the rest. Every block is
// recognised so its data lines are never read as anything else; only data
// that decodes to a real PNG/JPEG is kept as a picture.
const THUMB_BEGIN = /^;\s*(?:thumbnail(?:_(\w+))?|(png|jpe?g|qoi))\s+begin\s+(\d+)\s*[x*\s]\s*(\d+)/i;
const THUMB_END = /^;\s*(?:thumbnail(?:_\w+)?|png|jpe?g|qoi)\s+end\b/i;
const THUMB_BEGIN_ANY = /^;\s*(?:thumbnail(?:_\w+)?|png|jpe?g|qoi)\s+begin\b/gim;
const THUMB_END_ANY = /^;\s*(?:thumbnail(?:_\w+)?|png|jpe?g|qoi)\s+end\b/gim;
const CONFIG_MARK = /^;\s*(?:CONFIG_BLOCK_START\b|printer_model\s*=|prusaslicer_config\s*=\s*begin)/m;
const BODY_START = /^(?:;\s*EXECUTABLE_BLOCK_START\b|G[01]\s[^\n]*[XY]-?\d)/m;

// Does this window need to grow? head/tail are Buffers (tail may be null when
// the head already covers the whole file).
function windowNeeds(head, tail) {
  const h = head.toString("latin1");
  const begins = (h.match(THUMB_BEGIN_ANY) || []).length;
  const ends = (h.match(THUMB_END_ANY) || []).length;
  const growHead = begins > ends || !BODY_START.test(h);
  const growTail = !!tail && !CONFIG_MARK.test(tail.toString("latin1")) && !CONFIG_MARK.test(h);
  return { growHead, growTail, openThumbnail: begins > ends, bodyStart: BODY_START.test(h) };
}

// ---- object names ----
// Orca/Bambu write one EXCLUDE_OBJECT_DEFINE per placed instance, named
// "<object>_id_<n>_copy_<m>" ("<object> id:<n> copy <m>" in "; printing
// object" lines); the copy count is the number of instances.
const ORCA_INSTANCE = /^(.*?)[ _]id[:_](\d+)[ _]copy[ _](\d+)$/;
const GENERIC = new Set(["assembly", "object", "objects", "body", "part", "parts", "model", "mesh", "untitled", "plate", "shape", "cube", "group"]);

function normaliseObjectName(raw) {
  let s = String(raw || "").trim().replace(/^["']|["']$/g, "");
  const m = ORCA_INSTANCE.exec(s);
  const base = m ? m[1] : s;
  const norm = base.replace(/\.(stl|obj|3mf|step|stp|amf|ply)$/i, "").replace(/[_\s]+/g, " ").trim().toLowerCase();
  const stem = norm.replace(/[\s\-_.#]*\d+$/, "").trim();
  const generic = !norm || /^\d+$/.test(norm) || GENERIC.has(norm) || GENERIC.has(stem);
  return { base, norm: norm || base.toLowerCase(), instance: m ? `${m[2]}:${m[3]}` : null, generic };
}

// ---- small parsers ----
function parseDuration(s) {
  if (!s) return null;
  let total = 0, any = false;
  for (const [, n, u] of String(s).matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) {
    any = true;
    total += parseFloat(n) * { d: 86400, h: 3600, m: 60, s: 1 }[u.toLowerCase()];
  }
  return any ? Math.round(total) : null;
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const cut = s => (s == null ? null : String(s).slice(0, EXCERPT_MAX));
const firstOf = v => (v == null ? null : String(v).split(/[;,]/)[0].trim() || null);

// "OrcaSlicer 2.4.2", "Creality_Print V7.0.0.4127", "Snapmaker Orca 2.1.1"
function splitGenerator(g) {
  if (!g) return { slicer: null, version: null };
  const parts = String(g).trim().split(/\s+/);
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^v?\d/i.test(last)) return { slicer: parts.slice(0, -1).join(" "), version: last.replace(/^v/i, "") };
  return { slicer: String(g).trim(), version: null };
}

// ---- the extractor: feed lines, then result() ----
function createExtractor() {
  const cfg = {}, cfgRaw = {};
  const objects = new Map();   // key norm|origin -> { norm, raw, origin, instances:Set, generic, excerpt }
  const thumbs = [];           // { fmt, w, h, b64len, data|null }
  let generator = null, embeddedMd5 = null, thumb = null, lines = 0, objectsCapped = false;

  function addObject(raw, origin, line) {
    const n = normaliseObjectName(raw);
    if (!n.norm) return;
    const key = n.norm + "|" + origin;
    let o = objects.get(key);
    if (!o) {
      if (objects.size >= OBJECTS_MAX) { objectsCapped = true; return; }
      o = { norm: n.norm, raw: n.base, origin, instances: new Set(), generic: n.generic, excerpt: cut(line.trim()) };
      objects.set(key, o);
    }
    o.instances.add(n.instance || raw);
  }

  function feed(line) {
    lines++;
    if (thumb) {
      if (THUMB_END.test(line)) { thumbs.push(thumb); thumb = null; }
      else if (thumb.parts) {
        const d = line.replace(/^;\s?/, "").trim();
        thumb.b64len += d.length;
        if (thumb.b64len * 0.75 > THUMB_MAX_BYTES) thumb.parts = null;   // too big to keep; still counted
        else thumb.parts.push(d);
      }
      return;
    }
    const tb = THUMB_BEGIN.exec(line);
    if (tb) { thumb = { fmt: (tb[1] || tb[2] || "PNG").toUpperCase(), w: +tb[3], h: +tb[4], b64len: 0, parts: [] }; return; }
    if (line.charCodeAt(0) === 59 /* ; */) {
      if (!generator) { const g = /^;\s*generated by\s+(.+?)(?:\s+on\s+\d{4}-\d{2}-\d{2}.*)?\s*$/i.exec(line); if (g) generator = g[1].trim(); }
      if (!embeddedMd5) { const m = /^;\s*MD5:\s*([0-9a-f]{32})/i.exec(line); if (m) embeddedMd5 = m[1].toLowerCase(); }
      const po = /^;\s*printing object\s+(.+?)\s*$/i.exec(line);
      if (po) { addObject(po[1], "printing_object", line); return; }
      const m = matchCfgLine(line);
      if (m) { const k = m.key.toLowerCase(); cfg[k] = m.value; cfgRaw[k] = line.trim(); }
      return;
    }
    if (/^EXCLUDE_OBJECT_DEFINE\b/i.test(line)) {
      const n = /\bNAME=(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(line);
      if (n) addObject(n[1] ?? n[2] ?? n[3], "exclude_object", line);
      return;
    }
    if (/^M486\b/i.test(line)) {
      const a = /\bA(?:"([^"]*)"|(\S.*?))\s*$/i.exec(line);
      if (a) addObject((a[1] ?? a[2]).trim(), "m486", line);
    }
  }

  function bestThumbnail() {
    // The largest PNG or JPG. QOI and others can't be served to a browser.
    const ok = thumbs.filter(t => t.parts && (t.fmt === "PNG" || t.fmt === "JPG" || t.fmt === "JPEG"));
    ok.sort((a, b) => b.w * b.h - a.w * a.h);
    for (const t of ok) {
      const data = Buffer.from(t.parts.join(""), "base64");
      const png = data.length > 8 && data[0] === 0x89 && data[1] === 0x50;
      const jpg = data.length > 3 && data[0] === 0xff && data[1] === 0xd8;
      if (png || jpg) return { mime: png ? "image/png" : "image/jpeg", ext: png ? "png" : "jpg", w: t.w, h: t.h, data };
    }
    return null;
  }

  function result() {
    if (thumb) thumbs.push({ ...thumb, parts: null, unterminated: true });
    // parser.js reads palette, time and weight from the config lines alone
    // when the body is not scanned, so it is handed exactly those.
    const p = parseGcodeMap(Object.entries(cfgRaw).map(([, l]) => l).join("\n"), { scanBody: false });
    const { slicer, version } = splitGenerator(generator);
    const weights = String(cfg["filament used [g]"] || cfg["filament_used_g"] || cfg["filament used [grams]"] || "")
      .split(/[,;]/).map(num).filter(n => n != null);
    const configBlock = Object.keys(cfg).length > 0 && ("printer_model" in cfg || "printer_settings_id" in cfg || "layer_height" in cfg);
    const hashKeys = Object.keys(cfg).filter(k => !/time|used|cost|date|^total |^model printing/i.test(k)).sort();
    const objs = [...objects.values()].map(o => ({ norm: o.norm, raw: o.raw, origin: o.origin, copies: Math.max(1, o.instances.size), generic: o.generic, excerpt: o.excerpt }));
    // Copies of the model: the most instances of any one object. Different
    // objects (a head and a body) are parts, not copies.
    const copies = objs.length ? Math.max(...objs.map(o => o.copies)) : null;
    const thumbnail = bestThumbnail();
    return {
      ruleVersion: RULE_VERSION,
      generator, slicer, slicerVersion: version, embeddedMd5, lines,
      identity: {   // what public/printer-identity.js reads
        printerModel: cfg["printer_model"] || null,
        printerSettingsId: cfg["printer_settings_id"] || null,
        printCompatiblePrinters: cfg["print_compatible_printers"] || null,
        defaultPrintProfile: cfg["default_print_profile"] || null,
        printerModelId: cfg["printer_model_id"] || null,
      },
      excerpts: Object.fromEntries(["printer_model", "printer_settings_id", "print_compatible_printers", "default_print_profile", "printer_model_id"]
        .filter(k => cfgRaw[k]).map(k => [k, cut(cfgRaw[k])])),
      variant: {
        printer_model: cfg["printer_model"] || null,
        printer_model_id: cfg["printer_model_id"] || null,
        printer_settings_id: cfg["printer_settings_id"] || null,
        print_settings_id: cfg["print_settings_id"] || null,
        compatible_printers: cfg["print_compatible_printers"] || cfg["compatible_printers"] || null,
        filament_settings_json: cfg["filament_settings_id"] ? JSON.stringify(String(cfg["filament_settings_id"]).split(/;/).map(s => s.trim().replace(/^"|"$/g, ""))) : null,
        filaments_json: JSON.stringify(p.palette.filter(s => s.present).map(s => ({ i: s.i, hex: s.hex, type: s.type, vendor: s.vendor, used: s.used, g: num(s.wt) }))),
        layer_height: num(cfg["layer_height"]),
        nozzle: num(firstOf(cfg["nozzle_diameter"])),
        bed_json: (cfg["printable_area"] || cfg["curr_bed_type"] || cfg["bed_shape"])
          ? JSON.stringify({ printable_area: cfg["printable_area"] || cfg["bed_shape"] || null, printable_height: num(cfg["printable_height"] || cfg["max_print_height"]), bed_type: cfg["curr_bed_type"] || null }) : null,
        slicer, slicer_version: version,
        config_block: configBlock ? 1 : 0,
        config_hash: configBlock ? crypto.createHash("sha1").update(hashKeys.map(k => k + "=" + cfg[k]).join("\n")).digest("hex") : null,
        est_seconds: parseDuration(cfg["estimated printing time (normal mode)"] || cfg["model printing time"] || cfg["total estimated time"] || cfg["estimated printing time"]),
        weight_g: weights.length ? +weights.reduce((a, b) => a + b, 0).toFixed(2) : null,
        copies,
        color_count: p.usedIdx.length || null,
      },
      objects: objs, objectsCapped,
      thumbnails: thumbs.map(t => ({ fmt: t.fmt, w: t.w, h: t.h, bytes: Math.round(t.b64len * 0.75), kept: !!t.parts, unterminated: !!t.unterminated })),
      thumbnail,
    };
  }
  return { feed, result };
}

// The windowed form: head and tail are Buffers; tail is null when the head is
// the whole file. A line cut by the window edge is dropped rather than half-read.
function extractFromWindow(head, tail, { wholeFile = false } = {}) {
  const ex = createExtractor();
  const headLines = head.toString("utf8").split(/\r?\n/);
  if (!wholeFile) headLines.pop();                    // may be cut mid-line
  for (const l of headLines) ex.feed(l);
  if (tail) {
    const tailLines = tail.toString("utf8").split(/\r?\n/);
    tailLines.shift();                                // may be cut mid-line
    for (const l of tailLines) ex.feed(l);
  }
  return ex.result();
}

module.exports = {
  RULE_VERSION, HEAD_INITIAL, TAIL_INITIAL, WINDOW_MAX,
  windowNeeds, createExtractor, extractFromWindow, normaliseObjectName, parseDuration, splitGenerator,
};
