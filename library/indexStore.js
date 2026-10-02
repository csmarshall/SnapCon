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
function printerClaims(ck, ex) {
  const id = PrinterIdentity.identifyFile(ex.identity);
  if (!id.hasData) return { id, claims: [] };
  const excerptFor = { printer_model: "printer_model", printer_settings_id: "printer_settings_id", print_compatible_printers: "print_compatible_printers", default_print_profile: "default_print_profile", printer_model_id: "printer_model_id" };
  const evidence = id.evidence.map(e => ({
    signal: e.signal, value: String(e.value).slice(0, 200), source: "gcode:config",
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

function storeThumb(db, thumbsDir, t, now) {
  const key = "e" + sha1(t.data).slice(0, 31);
  const file = path.join(thumbsDir, key + "." + t.ext);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
    const tmp = file + ".partial";
    fs.writeFileSync(tmp, t.data);
    fs.renameSync(tmp, file);
  }
  db.prepare(`INSERT INTO thumbs (key, source, mime, bytes, w, h, created_at, last_used_at) VALUES (?, 'embedded', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET last_used_at = excluded.last_used_at`).run(key, t.mime, t.data.length, t.w, t.h, now, now);
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
    let thumbKey = null;
    if (f.extract && f.extract.thumbnail && thumbsDir) thumbKey = storeThumb(db, thumbsDir, f.extract.thumbnail, now);
    const meta = f.extract ? {
      gcode: {
        generator: f.extract.generator, embeddedMd5: f.extract.embeddedMd5, lines: f.extract.lines,
        thumbnails: f.extract.thumbnails, objectsCapped: f.extract.objectsCapped, window: f.window || null,
      },
    } : (f.error ? { error: f.error } : null);
    const state = f.error && !f.extract ? "unreadable" : "present";
    let id;
    if (prev) {
      db.prepare(`UPDATE files SET name = ?, ext = ?, role = ?, size = ?, mtime_ms = ?, quick_fp = ?, sha256 = ?, md5 = ?, content_key = ?,
          meta_version = ?, meta_json = ?, thumb_key = COALESCE(?, CASE WHEN ? THEN thumb_key ELSE NULL END), state = ?, last_seen = ?, missing_since = NULL WHERE id = ?`)
        .run(f.name, f.ext, f.role, f.size, mtime, f.quickFp, sha256, md5, ck, f.metaVersion || 0, meta ? JSON.stringify(meta) : null,
          thumbKey, f.extract ? 0 : 1, state, now, prev.id);
      id = prev.id;
    } else {
      id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, entry_path, name, ext, role, size, mtime_ms, quick_fp, content_key,
          meta_version, meta_json, thumb_key, state, first_seen, last_seen) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(f.rootId, f.relPath, f.name, f.ext, f.role, f.size, mtime, f.quickFp, ck, f.metaVersion || 0, meta ? JSON.stringify(meta) : null,
          thumbKey, state, now, now).lastInsertRowid);
    }
    let printer = null;
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
    const replacedThumb = prev && prev.thumb_key && f.extract && prev.thumb_key !== thumbKey ? prev.thumb_key : null;
    return { id, contentKey: ck, added: !prev, changed: !!prev && !sameContent, thumbKey, replacedThumb, printer };
  });
}

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
  if (thumbsDir) for (const o of result.orphans) fs.rmSync(path.join(thumbsDir, o.key + (o.mime === "image/png" ? ".png" : ".jpg")), { force: true });
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
  openDb, beginScan, removeRootRows, writeFile, touch, restat, move, finishScan, setHash, printerClaims, resolvePrinter,
  claimKeyOf, CLAIM_RULE_VERSION, MISSING_GRACE_MS, GCODE_META_VERSION: gcodeExtract.RULE_VERSION,
};
