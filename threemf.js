// threemf.js — reads a .3mf, which is a zip holding a slicer's project.
//
// SnapCon needs three things out of one: whether it can be printed at all,
// which printer it was sliced for, and the same header comments every plain
// gcode file has (so colours, weights and times keep coming from parser.js
// rather than a second, Bambu-shaped parser).
//
// WHY CONTENT, NEVER THE NAME. Two files exported from Bambu Studio on the same
// afternoon, both called .3mf, were an unsliced project and a sliced plate. The
// first cannot print — the printer is asked for Metadata/plate_1.gcode and
// there isn't one — and nothing about the file name says so. Every question
// here is answered by opening the archive.
//
// Scope: a *Bambu* .3mf. The library has accepted .3mf since FlashForge's AD5X
// (that is its multi-material format), and those files must keep behaving
// exactly as they did, so isBambu() decides who this applies to.
//
// Top level, beside parser.js, because both the server (library listing,
// colours, thumbnails) and the Bambu connector read it. Needs a Dockerfile COPY
// line — test/docker.test.js enforces that.
"use strict";
const fs = require("fs");
const { openZipSync, ZipError } = require("./library/zipReader");

// A .3mf is tens of megabytes at most; the entry SnapCon reads out of one is
// the plate's gcode, a few MB. The cap is defence against a crafted archive
// claiming a gigabyte, not a real-file limit.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

// ---- the zip itself ----
// library/zipReader.js, the Library's hardened reader: zip64, unicode names,
// data descriptors, CRC-checked entries, and limits on every length a crafted
// archive could lie about. Read synchronously here — callers already run this
// off the main thread (netfs workers) or on local files.
function withArchive(file, fn) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const readAt = (pos, len) => {
      const b = Buffer.alloc(len);
      const n = fs.readSync(fd, b, 0, len, pos);
      if (n !== len) throw new ZipError("ZIP_TRUNCATED", "damaged zip: short read");
      return b;
    };
    const zip = openZipSync(readAt, size);
    return fn(zip, zip.entries);
  } finally {
    fs.closeSync(fd);
  }
}
const readEntry = (zip, name, maxBytes) => zip.read(name, { maxBytes: Math.min(maxBytes, MAX_ENTRY_BYTES) });

// The directory as name -> entry, for callers that only list names.
function readDirectory(file) { return withArchive(file, (zip, entries) => entries); }

// ---- what SnapCon asks of a .3mf ----

const PLATE_GCODE_RE = /^Metadata\/plate_(\d+)\.gcode$/;

// Bambu Studio and Orca both write the printer into project_settings.config,
// in a sliced project and an unsliced one alike (checked against real files
// from five vendors). That is what tells a Bambu .3mf from an AD5X one.
function isBambuSettings(json) {
  const text = [json && json.printer_model, json && json.printer_settings_id]
    .filter(v => typeof v === "string").join(" ").toLowerCase();
  return /bambu\s*lab/.test(text);
}

// A filament number from the file, or null: an integer 1..64 (AMS units hold
// 4 trays and a printer takes at most a few). The id indexes arrays built from
// it, so a crafted "4294967295" must never reach them (M8 security review).
const MAX_FILAMENTS = 64;
function filamentId(v) { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= MAX_FILAMENTS ? n : null; }

function parseSliceInfo(xml) {
  const out = { printerModelId: null, nozzle: null, filaments: [], plateFilaments: {}, prediction: null, weight: null };
  if (!xml) return out;
  // Each plate lists the filaments IT uses, by the project's filament id
  // (1-based): a multi-plate project's plates use different ones.
  for (const pm of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const idx = /<metadata key="index" value="(\d+)"/.exec(pm[1]);
    if (!idx) continue;
    out.plateFilaments[Number(idx[1])] = [...pm[1].matchAll(/<filament\b([^>]*)\/>/g)].map(f => {
      const a = (k) => { const v = new RegExp(`${k}="([^"]*)"`).exec(f[1]); return v ? v[1] : null; };
      return { id: filamentId(a("id")), type: a("type"), color: a("color"), trayInfoIdx: a("tray_info_idx"), usedG: Number(a("used_g")) || null };
    }).filter(f => f.id);
  }
  const meta = (key) => {
    const m = new RegExp(`<metadata key="${key}" value="([^"]*)"`).exec(xml);
    return m ? m[1] : null;
  };
  out.printerModelId = meta("printer_model_id");
  const nozzle = meta("nozzle_diameters");
  out.nozzle = nozzle ? Number(String(nozzle).split(/[,;\s]/)[0]) : null;
  const prediction = Number(meta("prediction"));
  out.prediction = Number.isFinite(prediction) ? prediction : null;
  const weight = Number(meta("weight"));
  out.weight = Number.isFinite(weight) ? weight : null;
  for (const m of xml.matchAll(/<filament\b([^>]*)\/>/g)) {
    const attr = (k) => { const a = new RegExp(`${k}="([^"]*)"`).exec(m[1]); return a ? a[1] : null; };
    out.filaments.push({
      id: Number(attr("id")) || out.filaments.length + 1,
      type: attr("type"),
      color: attr("color"),
      // Bambu's own filament id (GFA00 = PLA Basic, GFG00 = PETG Basic): what
      // the AMS trays report too, so the two can be matched on material rather
      // than colour alone.
      trayInfoIdx: attr("tray_info_idx"),
      usedG: Number(attr("used_g")) || null
    });
  }
  return out;
}

// One pass over the archive: everything the library row and the Send dialog
// need. Never throws for a damaged or unreadable file — the library still has
// to draw a row for it — so a failure comes back as `error`.
function read(file, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const info = {
    isBambu: false, sliced: false, plates: [], error: null,
    printerModelId: null, nozzle: null, filaments: [], prediction: null, weight: null,
    printerModel: null
  };
  try {
    withArchive(file, (zip, entries) => {
      if (entries.has("Metadata/project_settings.config")) {
        try {
          const json = JSON.parse(readEntry(zip, "Metadata/project_settings.config", maxBytes).toString("utf8"));
          info.isBambu = isBambuSettings(json);
          info.printerModel = (json && json.printer_model) || null;
        } catch { /* unreadable settings: not identifiable as Bambu */ }
      }
      info.plates = [...entries.keys()]
        .map(n => PLATE_GCODE_RE.exec(n)).filter(Boolean)
        .map(m => Number(m[1])).sort((a, b) => a - b);
      info.sliced = info.plates.length > 0;
      if (entries.has("Metadata/slice_info.config")) {
        try { Object.assign(info, parseSliceInfo(readEntry(zip, "Metadata/slice_info.config", maxBytes).toString("utf8"))); }
        catch { /* the row survives without it */ }
      }
    });
  } catch (e) {
    info.error = e.message;
  }
  return info;
}

// The plate's sliced gcode, as text, for parser.js. Deliberately the same
// parser every other file goes through: the header comments inside are the
// ordinary ones.
function plateGcode(file, plate = 1, { maxBytes = 64 * 1024 * 1024 } = {}) {
  return withArchive(file, (zip, entries) => {
    const name = `Metadata/plate_${plate}.gcode`;
    if (!entries.has(name)) throw Object.assign(new Error(`This file has no sliced plate ${plate}`), { code: "ENOPLATE" });
    return readEntry(zip, name, maxBytes).toString("utf8");
  });
}

// The picture Bambu Studio renders of the plate. Returns null when the file has
// none, which is not an error — the card just shows no thumbnail.
function plateThumbnail(file, plate = 1) {
  try {
    return withArchive(file, (zip, entries) => {
      for (const name of [`Metadata/plate_${plate}.png`, `Metadata/plate_${plate}_small.png`, "Metadata/plate_1.png"]) {
        if (entries.has(name)) return readEntry(zip, name, 8 * 1024 * 1024);
      }
      return null;
    });
  } catch {
    return null;
  }
}

module.exports = { read, plateGcode, plateThumbnail, isBambuSettings, _internal: { readDirectory, parseSliceInfo } };
