// library/indexStore.js — the indexer's writes to the derived half of the
// Library database (docs/library-design.md §4.6, §6.1). Runs in the Library
// worker on its own connection (WAL), so node:sqlite's synchronous writes
// never stall the server; the main thread only reads.
//
// Everything here is DERIVED: it can be dropped and rebuilt from the files.
// The one exception is the re-key in setHash(): when a file's full hash
// arrives, authored rows that referred to its quick key are re-keyed in place
// (§4.5), because that is the only way they keep pointing at the same content.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PrinterIdentity = require("../public/printer-identity");
const { classifyFolders } = require("./folders");
const gcodeExtract = require("./gcodeExtract");
const { normaliseObjectName } = gcodeExtract;
const threemfExtract = require("./threemfExtract");

const CLAIM_RULE_VERSION = 1;
const MISSING_GRACE_MS = 30 * 24 * 60 * 60 * 1000;   // §6.1: a missing file is purged after 30 days
const sha1 = s => crypto.createHash("sha1").update(s).digest("hex");
const claimKeyOf = (st, sk, rel, ot, ok) => sha1([st, sk, rel, ot, ok].join("|"));
const quickKey = fp => "q:" + fp;

function openDb(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

// ---- claims ----

function upsertClaim(db, c, now) {
  const key = claimKeyOf(c.subject_type, c.subject_key, c.relation, c.object_type, c.object_key);
  db.prepare(`INSERT INTO claims (claim_key, subject_type, subject_key, relation, object_type, object_key, method,
      confidence, state, automatic, groups, evidence_json, rule_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(claim_key) DO UPDATE SET method = excluded.method, confidence = excluded.confidence, state = excluded.state,
      groups = excluded.groups, evidence_json = excluded.evidence_json, rule_version = excluded.rule_version, updated_at = excluded.updated_at`)
    .run(key, c.subject_type, c.subject_key, c.relation, c.object_type, c.object_key, c.method, c.confidence, c.state,
      c.groups, JSON.stringify(c.evidence.slice(0, 12)), CLAIM_RULE_VERSION, now, now);
  return key;
}

// The printer a G-code file was sliced for, from its own config block, through
// the shared resolver (D15) under the targets_printer policy (§4.4): high →
// applied, medium → suggested ("likely"), low → recorded. Folder names are
// never consulted. A file whose fields name no known family gets no Claim: its
// printer is unknown, which Diagnostics shows as such.
function printerClaims(ck, ex, sourceOf = () => "gcode:config") {
  const id = PrinterIdentity.identifyFile(ex.identity);
  if (!id.hasData) return { id, claims: [] };
  const excerptFor = { printer_model: "printer_model", printer_settings_id: "printer_settings_id", print_compatible_printers: "print_compatible_printers", default_print_profile: "default_print_profile", printer_model_id: "printer_model_id" };
  const evidence = id.evidence.map(e => ({
    signal: e.signal, value: String(e.value).slice(0, 200), source: sourceOf(e.signal),
    excerpt: ex.excerpts[excerptFor[e.signal]] || null,
    group: e.signal === "printer_model_id" ? "identity" : "internal-content",
    strength: e.strength, family: e.family || null, ...(e.generic ? { generic: true } : {}),
  }));
  const groups = [...new Set(evidence.filter(e => e.strength !== "none" && e.strength !== "weak").map(e => e.group))].join(",") || "internal-content";
  const base = { subject_type: "variant", subject_key: ck, relation: "targets_printer", object_type: "printer_family", evidence, groups };
  const STATE = { high: "applied", medium: "suggested", low: "recorded" };
  if (id.family) return { id, claims: [{ ...base, object_key: id.family, method: "resolver:" + id.method, confidence: id.confidence, state: STATE[id.confidence] }] };
  // Fields that disagree: each family they name is recorded, none applied.
  const named = [...new Set(id.evidence.map(e => e.family).filter(Boolean))];
  return { id, claims: named.map(f => ({ ...base, object_key: f, method: "resolver:conflict", confidence: "low", state: "recorded" })) };
}

// resolve(subject, relation) for the printer (§4.1): the latest standing
// Decision wins, else the strongest applied Claim, else unresolved. A reject
// Decision overrides every Claim naming that family.
function resolvePrinter(db, ck) {
  // A Decision may still be held on an older key of this content: a quick key
  // stays on authored rows while an identical, not-yet-hashed copy still uses
  // it (setHash). content_aliases maps those keys to this one.
  const keys = [ck, ...db.prepare("SELECT alias FROM content_aliases WHERE content_key = ?").all(ck).map(r => r.alias)];
  const decisions = db.prepare(`SELECT id, polarity, object_key, value_json FROM decisions
    WHERE subject_type = 'variant' AND subject_key IN (${keys.map(() => "?").join(",")}) AND relation = 'targets_printer' AND superseded_by IS NULL ORDER BY id DESC`).all(...keys);
  for (const d of decisions.filter(x => x.polarity === "reject")) {
    db.prepare("UPDATE claims SET state = 'overridden' WHERE subject_type = 'variant' AND subject_key = ? AND relation = 'targets_printer' AND object_key = ?").run(ck, d.object_key);
  }
  const affirm = decisions.find(x => x.polarity === "affirm");
  if (affirm) {
    let fam = affirm.object_key;
    try { fam = JSON.parse(affirm.value_json || "{}").printer_family || fam; } catch {}
    return { family: fam, claimKey: null, decisionId: affirm.id };
  }
  const rank = { exact: 0, high: 1, medium: 2, low: 3 };
  const applied = db.prepare(`SELECT claim_key, object_key, confidence FROM claims
    WHERE subject_type = 'variant' AND subject_key = ? AND relation = 'targets_printer' AND state = 'applied'`).all(ck)
    .sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  return applied.length ? { family: applied[0].object_key, claimKey: applied[0].claim_key, decisionId: null } : { family: null, claimKey: null, decisionId: null };
}

// ---- thumbnails ----

const THUMB_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const thumbExt = mime => THUMB_EXT[mime] || "bin";

function storeThumb(db, thumbsDir, t, now) {
  const key = "e" + sha1(t.data).slice(0, 31);
  const file = path.join(thumbsDir, key + "." + thumbExt(t.mime));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
    const tmp = file + ".partial";
    fs.writeFileSync(tmp, t.data);
    fs.renameSync(tmp, file);
  }
  db.prepare(`INSERT INTO thumbs (key, source, mime, bytes, w, h, created_at, last_used_at) VALUES (?, 'embedded', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET last_used_at = excluded.last_used_at`).run(key, t.mime, t.data.length, t.w ?? null, t.h ?? null, now, now);
  return key;
}

// ---- scans ----

function beginScan(db, { rootId, now }) {
  return tx(db, () => {
    // A scan that never finished (the server stopped mid-way) is closed as
    // interrupted; the new one simply re-walks, and unchanged files cost a stat.
    const interrupted = db.prepare("UPDATE scan_runs SET outcome = 'interrupted', finished_at = ? WHERE root_id = ? AND finished_at IS NULL").run(now, rootId).changes;
    const id = db.prepare("INSERT INTO scan_runs (root_id, started_at) VALUES (?, ?)").run(rootId, now).lastInsertRowid;
    db.prepare("UPDATE roots SET status = 'scanning' WHERE id = ?").run(rootId);
    return { scanId: Number(id), interrupted };
  });
}

// One file: insert or update its row and, when it was read, everything
// extracted from it. f: { rootId, relPath, name, ext, role, size, mtimeMs,
// quickFp, extract (gcodeExtract result, thumbnail.data a Buffer) | null,
// metaVersion, window, error }.
function writeFile(db, f, { now, thumbsDir }) {
  return tx(db, () => {
    const prev = db.prepare("SELECT id, quick_fp, sha256, md5, content_key, size, thumb_key FROM files WHERE root_id = ? AND rel_path = ? AND entry_path = ''").get(f.rootId, f.relPath);
    const sameContent = prev && prev.quick_fp === f.quickFp && prev.size === f.size;
    const ck = sameContent ? prev.content_key : quickKey(f.quickFp);
    const sha256 = sameContent ? prev.sha256 : null, md5 = sameContent ? prev.md5 : null;
    const mtime = Math.floor(f.mtimeMs);
    const x3 = f.threemf || null;
    const extracted = !!(f.extract || x3);
    let thumbKey = null;
    const picture = (f.extract && f.extract.thumbnail) || (x3 && x3.thumbnail);
    if (picture && thumbsDir) thumbKey = storeThumb(db, thumbsDir, picture, now);
    // A 3MF is sliced when a plate's G-code is inside it — content, never the name.
    const role = x3 ? (x3.slicedCount > 0 ? "sliced" : "project") : f.role;
    const meta = f.extract ? {
      gcode: {
        generator: f.extract.generator, embeddedMd5: f.extract.embeddedMd5, lines: f.extract.lines,
        thumbnails: f.extract.thumbnails, objectsCapped: f.extract.objectsCapped, window: f.window || null,
      },
    } : x3 ? {
      threemf: {
        flavour: x3.flavour, producer: x3.producer, producerVersion: x3.producerVersion, clientVersion: x3.clientVersion,
        project: x3.project, profile: x3.profile, zip64: x3.zip64, entryCount: x3.entryCount,
        sourceFiles: x3.sourceFiles, meshNames: x3.meshNames, problems: x3.problems, read: f.window || null,
      },
    } : (f.error ? { error: f.error } : null);
    const state = f.error && !extracted ? "unreadable" : "present";
    let id;
    if (prev) {
      db.prepare(`UPDATE files SET name = ?, ext = ?, role = ?, size = ?, mtime_ms = ?, quick_fp = ?, sha256 = ?, md5 = ?, content_key = ?,
          meta_version = ?, meta_json = ?, thumb_key = COALESCE(?, CASE WHEN ? THEN thumb_key ELSE NULL END), state = ?, last_seen = ?, missing_since = NULL WHERE id = ?`)
        .run(f.name, f.ext, role, f.size, mtime, f.quickFp, sha256, md5, ck, f.metaVersion || 0, meta ? JSON.stringify(meta) : null,
          thumbKey, extracted ? 0 : 1, state, now, prev.id);
      id = prev.id;
    } else {
      id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, entry_path, name, ext, role, size, mtime_ms, quick_fp, content_key,
          meta_version, meta_json, thumb_key, state, first_seen, last_seen) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(f.rootId, f.relPath, f.name, f.ext, role, f.size, mtime, f.quickFp, ck, f.metaVersion || 0, meta ? JSON.stringify(meta) : null,
          thumbKey, state, now, now).lastInsertRowid);
    }
    let printer = null;
    const replacedThumbs = [];
    if (x3) {
      const r3 = write3mf(db, { id, ck, f, x3, now, thumbsDir });
      replacedThumbs.push(...r3.replacedThumbs);
      printer = r3.printers;
    }
    if (f.extract) {
      const ex = f.extract;
      db.prepare("DELETE FROM file_objects WHERE file_id = ?").run(id);
      const insObj = db.prepare(`INSERT OR REPLACE INTO file_objects (file_id, name_norm, raw_name, copies, origin, generic, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const o of ex.objects) insObj.run(id, o.norm, o.raw, o.copies, o.origin, o.generic ? 1 : 0, o.excerpt);
      // The Claims of this content are re-derived from scratch. Identical files
      // share a content key and produce identical Claims, so nothing is lost.
      db.prepare("DELETE FROM claims WHERE subject_type = 'variant' AND subject_key = ? AND relation = 'targets_printer' AND automatic = 1").run(ck);
      const pc = printerClaims(ck, ex);
      for (const c of pc.claims) upsertClaim(db, c, now);
      const res = resolvePrinter(db, ck);
      printer = { resolver: { family: pc.id.family, confidence: pc.id.confidence, method: pc.id.method, conflict: pc.id.conflict, brand: pc.id.brand }, resolved: res };
      db.prepare("DELETE FROM variants WHERE file_id = ?").run(id);
      const v = ex.variant;
      db.prepare(`INSERT INTO variants (file_id, plate_no, printer_family, printer_claim_key, printer_decision_id, printer_model, printer_model_id,
          printer_settings_id, print_settings_id, compatible_printers, filament_settings_json, filaments_json, layer_height, nozzle, bed_json,
          slicer, slicer_version, config_block, config_hash, est_seconds, weight_g, copies, color_count)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, res.family, res.claimKey, res.decisionId, v.printer_model, v.printer_model_id, v.printer_settings_id, v.print_settings_id,
          v.compatible_printers, v.filament_settings_json, v.filaments_json, v.layer_height, v.nozzle, v.bed_json, v.slicer, v.slicer_version,
          v.config_block, v.config_hash, v.est_seconds, v.weight_g, v.copies, v.color_count);
    }
    // A thumbnail this file no longer uses: a candidate for removal at the end
    // of the scan (another file may still use it).
    if (prev && prev.thumb_key && extracted && prev.thumb_key !== thumbKey) replacedThumbs.push(prev.thumb_key);
    return { id, contentKey: ck, added: !prev, changed: !!prev && !sameContent, role, thumbKey, replacedThumbs, printer };
  });
}

// ---- 3MF: Project, Plates, Variants, objects, Auxiliaries ----

const AUX_ROLE = ext => (/^(png|jpe?g|webp|gif|bmp)$/.test(ext) ? "image" : /^(pdf|txt|md|html?)$/.test(ext) ? "document" : /^(stl|obj|step|stp|3mf|amf|ply)$/.test(ext) ? "source" : "other");
const SLICER_LABEL = { bambu: "Bambu Studio", orca: "OrcaSlicer", snapmaker_orca: "Snapmaker Orca", creality: "Creality Print", prusa: "PrusaSlicer" };

// What a 3MF says, as rows. Derived, like everything here: the previous
// Project of this file (plates cascade), its Variants, objects, entry Files
// and automatic printer Claims are replaced. Lineage between files is not
// written here: see lineage().
function write3mf(db, { id, ck, f, x3, now, thumbsDir }) {
  const old = [
    ...db.prepare("SELECT p.thumb_key AS k FROM plates p JOIN projects pr ON pr.id = p.project_id WHERE pr.file_id = ? AND p.thumb_key IS NOT NULL").all(id),
    ...db.prepare("SELECT thumb_key AS k FROM files WHERE container_id = ? AND thumb_key IS NOT NULL").all(id),
  ].map(r => r.k);
  db.prepare("DELETE FROM projects WHERE file_id = ?").run(id);
  db.prepare("DELETE FROM files WHERE container_id = ?").run(id);
  db.prepare("DELETE FROM variants WHERE file_id = ?").run(id);
  db.prepare("DELETE FROM file_objects WHERE file_id = ?").run(id);
  db.prepare("DELETE FROM claims WHERE subject_type = 'variant' AND subject_key LIKE ? AND relation = 'targets_printer' AND automatic = 1").run(ck + "#%");

  const p = x3.project, pf = x3.profile || {};
  const sliced = x3.plates.filter(pl => pl.sliced);
  const firstSlice = (sliced.find(pl => pl.slice) || {}).slice || {};
  const projectId = Number(db.prepare(`INSERT INTO projects (file_id, flavour, producer, producer_version, title, designer, license, origin,
      design_model_id, design_profile_id, profile_title, printer_model, printer_model_id, printer_settings_id, print_settings_id,
      filament_settings_json, layer_height, nozzle, plate_count, sliced_plate_count, config_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, x3.flavour.flavour, x3.producer, x3.producerVersion, p.title, p.designer, p.license, p.origin,
      p.designModelId, p.designProfileId, p.profileTitle, pf.printer_model || null, firstSlice.printerModelId || null,
      pf.printer_settings_id || null, pf.print_settings_id || null, pf.filament_settings_id ? JSON.stringify(pf.filament_settings_id) : null,
      pf.layer_height != null ? pf.layer_height : null, pf.nozzle != null ? pf.nozzle : null, x3.plates.length, sliced.length, x3.configHash).lastInsertRowid);

  const newThumbs = new Set();
  const insPlate = db.prepare("INSERT INTO plates (project_id, plate_no, name, sliced, objects_json, thumb_key, gcode_md5) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const pl of x3.plates) {
    let tk = null;
    if (pl.thumbnail && thumbsDir) { tk = storeThumb(db, thumbsDir, { ...pl.thumbnail, w: null, h: null }, now); newThumbs.add(tk); }
    insPlate.run(projectId, pl.plate_no, pl.name, pl.sliced ? 1 : 0, JSON.stringify({ objects: pl.objects, slicedObjects: pl.slicedObjects }), tk, pl.gcodeMd5);
  }

  // A printable Variant per sliced plate, and its printer from the file's
  // own fields: the profile, plus the plate's Bambu model id.
  const printers = [];
  const where = { printer_model: "3mf:Metadata/project_settings.config", printer_settings_id: "3mf:Metadata/project_settings.config",
    print_compatible_printers: "3mf:Metadata/project_settings.config", default_print_profile: "3mf:Metadata/project_settings.config",
    printer_model_id: "3mf:Metadata/slice_info.config" };
  for (const pl of sliced) {
    const si = pl.slice || {};
    const key = ck + "#" + pl.plate_no;
    const identity = { ...(x3.identity || {}), printerModelId: si.printerModelId || null };
    const excerpts = Object.fromEntries(Object.entries({ printer_model: identity.printerModel, printer_settings_id: identity.printerSettingsId,
      print_compatible_printers: identity.printCompatiblePrinters, default_print_profile: identity.defaultPrintProfile, printer_model_id: identity.printerModelId })
      .filter(([, v]) => v).map(([k, v]) => [k, (k === "printer_model_id" ? "slice_info.config plate " + pl.plate_no : "project_settings.config") + ": " + k + " = " + String(v).slice(0, 150)]));
    const pc = printerClaims(key, { identity, excerpts }, sig => where[sig] || "3mf");
    for (const c of pc.claims) upsertClaim(db, c, now);
    const res = resolvePrinter(db, key);
    printers.push({ plate: pl.plate_no, resolver: { family: pc.id.family, confidence: pc.id.confidence, method: pc.id.method }, resolved: res });
    const fil = si.filaments && si.filaments.length ? si.filaments
      : (pf.filament_type || []).map((t, i) => ({ id: i + 1, type: t, color: (pf.filament_colour || [])[i] || null }));
    const counts = {};
    for (const o of (si.objects || []).filter(o => !o.skipped)) counts[o.name] = (counts[o.name] || 0) + 1;
    db.prepare(`INSERT INTO variants (file_id, plate_no, printer_family, printer_claim_key, printer_decision_id, printer_model, printer_model_id,
        printer_settings_id, print_settings_id, compatible_printers, filament_settings_json, filaments_json, layer_height, nozzle, bed_json,
        slicer, slicer_version, config_block, config_hash, est_seconds, weight_g, copies, color_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(id, pl.plate_no, res.family, res.claimKey, res.decisionId, pf.printer_model || null, si.printerModelId || null,
        pf.printer_settings_id || null, pf.print_settings_id || null, (pf.compatible_printers || []).join(";") || null,
        pf.filament_settings_id ? JSON.stringify(pf.filament_settings_id) : null, JSON.stringify(fil),
        pf.layer_height != null ? pf.layer_height : null, si.nozzle != null ? si.nozzle : pf.nozzle != null ? pf.nozzle : null,
        pf.bed_type ? JSON.stringify({ bed_type: pf.bed_type }) : null, SLICER_LABEL[x3.flavour.flavour] || x3.producer, x3.producerVersion,
        x3.configHash, si.prediction != null ? Math.round(si.prediction) : null, si.weight, Object.keys(counts).length ? Math.max(...Object.values(counts)) : null,
        fil.filter(x => x.usedG == null || x.usedG > 0).length || null);
  }

  // Object names, source-file references and mesh names: what M4's lineage
  // and grouping read. Recorded as the file states them.
  const insObj = db.prepare("INSERT OR REPLACE INTO file_objects (file_id, name_norm, raw_name, copies, origin, generic, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const put = (names, origin, excerptOf) => {
    const agg = new Map();
    for (const raw of names) {
      const n = normaliseObjectName(raw);
      if (!n.norm) continue;
      const a = agg.get(n.norm) || { raw, copies: 0, generic: n.generic };
      a.copies++; agg.set(n.norm, a);
    }
    for (const [norm, a] of agg) insObj.run(id, norm, String(a.raw).slice(0, 300), a.copies, origin, a.generic ? 1 : 0, excerptOf(a.raw));
  };
  put(x3.objects.map(o => o.name).filter(Boolean), "model_settings", r => cut200("model_settings.config: object name = " + r));
  put(x3.plates.flatMap(pl => pl.slicedObjects), "slice_info", r => cut200("slice_info.config: object name = " + r));
  put(x3.sourceFiles.map(baseName), "source_file", r => cut200("model_settings.config: source_file = " + (x3.sourceFiles.find(s => baseName(s) === r) || r)));
  put(x3.meshNames, "mesh_basename", r => cut200("model_settings.config: part name = " + r));

  // Auxiliaries: pictures and documents inside the project, as entry Files.
  // Their fingerprint is the archive's own record of them (size and CRC-32).
  const insEntry = db.prepare(`INSERT INTO files (root_id, rel_path, entry_path, container_id, name, ext, role, size, mtime_ms, quick_fp, content_key,
      meta_version, meta_json, thumb_key, state, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'present', ?, ?)`);
  for (const a of x3.auxiliaries) {
    const ext = path.extname(a.name).slice(1).toLowerCase();
    const fp = sha1("zip:" + a.size + ":" + a.crc).slice(0, 32);
    let tk = null;
    if (a.picture && thumbsDir) { tk = storeThumb(db, thumbsDir, { ...a.picture, w: null, h: null }, now); newThumbs.add(tk); }
    insEntry.run(f.rootId, f.relPath, a.entry, id, a.name, ext, AUX_ROLE(ext), a.size, Math.floor(f.mtimeMs), fp, quickKey(fp),
      JSON.stringify({ entry: { crc: a.crc, fingerprint: "zip size + CRC-32" } }), tk, now, now);
  }
  return { replacedThumbs: old.filter(k => !newThumbs.has(k)), printers };
}
const cut200 = s => String(s).slice(0, 200);
const baseName = p => String(p || "").split(/[\\/]/).pop();

// Unchanged files: one stat each, recorded as seen.
function touch(db, { ids, now }) {
  if (!ids.length) return { touched: 0 };
  return tx(db, () => {
    const st = db.prepare("UPDATE files SET last_seen = ?, state = CASE WHEN state = 'missing' THEN 'present' ELSE state END, missing_since = NULL WHERE id = ?");
    for (const id of ids) st.run(now, id);
    return { touched: ids.length };
  });
}

// Only the modification time changed; the content fingerprint did not.
function restat(db, { id, mtimeMs, now }) {
  db.prepare("UPDATE files SET mtime_ms = ?, last_seen = ?, state = 'present', missing_since = NULL WHERE id = ?").run(Math.floor(mtimeMs), now, id);
  return { ok: true };
}

// A file that disappeared from one path and appeared at another with the same
// fingerprint, one-to-one within this scan (§4.4 moved_from: exact). The row
// moves, so nothing is re-read and nothing derived from it is lost.
function move(db, { id, relPath, name, ext, now, rootId, fromRelPath, quickFp }) {
  return tx(db, () => {
    db.prepare("UPDATE files SET rel_path = ?, name = ?, ext = ?, last_seen = ?, state = 'present', missing_since = NULL WHERE id = ?").run(relPath, name, ext, now, id);
    const ck = db.prepare("SELECT content_key FROM files WHERE id = ?").get(id).content_key;
    upsertClaim(db, {
      subject_type: "file", subject_key: ck, relation: "moved_from", object_type: "location", object_key: rootId + ":" + fromRelPath,
      method: "quick_fp_1to1", confidence: "exact", state: "applied", groups: "identity",
      // `at` is where it moved to: identical files share a content key, and so
      // this Claim, but the move happened to one location only.
      evidence: [{ signal: "quick_fp", value: quickFp, source: "scan", group: "identity", strength: "identity",
        excerpt: `${fromRelPath} → ${relPath}`, matches: rootId + ":" + fromRelPath, at: rootId + ":" + relPath }],
    }, now);
    return { ok: true };
  });
}

// The end of a scan. Only a COMPLETE scan of a reachable location marks
// anything missing (§6.1: offline changes no rows); a missing file is purged
// after the grace period, and Decisions about it stay (they are authored).
function finishScan(db, { rootId, scanId, startedAt, now, complete, outcome, stats, dirs, error, thumbsDir, thumbCandidates = [] }) {
  const candidates = new Set(thumbCandidates);
  const result = tx(db, () => {
    let missing = 0, purged = 0;
    if (complete) {
      missing = db.prepare(`UPDATE files SET state = 'missing', missing_since = COALESCE(missing_since, ?)
        WHERE root_id = ? AND entry_path = '' AND last_seen < ? AND state != 'missing'`).run(now, rootId, startedAt).changes;
      // A 3MF's entry Files go missing with it, and come back with it.
      db.prepare(`UPDATE files SET state = c.state, missing_since = c.missing_since FROM (SELECT id, state, missing_since FROM files WHERE root_id = ? AND entry_path = '') AS c
        WHERE files.container_id = c.id AND files.state != c.state`).run(rootId);
      for (const r of db.prepare("SELECT thumb_key FROM files WHERE root_id = ? AND state = 'missing' AND missing_since < ? AND thumb_key IS NOT NULL").all(rootId, now - MISSING_GRACE_MS)) candidates.add(r.thumb_key);
      purged = db.prepare("DELETE FROM files WHERE root_id = ? AND state = 'missing' AND missing_since < ?").run(rootId, now - MISSING_GRACE_MS).changes;
      if (dirs) {
        db.prepare("DELETE FROM folder_classes WHERE root_id = ?").run(rootId);
        const ins = db.prepare("INSERT INTO folder_classes (root_id, rel_path, class, method, evidence_json, rule_version) VALUES (?, ?, 'unknown', 'pending', '[]', 0)");
        for (const d of dirs) ins.run(rootId, d);
        // Re-classify every location: a folder becomes a designer folder when
        // its name turns up under another parent, possibly in another location.
        const all = db.prepare("SELECT root_id, rel_path FROM folder_classes").all();
        const up = db.prepare("UPDATE folder_classes SET class = ?, method = ?, evidence_json = ?, rule_version = ? WHERE root_id = ? AND rel_path = ?");
        for (const c of classifyFolders(all)) up.run(c.class, c.method, JSON.stringify(c.evidence), c.rule_version, c.root_id, c.rel_path);
      }
      // Automatic Claims about content no file has any more.
      db.prepare(`DELETE FROM claims WHERE automatic = 1 AND relation IN ('targets_printer', 'moved_from') AND NOT EXISTS (
        SELECT 1 FROM files f WHERE f.content_key = CASE WHEN instr(claims.subject_key, '#') > 0 THEN substr(claims.subject_key, 1, instr(claims.subject_key, '#') - 1) ELSE claims.subject_key END)`).run();
    }
    const s = stats || {};
    db.prepare(`UPDATE scan_runs SET finished_at = ?, seen = ?, added = ?, changed = ?, moved = ?, missing = ?, errors = ?, outcome = ? WHERE id = ?`)
      .run(now, s.seen || 0, s.added || 0, s.changed || 0, s.moved || 0, missing, s.errors || 0, outcome, scanId);
    if (complete) db.prepare("UPDATE roots SET status = 'ok', last_scan_at = ?, last_ok_at = ?, last_error = NULL WHERE id = ?").run(now, now, rootId);
    else db.prepare("UPDATE roots SET status = ?, last_error = ? WHERE id = ?").run(outcome === "offline" ? "offline" : outcome === "stopped" ? "ok" : "error", error || null, rootId);
    // Thumbnails nothing refers to any more: only the candidates this scan
    // produced (replaced or purged) are checked, in one pass — files.thumb_key
    // has no index, so a check per thumbnail would scan the table each time.
    let orphans = [];
    if (complete && candidates.size) {
      const list = [...candidates], ph = list.map(() => "?").join(",");
      const used = new Set([
        ...db.prepare(`SELECT DISTINCT thumb_key AS k FROM files WHERE thumb_key IN (${ph})`).all(...list).map(r => r.k),
        ...db.prepare(`SELECT DISTINCT thumb_key AS k FROM plates WHERE thumb_key IN (${ph})`).all(...list).map(r => r.k),
      ]);
      orphans = db.prepare(`SELECT key, mime FROM thumbs WHERE key IN (${ph})`).all(...list).filter(t => !used.has(t.key));
    }
    for (const o of orphans) db.prepare("DELETE FROM thumbs WHERE key = ?").run(o.key);
    return { missing, purged, orphans };
  });
  // The files go after the rows are committed: a crash in between leaves a
  // stray file (harmless), never a row pointing at a missing file.
  if (thumbsDir) for (const o of result.orphans) fs.rmSync(path.join(thumbsDir, o.key + "." + thumbExt(o.mime)), { force: true });
  return { missing: result.missing, purged: result.purged, thumbsRemoved: result.orphans.length };
}

// The full hash arrived (read at idle). The content key becomes the sha256,
// the quick key becomes an alias, and every row that referred to the quick
// key — derived Claims, and authored rows (§4.5) — is re-keyed in place. If
// the file changed while it was being hashed, nothing is written.
function setHash(db, { id, sha256, md5, expect, now }) {
  return tx(db, () => {
    const row = db.prepare("SELECT size, mtime_ms, quick_fp, content_key FROM files WHERE id = ?").get(id);
    if (!row || row.size !== expect.size || row.mtime_ms !== expect.mtime_ms || row.quick_fp !== expect.quick_fp) return { ok: false, reason: "changed" };
    const oldKey = row.content_key;
    db.prepare("UPDATE files SET sha256 = ?, md5 = ?, content_key = ? WHERE id = ?").run(sha256, md5, sha256, id);
    if (oldKey === sha256) return { ok: true, rekeyed: 0 };
    db.prepare("INSERT OR REPLACE INTO content_aliases (alias, content_key) VALUES (?, ?)").run(oldKey, sha256);
    // Other files with the same quick key keep it until their own hash comes.
    const stillUsed = db.prepare("SELECT 1 FROM files WHERE content_key = ? LIMIT 1").get(oldKey);
    let rekeyed = 0;
    const rekey = (k) => (k === oldKey ? sha256 : k.startsWith(oldKey + "#") ? sha256 + k.slice(oldKey.length) : k);
    const claims = db.prepare("SELECT * FROM claims WHERE subject_key = ? OR subject_key LIKE ? OR object_key = ? OR object_key LIKE ?").all(oldKey, oldKey + "#%", oldKey, oldKey + "#%");
    const claimKeys = new Map();   // old claim key -> new, for the rows that refer to Claims by key
    for (const c of claims) {
      const sk = rekey(c.subject_key), ok = rekey(c.object_key);
      const key = claimKeyOf(c.subject_type, sk, c.relation, c.object_type, ok);
      claimKeys.set(c.claim_key, key);
      if (!stillUsed) db.prepare("DELETE FROM claims WHERE id = ?").run(c.id);
      db.prepare(`INSERT OR IGNORE INTO claims (claim_key, subject_type, subject_key, relation, object_type, object_key, method, confidence,
          state, automatic, groups, evidence_json, rule_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key, c.subject_type, sk, c.relation, c.object_type, ok, c.method, c.confidence, c.state, c.automatic, c.groups, c.evidence_json, c.rule_version, c.created_at, now);
      rekeyed++;
    }
    db.prepare("UPDATE variants SET printer_claim_key = (SELECT claim_key FROM claims WHERE subject_key = ? AND relation = 'targets_printer' AND object_key = variants.printer_family AND state = 'applied') WHERE file_id = ?").run(sha256, id);
    if (!stillUsed) {
      // Authored rows (§4.5): re-keyed in place, never dropped.
      db.prepare("UPDATE decisions SET subject_key = ? || substr(subject_key, ?) WHERE subject_key = ? OR subject_key LIKE ?").run(sha256, oldKey.length + 1, oldKey, oldKey + "#%");
      db.prepare("UPDATE decisions SET object_key = ? || substr(object_key, ?) WHERE object_key = ? OR object_key LIKE ?").run(sha256, oldKey.length + 1, oldKey, oldKey + "#%");
      db.prepare("UPDATE prints SET content_key = ? WHERE content_key = ?").run(sha256, oldKey);
      db.prepare("UPDATE review_items SET content_key = ? WHERE content_key = ?").run(sha256, oldKey);
      db.prepare("UPDATE review_items SET other_content_key = ? WHERE other_content_key = ?").run(sha256, oldKey);
      // subject_key is built from content keys; a dismissed item must keep
      // matching. An item already keyed the new way wins (UNIQUE).
      db.prepare("UPDATE OR IGNORE review_items SET subject_key = replace(subject_key, ?, ?) WHERE instr(subject_key, ?) > 0").run(oldKey, sha256, oldKey);
      // Rows that refer to a Claim by its key follow the re-keyed Claim.
      for (const [from, to] of claimKeys) {
        db.prepare("UPDATE decisions SET from_claim_key = ? WHERE from_claim_key = ?").run(to, from);
        db.prepare("UPDATE review_items SET claim_key = ? WHERE claim_key = ?").run(to, from);
      }
      db.prepare("UPDATE model_anchors SET content_key = ? WHERE content_key = ? AND NOT EXISTS (SELECT 1 FROM model_anchors a2 WHERE a2.model_id = model_anchors.model_id AND a2.content_key = ?)").run(sha256, oldKey, sha256);
      // Whatever is left on the old key duplicates an anchor the Model already has.
      db.prepare("DELETE FROM model_anchors WHERE content_key = ?").run(oldKey);
      db.prepare("UPDATE models SET cover_content_key = ? WHERE cover_content_key = ?").run(sha256, oldKey);
    }
    return { ok: true, rekeyed };
  });
}

// ---- lineage (§4.4: source_of, sliced_from) ----
// Recomputed from the index as a whole after each complete scan and after
// full hashes arrive (MD5s). Only automatic Claims are replaced; Decisions are
// authored and untouched. Nothing here is a guess dressed as a fact:
//   sliced_from exact      a G-code file's MD5 = a project plate's recorded
//                          plate_N.gcode.md5
//   sliced_from medium     the same non-generic object names as one project
//                          plate, and no other (2+ candidates: recorded low)
//   source_of high         a 3MF's source_file names exactly one indexed file
//                          (2+ files of that name: recorded low)
//   source_of medium       a G-code object is named exactly like one source
//                          (mesh) file, generic names never
const GCODE_OBJECT_ORIGINS = ["exclude_object", "printing_object", "m486"];

function lineage(db, { now }) {
  return tx(db, () => {
    db.prepare("DELETE FROM claims WHERE automatic = 1 AND relation IN ('sliced_from', 'source_of')").run();
    const counts = { sliced_from_exact: 0, sliced_from_names: 0, sliced_from_ambiguous: 0, source_of: 0, source_of_ambiguous: 0, source_of_names: 0 };
    const loc = r => r.root_id + ":" + r.rel_path;
    const projects = db.prepare(`SELECT pr.id AS project_id, f.id AS file_id, f.content_key, f.root_id, f.rel_path FROM projects pr
      JOIN files f ON f.id = pr.file_id WHERE f.state = 'present'`).all();
    const projectByFile = new Map(projects.map(p => [p.file_id, p]));

    // 1. Exact: the G-code is byte-identical to a plate's G-code.
    const exact = db.prepare(`SELECT g.content_key AS gk, g.root_id, g.rel_path, g.md5, pl.plate_no, pf.content_key AS pk, pf.root_id AS proot, pf.rel_path AS ppath
      FROM files g JOIN plates pl ON pl.gcode_md5 = g.md5 JOIN projects pr ON pr.id = pl.project_id JOIN files pf ON pf.id = pr.file_id
      WHERE g.md5 IS NOT NULL AND g.entry_path = '' AND g.state = 'present' AND g.id != pf.id AND pf.state = 'present'`).all();
    const exactPairs = new Set();
    for (const r of exact) {
      upsertClaim(db, { subject_type: "variant", subject_key: r.gk, relation: "sliced_from", object_type: "project", object_key: r.pk,
        method: "plate_md5", confidence: "exact", state: "applied", groups: "identity",
        evidence: [{ signal: "gcode_md5", value: r.md5, source: "3mf:Metadata/plate_" + r.plate_no + ".gcode.md5", group: "identity", strength: "identity",
          excerpt: `${loc(r)} has the MD5 recorded for plate ${r.plate_no} of ${r.proot}:${r.ppath}`, at: loc(r), plate: r.plate_no }] }, now);
      exactPairs.add(r.gk + ">" + r.pk); counts.sliced_from_exact++;
    }

    // 2. Object names: a G-code file's non-generic objects = one plate's.
    const norm = n => normaliseObjectName(n);
    const plateSets = [];
    for (const pl of db.prepare("SELECT project_id, plate_no, objects_json FROM plates").all()) {
      const p = projects.find(x => x.project_id === pl.project_id);
      if (!p) continue;
      let names = [];
      try { names = JSON.parse(pl.objects_json || "{}").objects || []; } catch {}
      const set = [...new Set(names.map(norm).filter(n => n.norm && !n.generic).map(n => n.norm))].sort();
      if (set.length) plateSets.push({ ...p, plate_no: pl.plate_no, key: set.join("|"), names: set });
    }
    const byKey = new Map();
    for (const s of plateSets) byKey.set(s.key, (byKey.get(s.key) || []).concat([s]));
    const ph = GCODE_OBJECT_ORIGINS.map(() => "?").join(",");
    const gObjects = db.prepare(`SELECT f.id, f.content_key, f.root_id, f.rel_path, o.name_norm, o.raw_name, o.generic FROM files f JOIN file_objects o ON o.file_id = f.id
      WHERE f.entry_path = '' AND f.state = 'present' AND o.origin IN (${ph})`).all(...GCODE_OBJECT_ORIGINS);
    const gSets = new Map();
    for (const r of gObjects) {
      const g = gSets.get(r.id) || { ...r, names: new Set(), raws: new Set(), generic: 0 };
      if (r.generic) g.generic++; else { g.names.add(r.name_norm); g.raws.add(r.raw_name); }
      gSets.set(r.id, g);
    }
    for (const g of gSets.values()) {
      if (!g.names.size || projectByFile.has(g.id)) continue;
      const key = [...g.names].sort().join("|");
      const cands = (byKey.get(key) || []).filter(c => !exactPairs.has(g.content_key + ">" + c.content_key));
      const projectsHit = [...new Map(cands.map(c => [c.content_key, c])).values()];
      for (const c of projectsHit) {
        const unique = projectsHit.length === 1;
        upsertClaim(db, { subject_type: "variant", subject_key: g.content_key, relation: "sliced_from", object_type: "project", object_key: c.content_key,
          method: "object_names", confidence: unique ? "medium" : "low", state: unique ? "suggested" : "recorded", groups: "internal-content",
          evidence: [{ signal: "object_names", value: [...g.names].join(", ").slice(0, 200), source: "gcode:objects + 3mf:Metadata/model_settings.config",
            group: "internal-content", strength: unique ? "medium" : "weak",
            excerpt: `${loc(g)} and plate ${cands.filter(x => x.content_key === c.content_key).map(x => x.plate_no).join("/")} of ${loc(c)} name the same objects`,
            at: loc(g), ...(unique ? {} : { note: `${projectsHit.length} projects match equally` }) }] }, now);
        if (unique) counts.sliced_from_names++; else counts.sliced_from_ambiguous++;
      }
    }

    // 3. source_file: the slicer's record of what a project was made from.
    const nameIndex = new Map();
    for (const r of db.prepare("SELECT id, content_key, root_id, rel_path, name, role FROM files WHERE entry_path = '' AND state = 'present'").all()) {
      const k = r.name.toLowerCase();
      nameIndex.set(k, (nameIndex.get(k) || []).concat([r]));
    }
    for (const r of db.prepare(`SELECT f.id, f.content_key, f.root_id, f.rel_path, o.raw_name FROM file_objects o JOIN files f ON f.id = o.file_id
      WHERE o.origin = 'source_file' AND f.state = 'present'`).all()) {
      const hits = (nameIndex.get(String(r.raw_name).toLowerCase()) || []).filter(h => h.id !== r.id);
      for (const h of hits) {
        const unique = hits.length === 1;
        upsertClaim(db, { subject_type: "file", subject_key: h.content_key, relation: "source_of", object_type: "file", object_key: r.content_key,
          method: "source_file_meta", confidence: unique ? "high" : "low", state: unique ? "applied" : "recorded", groups: "identity",
          evidence: [{ signal: "source_file", value: r.raw_name, source: "3mf:Metadata/model_settings.config", group: "identity", strength: unique ? "identity" : "weak",
            excerpt: `${loc(r)} records source_file ${r.raw_name}; ${loc(h)} has that name`, at: loc(r), ...(unique ? {} : { note: `${hits.length} files have that name` }) }] }, now);
        if (unique) counts.source_of++; else counts.source_of_ambiguous++;
      }
    }
    // A G-code object named exactly like a source (mesh) file.
    for (const g of gSets.values()) {
      for (const raw of g.raws) {
        const hits = (nameIndex.get(String(raw).toLowerCase()) || []).filter(h => h.role === "source" && h.id !== g.id);
        if (hits.length !== 1) continue;
        const h = hits[0];
        upsertClaim(db, { subject_type: "file", subject_key: h.content_key, relation: "source_of", object_type: "file", object_key: g.content_key,
          method: "object_name=mesh_basename", confidence: "medium", state: "suggested", groups: "internal-content",
          evidence: [{ signal: "source_object_name", value: raw, source: "gcode:objects", group: "internal-content", strength: "medium",
            excerpt: `${loc(g)} prints an object named ${raw}; ${loc(h)} is that file`, at: loc(g) }] }, now);
        counts.source_of_names++;
      }
    }
    return counts;
  });
}

// Removing a location: its derived rows go in batches, each its own short
// transaction, here in the worker. A single cascading DELETE of a large
// location (M0: 12 s at 100k files) on the main thread would freeze the
// server, and one long transaction would hold the write lock that the main
// thread's own small writes wait on.
function removeRootRows(db, { rootId, batch = 2000 }) {
  let files = 0;
  for (;;) {
    const n = tx(db, () => db.prepare(`DELETE FROM files WHERE id IN (SELECT id FROM files WHERE root_id = ? ORDER BY container_id IS NULL, id LIMIT ?)`).run(rootId, batch).changes);
    files += n;
    if (n < batch) break;
  }
  tx(db, () => {
    db.prepare("DELETE FROM scan_runs WHERE root_id = ?").run(rootId);
    db.prepare("DELETE FROM folder_classes WHERE root_id = ?").run(rootId);
  });
  return { files };
}

module.exports = {
  openDb, beginScan, removeRootRows, lineage, writeFile, touch, restat, move, finishScan, setHash, printerClaims, resolvePrinter,
  claimKeyOf, CLAIM_RULE_VERSION, MISSING_GRACE_MS, GCODE_META_VERSION: gcodeExtract.RULE_VERSION,
  THREEMF_META_VERSION: threemfExtract.RULE_VERSION, thumbExt,
};
