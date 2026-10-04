// library/prints.js — print history (docs/library-design.md §9, M7).
//
// A Print is a fact: a job ran on a printer, at a time, with a file of some
// name. The prints row records that fact as it was known when it happened,
// and never changes it afterwards except to add how the job ended. What the
// Print is linked to is recorded with its method, confidence and Evidence:
//
//   snapcon_variant  exact   chosen in the Library; content verified at send
//   queue_sha256     exact   the queue's verified hash is a Library file's
//   content_fp       high    sent from a location whose indexed file was
//                            unchanged (size, modified time) at send
//   filename         medium  a unique name in the Library, never verified
//   filename         low     the name fits files of several Models: unlinked,
//                            and an unlinked_print Review Item asks a person
//   none             none    not in the Library, or a generic name
//
// Which Model a Print belongs to NOW is derived (print_links): from the
// content, through the files that hold it, so a rename, a move by Decision,
// a merge and its undo all show the same Print in the right place without
// rewriting it. model_uuid_at_link keeps which Model it was in when it ran.
// A person's printed_as Decision wins over all of it (§4.1).
"use strict";
const { normalizeTitle } = require("./titles");
const { genericObject } = require("./genericNames");

const RULE_VERSION = 1;
const ACTIVE = "superseded_by IS NULL AND withdrawn_at IS NULL";
const CONFIRMED = new Set(["exact", "high"]);
const OUTCOME_OF = { "print-completed": "completed", "print-cancelled": "cancelled", "print-error": "failed" };
const START_EVENTS = ["print-started", "queue-print-started"];
// A printer runs one job at a time: an outcome closes the job open on it.
// Its name must match, or the job must be recent enough that nothing else
// can have run in between unseen.
const OPEN_JOB_TRUST_MS = 3 * 24 * 3600 * 1000;
const json = s => { try { return JSON.parse(s || "null"); } catch { return null; } };

const baseName = s => String(s || "").split(/[\\/]/).pop();
// Printers report a job's name in their own way (with or without a folder,
// Bambu without the extension): compared without either.
const jobName = s => baseName(s).replace(/(\.gcode)?\.(gcode|gco|g|gx|bgcode|3mf)$/i, "").toLowerCase();

// A name that says nothing about which model it is ("Assembly", "Benchy",
// "plate_1"): never linked by name alone (§4.4 rule 7, §6.3).
function genericName(remoteName) {
  const t = normalizeTitle(baseName(remoteName));
  if (!t.normalized || t.tokenCount === 0 || t.normalized.replace(/\s/g, "").length < 3) return { reason: "no meaningful words" };
  const g = genericObject(t.normalized);
  if (g) return { term: g.term, reason: g.reason };
  if (t.genericScore >= 0.5) return { term: t.generic.map(x => x.term).join(", "), reason: (t.generic[0] || {}).reason || "generic words" };
  return null;
}

// ---------------------------------------------------------------- resolution

const canonical = (db, ck) => (ck ? (db.prepare("SELECT content_key FROM content_aliases WHERE alias = ?").get(ck) || {}).content_key || ck : null);
const keysFor = (db, ck) => [ck, ...db.prepare("SELECT alias FROM content_aliases WHERE content_key = ?").all(ck).map(r => r.alias)];

// A Model uuid, followed through merges to the Model that holds it now.
function liveModel(db, uuid) {
  for (let hop = 0; hop < 10 && uuid; hop++) {
    const m = db.prepare("SELECT id, uuid, merged_into FROM models WHERE uuid = ?").get(uuid);
    if (!m) return null;
    if (!m.merged_into) return m;
    uuid = m.merged_into;
  }
  return null;
}

// The Model that holds this content now. The file SnapCon sent from comes
// first (two copies of the same content can sit in two Models); then the
// only Model holding it; then, among several, the one it was in when it
// printed; else the one holding the most copies.
function modelOfContent(db, contentKey, { location = null, atLink = null } = {}) {
  const ck = canonical(db, contentKey);
  const keys = keysFor(db, ck);
  const rows = db.prepare(`SELECT root_id, rel_path, model_id FROM files WHERE entry_path = '' AND model_id IS NOT NULL
    AND content_key IN (${keys.map(() => "?").join(",")}) ORDER BY state != 'present', root_id, rel_path`).all(...keys);
  if (!rows.length) return null;
  if (location) { const at = rows.find(r => r.root_id + ":" + r.rel_path === location); if (at) return at.model_id; }
  const counts = new Map();
  for (const r of rows) counts.set(r.model_id, (counts.get(r.model_id) || 0) + 1);
  if (counts.size === 1) return rows[0].model_id;
  const was = atLink ? liveModel(db, atLink) : null;
  if (was && counts.has(was.id)) return was.id;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

// What a Print is linked to now: a person's Decision, else its own link.
function effectiveLink(db, p) {
  const d = db.prepare(`SELECT id, object_type, object_key FROM decisions WHERE subject_type = 'print' AND subject_key = ? AND relation = 'printed_as'
    AND polarity = 'affirm' AND ${ACTIVE} ORDER BY id DESC LIMIT 1`).get(String(p.id));
  if (d) {
    if (d.object_type === "model") { const m = liveModel(db, d.object_key); return { modelId: m ? m.id : null, variantKey: null, confidence: "exact", method: "decision", byDecision: true }; }
    const [ck, plate] = String(d.object_key).split("#");
    return { modelId: modelOfContent(db, ck, { location: p.location }), variantKey: canonical(db, ck) + (plate ? "#" + plate : ""), confidence: "exact", method: "decision", byDecision: true };
  }
  if (p.content_key) {
    return { modelId: modelOfContent(db, p.content_key, { location: p.location, atLink: p.model_uuid_at_link }) || (liveModel(db, p.model_uuid_at_link) || {}).id || null,
      variantKey: canonical(db, p.content_key) + (p.plate_no != null ? "#" + p.plate_no : ""), confidence: p.link_confidence, method: p.link_method, byDecision: false };
  }
  if (p.model_uuid_at_link && p.link_confidence !== "low" && p.link_confidence !== "none") {
    const m = liveModel(db, p.model_uuid_at_link);
    return { modelId: m ? m.id : null, variantKey: null, confidence: p.link_confidence, method: p.link_method, byDecision: false };
  }
  return { modelId: null, variantKey: null, confidence: p.link_confidence, method: p.link_method, byDecision: false };
}

// print_links and model_stats, recomputed from every Print (derived, §4.6):
// run after grouping and after any Print is recorded. Counts only what is
// linked: exact/high (and a person's Decision) are confirmed; medium is
// "matched by filename"; low and none count nowhere.
function refreshStats(db) {
  db.prepare("DELETE FROM print_links").run();
  db.prepare("DELETE FROM model_stats").run();
  const ins = db.prepare("INSERT INTO print_links (print_id, model_id, variant_key, confidence, method, by_decision) VALUES (?, ?, ?, ?, ?, ?)");
  const stats = new Map();
  for (const p of db.prepare("SELECT * FROM prints").all()) {
    const l = effectiveLink(db, p);
    ins.run(p.id, l.modelId, l.variantKey, l.confidence, l.method, l.byDecision ? 1 : 0);
    if (!l.modelId || !(CONFIRMED.has(l.confidence) || l.confidence === "medium")) continue;
    const s = stats.get(l.modelId) || { n: 0, confirmed: 0, filename: 0, last: null };
    s.n++;
    if (CONFIRMED.has(l.confidence)) s.confirmed++; else s.filename++;
    const at = p.started_at || p.ended_at;
    if (at && (s.last == null || at > s.last)) s.last = at;
    stats.set(l.modelId, s);
  }
  const st = db.prepare("INSERT INTO model_stats (model_id, print_count, print_count_confirmed, print_count_filename, last_printed_at) VALUES (?, ?, ?, ?, ?)");
  for (const [id, s] of stats) st.run(id, s.n, s.confirmed, s.filename, s.last);
  return { prints: db.prepare("SELECT count(*) AS n FROM prints").get().n, models: stats.size };
}

// ---------------------------------------------------------------- linking

// Files the Library could have printed under this name: top-level files with
// at least one printable Variant.
function nameIndex(db) {
  const idx = new Map();
  for (const f of db.prepare(`SELECT f.id, f.name, f.content_key, f.root_id, f.rel_path, f.state, m.uuid AS model, m.name AS model_name,
      (SELECT count(*) FROM variants v WHERE v.file_id = f.id) AS nv, (SELECT min(v.plate_no) FROM variants v WHERE v.file_id = f.id) AS plate
    FROM files f LEFT JOIN models m ON m.id = f.model_id WHERE f.entry_path = '' AND EXISTS (SELECT 1 FROM variants v WHERE v.file_id = f.id)`).all()) {
    const k = f.name.toLowerCase();
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(f);
  }
  return idx;
}

const SHORT = 16;
const short = k => (k ? String(k).slice(0, SHORT) : null);

// e: { library, sha256, location, stat, remoteName, via } → the link columns,
// plus a Review Item when a person should choose.
function linkFor(db, e, names) {
  const atLink = ck => { const id = modelOfContent(db, ck, { location: e.location }); return id ? db.prepare("SELECT uuid FROM models WHERE id = ?").get(id).uuid : null; };
  if (e.library && e.library.contentKey) {
    return { content_key: e.library.contentKey, plate_no: e.library.plate == null ? null : e.library.plate, model_uuid_at_link: e.library.model || atLink(e.library.contentKey),
      link_method: "snapcon_variant", link_confidence: "exact",
      evidence: { basis: "chosen in the Library", variant: short(e.library.variantKey || e.library.contentKey), sha256: short(e.library.sha256 || e.sha256), location: e.location || null } };
  }
  if (e.sha256) {
    const f = db.prepare(`SELECT content_key FROM files WHERE entry_path = '' AND (sha256 = ? OR content_key = ?) ORDER BY state != 'present' LIMIT 1`).get(e.sha256, e.sha256);
    if (f) {
      const plate = singlePlate(db, f.content_key);
      return { content_key: f.content_key, plate_no: plate, model_uuid_at_link: atLink(f.content_key), link_method: "queue_sha256", link_confidence: "exact",
        evidence: { basis: "the hash verified at dispatch is a Library file's", sha256: short(e.sha256), location: e.location || null } };
    }
  }
  if (e.location && e.stat) {
    const [root, ...rest] = String(e.location).split(":");
    const f = db.prepare("SELECT content_key, size, mtime_ms FROM files WHERE root_id = ? AND rel_path = ? AND entry_path = '' AND state = 'present'").get(root, rest.join(":"));
    if (f && f.size === e.stat.size && Math.abs(f.mtime_ms - e.stat.mtimeMs) < 1) {
      return { content_key: f.content_key, plate_no: singlePlate(db, f.content_key), model_uuid_at_link: atLink(f.content_key), link_method: "content_fp", link_confidence: "high",
        evidence: { basis: "sent from a file the Library had indexed, unchanged since", location: e.location } };
    }
  }
  return byName(db, e.remoteName, names || nameIndex(db));
}

// The plate a content key's only Variant has (a plain G-code: none).
function singlePlate(db, ck) {
  const v = db.prepare("SELECT v.plate_no FROM variants v JOIN files f ON f.id = v.file_id WHERE f.content_key = ? AND f.entry_path = ''").all(ck);
  return v.length === 1 ? v[0].plate_no : null;
}

// By name alone: at most medium, and only when the name is specific and
// every file carrying it is in one Model (§9).
function byName(db, remoteName, names) {
  const name = baseName(remoteName);
  const cands = names.get(name.toLowerCase()) || [];
  const models = [...new Map(cands.filter(c => c.model).map(c => [c.model, { uuid: c.model, name: c.model_name }])).values()];
  const generic = genericName(name);
  if (generic) {
    return { content_key: null, plate_no: null, model_uuid_at_link: null, link_method: "none", link_confidence: "none",
      evidence: { basis: "generic name", name, term: generic.term || null, reason: generic.reason, candidates: models.length },
      review: models.length ? { generic: true, candidates: models } : null };
  }
  if (!cands.length) return { content_key: null, plate_no: null, model_uuid_at_link: null, link_method: "none", link_confidence: "none", evidence: { basis: "not in the Library", name } };
  const keys = [...new Set(cands.map(c => c.content_key))];
  if (models.length > 1) {
    return { content_key: null, plate_no: null, model_uuid_at_link: null, link_method: "filename", link_confidence: "low",
      evidence: { basis: "the name fits files of several models", name, candidates: models },
      review: { generic: false, candidates: models } };
  }
  if (keys.length === 1) {
    const c = cands[0];
    return { content_key: c.content_key, plate_no: c.nv === 1 ? c.plate : null, model_uuid_at_link: c.model, link_method: "filename", link_confidence: "medium",
      evidence: { basis: "the only Library file with this name", name, copies: cands.length } };
  }
  // Several different files with this name, all in one Model: the Model is
  // known, the exact file is not.
  return { content_key: null, plate_no: null, model_uuid_at_link: models[0] ? models[0].uuid : null, link_method: "filename", link_confidence: models[0] ? "medium" : "none",
    evidence: { basis: "several files with this name, all in one model; which one is not known", name, files: keys.length } };
}

function raiseReview(db, printId, link, p, now) {
  if (!link.review) return false;
  const k = "unlinked_print:" + printId;
  if (db.prepare("SELECT 1 FROM review_items WHERE subject_key = ?").get(k)) return false;
  const summary = (link.review.generic ? "A print with a generic name" : "A print whose name fits several models") + ": " + baseName(p.remote_name);
  db.prepare(`INSERT INTO review_items (kind, subject_key, print_id, confidence, summary, evidence_json, priority, status, created_at, updated_at)
    VALUES ('unlinked_print', ?, ?, ?, ?, ?, 3, 'open', ?, ?)`).run(k, printId, link.link_confidence, summary,
    JSON.stringify({ name: baseName(p.remote_name), generic: link.review.generic, candidates: link.review.candidates.slice(0, 12) }), now, now);
  return true;
}

// ---------------------------------------------------------------- recording

const COLS = ["content_key", "plate_no", "model_uuid_at_link", "printer_id", "printer_name", "remote_name", "source", "link_method", "link_confidence",
  "link_evidence_json", "link_rule_version", "user_id", "user_label", "started_at", "ended_at", "outcome", "elapsed_sec", "filament_g", "cost_est",
  "audit_ref", "via", "location", "queue_item_id", "job_key"];

function insertPrint(db, row) {
  const r = db.prepare(`INSERT OR IGNORE INTO prints (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")})`)
    .run(...COLS.map(c => (row[c] === undefined ? null : row[c])));
  return r.changes ? Number(r.lastInsertRowid) : null;
}

// A job SnapCon started or saw start. One row per job_key: a second report
// of the same job changes nothing. Any job still open on the printer ended
// without SnapCon seeing how: unknown, never guessed.
function recordStart(db, e, { now = Date.now() } = {}) {
  const existing = db.prepare("SELECT id FROM prints WHERE job_key = ?").get(e.jobKey);
  if (existing) return { id: existing.id, duplicate: true };
  const link = linkFor(db, e);
  const at = e.startedAt || now;
  db.prepare("UPDATE prints SET outcome = 'unknown' WHERE printer_id = ? AND outcome = 'printing' AND coalesce(started_at, 0) <= ?").run(e.printerId, at);
  const row = {
    ...link, link_evidence_json: JSON.stringify(link.evidence), link_rule_version: RULE_VERSION,
    printer_id: e.printerId, printer_name: e.printerName || null, remote_name: e.remoteName, source: e.source, via: e.via || null,
    user_id: (e.user || {}).userId || null, user_label: (e.user || {}).userLabel || null,
    started_at: at, outcome: "printing", audit_ref: e.auditRef || null, location: e.location || null, queue_item_id: e.queueItemId || null, job_key: e.jobKey,
  };
  const id = insertPrint(db, row);
  if (id) raiseReview(db, id, link, row, now);
  refreshStats(db);
  return { id, link: { method: link.link_method, confidence: link.link_confidence } };
}

// How a job ended, onto the job open on that printer.
function recordOutcome(db, e, { now = Date.now() } = {}) {
  const outcome = e.outcome;
  if (!["completed", "failed", "cancelled"].includes(outcome)) return { updated: 0 };
  const open = db.prepare("SELECT * FROM prints WHERE printer_id = ? AND outcome = 'printing' ORDER BY coalesce(started_at, 0) DESC, id DESC LIMIT 1").get(e.printerId);
  const at = e.at || now;
  if (!open || !(jobName(open.remote_name) === jobName(e.remoteName) || (open.started_at && at - open.started_at < OPEN_JOB_TRUST_MS))) return { updated: 0 };
  closeJob(db, open, { outcome, at, elapsedSec: e.elapsedSec, filamentG: e.filamentG, costEst: e.costEst, remoteName: e.remoteName });
  refreshStats(db);
  return { updated: 1, id: open.id };
}

function closeJob(db, row, { outcome, at, elapsedSec, filamentG, costEst, remoteName }) {
  let ev = json(row.link_evidence_json) || {};
  if (remoteName && jobName(remoteName) !== jobName(row.remote_name)) ev = { ...ev, reportedAs: baseName(remoteName) };
  db.prepare("UPDATE prints SET outcome = ?, ended_at = ?, elapsed_sec = coalesce(?, elapsed_sec), filament_g = coalesce(?, filament_g), cost_est = coalesce(?, cost_est), link_evidence_json = ? WHERE id = ?")
    .run(outcome, at, num(elapsedSec), num(filamentG), num(costEst), JSON.stringify(ev), row.id);
}
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------- the audit-log import (D7)

// events: audit rows (id, ts, event, userId, userLabel, printerId, printerName,
// detail) from the window, any order. queueHistory: { printerId: [item] } from
// the queue's recent history, whose verified sha256 upgrades a queued job's
// link. Idempotent: an event already behind a Print (live, or an earlier
// import) adds nothing; an outcome reaching a job still open closes it.
function importAudit(db, { events, queueHistory = {}, from = null, to = null, now = Date.now() }) {
  const names = nameIndex(db);
  const byAudit = new Map(db.prepare("SELECT * FROM prints WHERE audit_ref IS NOT NULL").all().map(p => [p.audit_ref, p]));
  const rep = {
    window: { from, to }, events: events.length, starts: 0, outcomes: 0, alreadyRecorded: 0, created: 0, closed: 0, orphanOutcomes: 0,
    byMethod: {}, byConfidence: {}, genericRefused: 0, notInLibrary: 0, ambiguous: 0, modelOnly: 0, queueHashUpgrades: 0, reviewItems: 0, examples: [],
  };
  const tally = (k, v) => { rep[k][v] = (rep[k][v] || 0) + 1; };
  const perPrinter = new Map();
  for (const ev of [...events].sort((a, b) => a.ts - b.ts || a.id - b.id)) {
    if (!ev.printerId) continue;
    if (!perPrinter.has(ev.printerId)) perPrinter.set(ev.printerId, []);
    perPrinter.get(ev.printerId).push(ev);
  }
  const lastStart = new Map();
  for (const [pid, list] of perPrinter) { const s = list.filter(x => START_EVENTS.includes(x.event)); if (s.length) lastStart.set(pid, s[s.length - 1].id); }
  for (const [printerId, list] of perPrinter) {
    let open = null;   // the job running on this printer: { row }
    for (const ev of list) {
      const d = json(ev.detail) || {};
      if (START_EVENTS.includes(ev.event)) {
        rep.starts++;
        let row = byAudit.get(ev.id) || db.prepare("SELECT * FROM prints WHERE job_key = ?").get("audit:" + ev.id);
        if (row) rep.alreadyRecorded++;
        else {
          const q = ev.event === "queue-print-started" ? queueMatch(queueHistory[printerId] || [], d.file, ev.ts) : null;
          const link = q && q.sha256 ? linkFor(db, { sha256: q.sha256, remoteName: d.file }, names) : byName(db, d.file, names);
          if (q && q.sha256 && link.link_method === "queue_sha256") rep.queueHashUpgrades++;
          const r = {
            ...link, link_evidence_json: JSON.stringify({ ...link.evidence, audit: ev.id }), link_rule_version: RULE_VERSION,
            printer_id: printerId, printer_name: ev.printerName || null, remote_name: d.file || "", source: "backfill",
            via: ev.event === "queue-print-started" ? "queue" : null, user_id: ev.userId || null, user_label: ev.userLabel || null,
            started_at: ev.ts, outcome: "unknown", audit_ref: ev.id, queue_item_id: q ? q.id : null, job_key: "audit:" + ev.id,
          };
          const id = insertPrint(db, r);
          if (id) {
            rep.created++;
            tally("byMethod", link.link_method); tally("byConfidence", link.link_confidence);
            if (link.evidence.basis === "generic name") rep.genericRefused++;
            else if (link.evidence.basis === "not in the Library") rep.notInLibrary++;
            else if (link.link_confidence === "low") rep.ambiguous++;
            else if (!link.content_key && link.model_uuid_at_link) rep.modelOnly++;
            if (raiseReview(db, id, link, r, now)) rep.reviewItems++;
            row = db.prepare("SELECT * FROM prints WHERE id = ?").get(id);
            if (rep.examples.length < 400) rep.examples.push({ print: id, file: d.file, printer: ev.printerName, at: ev.ts, method: link.link_method, confidence: link.link_confidence,
              basis: link.evidence.basis, model: link.model_uuid_at_link, contentKey: short(link.content_key) });
          }
        }
        // The job before it ended without an outcome SnapCon saw.
        if (open && open.row && open.row.outcome === "printing" && open.row.id !== (row && row.id)) {
          db.prepare("UPDATE prints SET outcome = 'unknown' WHERE id = ? AND outcome = 'printing'").run(open.row.id);
        }
        open = row ? { row } : null;
        // The last start of a printer may still be running unless an outcome
        // follows — if it is recent; an earlier one, or an old one, ended
        // unseen.
        if (row && row.source === "backfill" && row.outcome === "unknown" && lastStart.get(printerId) === ev.id && (to || now) - ev.ts < OPEN_JOB_TRUST_MS) {
          db.prepare("UPDATE prints SET outcome = 'printing' WHERE id = ?").run(row.id);
          row.outcome = "printing";
        }
        continue;
      }
      const outcome = OUTCOME_OF[ev.event];
      if (!outcome) continue;
      rep.outcomes++;
      const fields = { outcome, at: ev.ts, elapsedSec: d.elapsedSec, filamentG: d.filamentGramsEst, costEst: d.costEst, remoteName: d.file };
      if (open && open.row && (jobName(open.row.remote_name) === jobName(d.file) || ev.ts - (open.row.started_at || 0) < OPEN_JOB_TRUST_MS)) {
        const cur = db.prepare("SELECT * FROM prints WHERE id = ?").get(open.row.id);
        if (cur && (cur.outcome === "printing" || cur.outcome === "unknown")) { closeJob(db, cur, fields); rep.closed++; }
        open = null;
        continue;
      }
      // An outcome whose start is before the window or was never logged: the
      // job happened; when it started is not known.
      const key = "audit:" + ev.id;
      if (db.prepare("SELECT 1 FROM prints WHERE job_key = ?").get(key)) { open = null; continue; }
      const link = byName(db, d.file, names);
      const r = {
        ...link, link_evidence_json: JSON.stringify({ ...link.evidence, audit: ev.id, startNotSeen: true }), link_rule_version: RULE_VERSION,
        printer_id: printerId, printer_name: ev.printerName || null, remote_name: d.file || "", source: "backfill", via: null,
        started_at: null, ended_at: ev.ts, outcome, elapsed_sec: num(d.elapsedSec), filament_g: num(d.filamentGramsEst), cost_est: num(d.costEst),
        audit_ref: ev.id, job_key: key,
      };
      const id = insertPrint(db, r);
      if (id) {
        rep.orphanOutcomes++; rep.created++;
        tally("byMethod", link.link_method); tally("byConfidence", link.link_confidence);
        if (link.evidence.basis === "generic name") rep.genericRefused++;
        else if (link.evidence.basis === "not in the Library") rep.notInLibrary++;
        else if (link.link_confidence === "low") rep.ambiguous++;
        else if (!link.content_key && link.model_uuid_at_link) rep.modelOnly++;
        if (raiseReview(db, id, link, r, now)) rep.reviewItems++;
      }
      open = null;
    }
  }
  // An imported job still "printing" days later ended without SnapCon
  // seeing how (also corrects an earlier import's rows).
  rep.staleOpen = db.prepare("UPDATE prints SET outcome = 'unknown' WHERE source = 'backfill' AND outcome = 'printing' AND coalesce(started_at, 0) < ?").run((to || now) - OPEN_JOB_TRUST_MS).changes;
  refreshStats(db);
  const linked = db.prepare(`SELECT count(*) AS n, sum(confidence IN ('exact','high') OR by_decision = 1) AS confirmed, sum(confidence = 'medium' AND by_decision = 0) AS filename
    FROM print_links WHERE model_id IS NOT NULL AND (confidence IN ('exact','high','medium') OR by_decision = 1)`).get();
  rep.totals = { prints: db.prepare("SELECT count(*) AS n FROM prints").get().n, linked: linked.n || 0, confirmed: linked.confirmed || 0, filename: linked.filename || 0,
    modelsWithPrints: db.prepare("SELECT count(*) AS n FROM model_stats").get().n,
    openReviewItems: db.prepare("SELECT count(*) AS n FROM review_items WHERE kind = 'unlinked_print' AND status = 'open'").get().n };
  db.prepare("INSERT INTO print_imports (ran_at, from_ts, to_ts, created, updated, report_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(now, from, to, rep.created, rep.closed, JSON.stringify(rep));
  return rep;
}

// The queue item a queue-print-started event dispatched: same printer, same
// file name, dispatched within two minutes of the event.
function queueMatch(items, file, ts) {
  let best = null;
  for (const it of items) {
    if (!it || !it.file || it.file.name !== file || !it.dispatchedAt) continue;
    const dt = Math.abs(it.dispatchedAt - ts);
    if (dt <= 120000 && (!best || dt < best.dt)) best = { id: it.id, sha256: it.file.sha256 || null, dt };
  }
  return best;
}

// ---------------------------------------------------------------- reading

// A Model's Prints, newest first, each with what it was linked by and where
// it was then. visible(printerId) filters the rows (§9 D6); the caller has
// the counts from model_stats.
function historyFor(db, modelId, { visible = () => true, limit = 200 } = {}) {
  const rows = db.prepare(`SELECT p.*, pl.variant_key, pl.confidence AS eff_confidence, pl.method AS eff_method, pl.by_decision
    FROM print_links pl JOIN prints p ON p.id = pl.print_id WHERE pl.model_id = ? ORDER BY coalesce(p.started_at, p.ended_at) DESC, p.id DESC`).all(modelId);
  const model = db.prepare("SELECT uuid FROM models WHERE id = ?").get(modelId);
  const out = [];
  let hidden = 0;
  for (const p of rows) {
    if (!visible(p.printer_id)) { hidden++; continue; }
    if (out.length >= limit) continue;
    const ev = json(p.link_evidence_json) || {};
    let file = null;
    if (p.variant_key) {
      const [ck, plate] = p.variant_key.split("#");
      const f = db.prepare(`SELECT name, root_id, rel_path, state FROM files WHERE entry_path = '' AND content_key IN (${keysFor(db, ck).map(() => "?").join(",")})
        ORDER BY (root_id || ':' || rel_path) = ? DESC, state != 'present', root_id, rel_path LIMIT 1`).get(...keysFor(db, ck), p.location || "");
      if (f) file = { name: f.name, plate: plate ? Number(plate) : null, state: f.state };
    }
    let wasIn = null;
    if (p.model_uuid_at_link && p.model_uuid_at_link !== model.uuid) {
      const w = db.prepare("SELECT uuid, name, merged_into FROM models WHERE uuid = ?").get(p.model_uuid_at_link);
      if (w) wasIn = { uuid: w.uuid, name: w.name, merged: !!w.merged_into };
    }
    out.push({
      id: p.id, printerId: p.printer_id, printer: p.printer_name, remoteName: p.remote_name, startedAt: p.started_at, endedAt: p.ended_at,
      outcome: p.outcome, elapsedSec: p.elapsed_sec, filamentG: p.filament_g, user: p.user_label || null,
      via: p.via, source: p.source, file, location: p.location ? { root: p.location.split(":")[0] } : null,
      link: { method: p.eff_method, confidence: p.eff_confidence, byDecision: !!p.by_decision, basis: ev.basis || null, reportedAs: ev.reportedAs || null },
      wasIn,
    });
  }
  return { rows: out, hiddenCount: hidden };
}

module.exports = { RULE_VERSION, recordStart, recordOutcome, importAudit, refreshStats, historyFor, effectiveLink, linkFor, genericName, jobName, modelOfContent, liveModel };
