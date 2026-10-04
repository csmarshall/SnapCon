// library/actions.js — the M6 grouping tools (docs/library-design.md §7, §4.5):
// what a person does to the Library, written as durable authored state.
//
// Decision first. Every grouping action writes Decisions (member_of,
// distinct_from, targets_printer, hidden); Model facts a person sets (name,
// cover, hidden) are authored columns on `models`. Nothing here edits a
// derived row directly except through the same resolution grouping uses:
// after each action, grouping runs in the same transaction, so what the
// Library shows is what a rebuild would show.
//
// Each action is recorded in `actions` with exactly what it wrote and what
// it replaced, so it can be undone after a reload, by another user, or after
// a rebuild. Undo reverses that one action:
//   Decisions it wrote          withdrawn (kept, marked withdrawn_at)
//   Decisions it replaced       in force again
//   Model columns it set        restored to their earlier values
//   Review Items it closed      reopened (grouping closes them again if the
//                               condition is gone)
// and only while nothing later depends on it: if a later action replaced one
// of its Decisions, or a Model column it set has changed since, undo answers
// 409 instead of guessing. Automatic grouping then recomputes the rest.
//
// Stale requests: everything is addressed by stable keys (Model uuids, content
// keys, Review Item ids) and checked against the current state; an action
// that no longer applies answers 409 with a code, never a different result.
"use strict";
const crypto = require("crypto");
const PrinterIdentity = require("../public/printer-identity");
const { resolvePrinter } = require("./indexStore");

class ActionError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; if (extra) this.extra = extra; }
}
const fail = (status, code, message, extra) => { throw new ActionError(status, code, message, extra); };

// Which Library capability each action needs (§11). Undo needs the same.
const CAPABILITY = {
  merge: "library.edit.grouping", split: "library.edit.grouping", move: "library.edit.grouping",
  approve: "library.edit.grouping", reject: "library.edit.grouping", dismiss: "library.review",
  hide: "library.hide", unhide: "library.hide", hide_file: "library.hide", unhide_file: "library.hide",
  rename: "library.edit.metadata", cover: "library.edit.cover", set_printer: "library.edit.metadata",
};
const MODEL_ROLES = new Set(["sliced", "project", "source"]);
const FAMILY_KEYS = new Set(PrinterIdentity.FAMILIES.map(f => f.key));
const ACTIVE = "superseded_by IS NULL AND withdrawn_at IS NULL";

// ---------------------------------------------------------------- lookups

function modelByUuid(db, uuid, { allowMerged = false } = {}) {
  const m = db.prepare("SELECT * FROM models WHERE uuid = ?").get(String(uuid || ""));
  if (!m) fail(404, "model_not_found", "That model no longer exists.");
  if (m.merged_into && !allowMerged) fail(409, "model_merged", "That model was merged into another one.", { mergedInto: m.merged_into });
  return m;
}
// A content key and the older keys that still name the same content.
const keysFor = (db, ck) => [ck, ...db.prepare("SELECT alias FROM content_aliases WHERE content_key = ?").all(ck).map(r => r.alias)];

// The top-level Files of `model` with these content keys. A Plate, a Variant
// or an entry inside a 3MF is part of its file: it moves with the file, never
// on its own (§3: structural, not grouping).
function filesInModel(db, model, keys) {
  if (!Array.isArray(keys) || !keys.length) fail(400, "no_files", "Choose at least one file.");
  const out = [];
  for (const raw of [...new Set(keys.map(String))]) {
    if (raw.includes("#")) fail(400, "structural", "A plate belongs to its project file and moves with it.");
    const rows = db.prepare("SELECT * FROM files WHERE content_key = ? ORDER BY entry_path != '', root_id, rel_path").all(raw);
    if (rows.length && rows.every(r => r.entry_path)) fail(400, "structural", "A file inside a 3MF belongs to that project and moves with it.");
    const top = rows.filter(r => !r.entry_path && r.model_id === model.id);
    if (!top.length) fail(409, "stale_file", "That file is no longer in this model.", { contentKey: raw });
    if (!MODEL_ROLES.has(top[0].role)) fail(400, "not_model_file", "Only model files can be moved.");
    out.push({ key: raw, hint: top[0].root_id + ":" + top[0].rel_path, name: top[0].name });
  }
  return out;
}
function openReview(db, id, kinds) {
  const r = db.prepare("SELECT * FROM review_items WHERE id = ?").get(Number(id));
  if (!r) fail(404, "review_not_found", "That item no longer exists.");
  if (r.status !== "open") fail(409, "review_resolved", "That item was already resolved.", { status: r.status });
  if (kinds && !kinds.includes(r.kind)) fail(400, "wrong_review_kind", "This action doesn't apply to that item.");
  return r;
}

// ---------------------------------------------------------------- the recorder

function begin(db, kind, { modelUuid = null, otherUuid = null, actor = {}, now }) {
  const id = Number(db.prepare("INSERT INTO actions (kind, model_uuid, other_model_uuid, detail_json, user_id, user_label, created_at) VALUES (?, ?, ?, '{}', ?, ?, ?)")
    .run(kind, modelUuid, otherUuid, actor.userId || null, actor.userLabel || null, now).lastInsertRowid);
  const d = { created: [], superseded: [], withdrawn: [], models: [], reviews: [], tags: [], collections: [], printerKeys: [], placed: [], createdModel: null, retireInto: null, summary: {} };
  const by = actor.userLabel || actor.userId || null;
  const ctx = {
    id, kind, now, by, d,
    decide(dec) {
      const did = Number(db.prepare(`INSERT INTO decisions (subject_type, subject_key, relation, polarity, object_type, object_key, value_json, subject_hint, reason,
          from_claim_key, evidence_snapshot_json, created_by, created_at, action_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(dec.subject_type, dec.subject_key, dec.relation, dec.polarity || "affirm", dec.object_type || null, dec.object_key || null, dec.value_json || null,
          dec.subject_hint || null, dec.reason || null, dec.from_claim_key || null, dec.evidence_snapshot_json || null, by, now, id).lastInsertRowid);
      d.created.push(did);
      return did;
    },
    supersede(ids, byId) {
      for (const sid of ids) if (db.prepare(`UPDATE decisions SET superseded_by = ? WHERE id = ? AND ${ACTIVE}`).run(byId, sid).changes) d.superseded.push(sid);
    },
    withdraw(ids) {
      for (const wid of ids) if (db.prepare(`UPDATE decisions SET withdrawn_at = ? WHERE id = ? AND ${ACTIVE}`).run(now, wid).changes) d.withdrawn.push(wid);
    },
    // Authored Model columns: what they were, what they became.
    setModel(model, after) {
      const before = {};
      for (const k of Object.keys(after)) before[k] = model[k];
      if (Object.keys(after).every(k => before[k] === after[k])) return;
      db.prepare(`UPDATE models SET ${Object.keys(after).map(k => k + " = ?").join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).run(...Object.values(after), now, by, model.id);
      Object.assign(model, after);
      d.models.push({ uuid: model.uuid, before, after });
    },
    closeReview(r, status, decisionId, note) {
      d.reviews.push({ id: r.id, status: r.status, resolution_decision_id: r.resolution_decision_id, resolution_note: r.resolution_note, resolved_by: r.resolved_by, resolved_at: r.resolved_at });
      db.prepare("UPDATE review_items SET status = ?, resolution_decision_id = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
        .run(status, decisionId || null, note || null, by, now, now, r.id);
    },
    finish(summary) {
      d.summary = summary || {};
      db.prepare("UPDATE actions SET detail_json = ? WHERE id = ?").run(JSON.stringify(d), id);
      return { actionId: id, kind, ...d.summary };
    },
  };
  return ctx;
}

// ---------------------------------------------------------------- membership

// Put Files in `to` (member_of affirm), and — when they come from a Model a
// person is taking them out of — keep them out of `from` (member_of reject).
// Earlier placements of the same Files are replaced, never deleted.
function place(db, ctx, files, to, from, extra = {}) {
  for (const f of files) {
    // Where it was: undo puts its last-known membership back exactly.
    const was = db.prepare("SELECT m.uuid FROM files fi JOIN models m ON m.id = fi.model_id WHERE fi.content_key = ? AND fi.entry_path = '' LIMIT 1").get(f.key);
    ctx.d.placed.push({ key: f.key, to: to.uuid, was: was ? was.uuid : null });
    const keys = keysFor(db, f.key);
    const ph = keys.map(() => "?").join(",");
    const replaced = db.prepare(`SELECT id FROM decisions WHERE ${ACTIVE} AND relation = 'member_of' AND subject_type = 'file' AND subject_key IN (${ph})
      AND (polarity = 'affirm' OR object_key = ?)`).all(...keys, to.uuid).map(r => r.id);
    const id = ctx.decide({ subject_type: "file", subject_key: f.key, relation: "member_of", polarity: "affirm", object_type: "model", object_key: to.uuid,
      subject_hint: f.hint, reason: extra.reason, from_claim_key: extra.claimKey, evidence_snapshot_json: extra.evidence });
    ctx.supersede(replaced, id);
    if (from && !db.prepare(`SELECT 1 FROM decisions WHERE ${ACTIVE} AND relation = 'member_of' AND polarity = 'reject' AND subject_key IN (${ph}) AND object_key = ?`).get(...keys, from.uuid)) {
      ctx.decide({ subject_type: "file", subject_key: f.key, relation: "member_of", polarity: "reject", object_type: "model", object_key: from.uuid, subject_hint: f.hint, reason: extra.reason });
    }
  }
}

function topFiles(db, model) {
  return db.prepare("SELECT content_key AS key, min(root_id || ':' || rel_path) AS hint, min(name) AS name FROM files WHERE model_id = ? AND entry_path = '' AND role IN ('sliced','project','source') GROUP BY content_key ORDER BY hint").all(model.id);
}

// Merge `from` into `into`: every File of `from` becomes a member of `into`;
// `from` is kept (merged_into), never deleted. Survivor's authored values win;
// the absorbed Model's fill only what the survivor lacks, unless the person
// chose the absorbed name or cover. Tags and collections are united. A
// distinct_from with a third Model carries over to the survivor.
function doMerge(db, ctx, from, into, opts, extra = {}) {
  if (from.id === into.id) fail(400, "same_model", "A model can't be merged into itself.");
  const files = topFiles(db, from);
  place(db, ctx, files, into, null, extra);
  // Distinct-from Decisions: between the two, now replaced; with a third Model,
  // carried to the survivor.
  const dists = db.prepare(`SELECT * FROM decisions WHERE ${ACTIVE} AND relation = 'distinct_from' AND (subject_key = ? OR object_key = ?)`).all(from.uuid, from.uuid);
  for (const dd of dists) {
    const other = dd.subject_key === from.uuid ? dd.object_key : dd.subject_key;
    if (other === into.uuid) { if (ctx.d.created.length) ctx.supersede([dd.id], ctx.d.created[0]); else ctx.withdraw([dd.id]); continue; }
    if (!db.prepare(`SELECT 1 FROM decisions WHERE ${ACTIVE} AND relation = 'distinct_from' AND ((subject_key = ? AND object_key = ?) OR (subject_key = ? AND object_key = ?))`).get(into.uuid, other, other, into.uuid)) {
      ctx.decide({ subject_type: "model", subject_key: into.uuid, relation: "distinct_from", object_type: "model", object_key: other, reason: "carried over from a merged model" });
    }
  }
  const set = {};
  if (opts.keepName === "from") Object.assign(set, { name: from.name, name_source: "user" });
  if (opts.keepCover === "from") {
    const ref = coverRef(db, from);
    if (ref) Object.assign(set, { cover_content_key: ref.contentKey, cover_plate: ref.plate, cover_source: "user" });
  }
  for (const col of ["designer", "license", "source_url", "notes", "design_model_id"]) if (into[col] == null && from[col] != null) set[col] = from[col];
  ctx.setModel(into, set);
  for (const r of db.prepare("SELECT tag_id FROM model_tags WHERE model_id = ?").all(from.id)) {
    if (db.prepare("INSERT OR IGNORE INTO model_tags (model_id, tag_id, added_by, added_at) VALUES (?, ?, ?, ?)").run(into.id, r.tag_id, ctx.by, ctx.now).changes) ctx.d.tags.push(r.tag_id);
  }
  for (const r of db.prepare("SELECT collection_id FROM collection_models WHERE model_id = ?").all(from.id)) {
    if (db.prepare("INSERT OR IGNORE INTO collection_models (collection_id, model_id, added_by) VALUES (?, ?, ?)").run(r.collection_id, into.id, ctx.by).changes) ctx.d.collections.push(r.collection_id);
  }
  ctx.d.tagsModel = into.id;
  ctx.setModel(from, { merged_into: into.uuid });
  // Suggestions between the two are answered by this.
  for (const r of db.prepare(`SELECT * FROM review_items WHERE status = 'open' AND kind = 'suggested_match' AND ((model_uuid = ? AND other_model_uuid = ?) OR (model_uuid = ? AND other_model_uuid = ?))`).all(from.uuid, into.uuid, into.uuid, from.uuid)) {
    ctx.closeReview(r, "resolved", ctx.d.created[0], "merged");
  }
  return files.length;
}

// Where a Model's cover comes from now (§10 order), as content key + plate.
function coverRef(db, model) {
  if (model.cover_source === "user" && model.cover_content_key) return { contentKey: model.cover_content_key, plate: model.cover_plate };
  const img = db.prepare(`SELECT f.content_key FROM files f JOIN thumbs t ON t.key = f.thumb_key WHERE f.model_id = ? AND f.role = 'image' ORDER BY t.bytes DESC LIMIT 1`).get(model.id);
  if (img) return { contentKey: img.content_key, plate: null };
  const pl = db.prepare(`SELECT f.content_key, p.plate_no FROM plates p JOIN projects pr ON pr.id = p.project_id JOIN files f ON f.id = pr.file_id
    WHERE f.model_id = ? AND p.thumb_key IS NOT NULL ORDER BY p.plate_no LIMIT 1`).get(model.id);
  if (pl) return { contentKey: pl.content_key, plate: pl.plate_no };
  const g = db.prepare(`SELECT f.content_key FROM files f JOIN thumbs t ON t.key = f.thumb_key WHERE f.model_id = ? AND f.entry_path = '' ORDER BY (t.w * t.h) DESC, t.bytes DESC LIMIT 1`).get(model.id);
  return g ? { contentKey: g.content_key, plate: null } : null;
}

// The printer cache on Variants follows the Decisions (resolvePrinter).
function refreshPrinters(db, keys) {
  for (const key of keys) {
    const [ck, plate] = key.split("#");
    const rows = db.prepare(`SELECT v.id FROM variants v JOIN files f ON f.id = v.file_id WHERE f.content_key = ? AND ${plate != null ? "v.plate_no = ?" : "v.plate_no IS NULL"}`).all(...(plate != null ? [ck, Number(plate)] : [ck]));
    const res = resolvePrinter(db, key);
    for (const r of rows) db.prepare("UPDATE variants SET printer_family = ?, printer_claim_key = ?, printer_decision_id = ? WHERE id = ?").run(res.family, res.claimKey, res.decisionId, r.id);
  }
}

// ---------------------------------------------------------------- actions

const cleanName = n => String(n == null ? "" : n).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

function apply(db, a, { actor = {}, now = Date.now() } = {}) {
  const kind = a && a.kind;
  if (!CAPABILITY[kind]) fail(400, "unknown_action", "Unknown action.");
  switch (kind) {
    case "merge": {
      const from = modelByUuid(db, a.from), into = modelByUuid(db, a.into);
      const ctx = begin(db, kind, { modelUuid: into.uuid, otherUuid: from.uuid, actor, now });
      const n = doMerge(db, ctx, from, into, { keepName: a.keepName, keepCover: a.keepCover });
      return ctx.finish({ model: into.uuid, from: { uuid: from.uuid, name: from.name }, into: { uuid: into.uuid, name: into.name }, files: n });
    }
    case "approve": {
      const r = openReview(db, a.review, ["suggested_match", "unlinked_print"]);
      if (r.kind === "unlinked_print") return linkPrint(db, r, a, { actor, now });
      const x = modelByUuid(db, r.model_uuid), y = modelByUuid(db, r.other_model_uuid);
      const survivor = a.survivor === x.uuid ? x : a.survivor === y.uuid ? y : fail(400, "bad_survivor", "Choose which model to keep.");
      const absorbed = survivor === x ? y : x;
      const claim = r.claim_key ? db.prepare("SELECT claim_key, evidence_json FROM claims WHERE claim_key = ?").get(r.claim_key) : null;
      const ctx = begin(db, kind, { modelUuid: survivor.uuid, otherUuid: absorbed.uuid, actor, now });
      const n = doMerge(db, ctx, absorbed, survivor, { keepName: a.keepName, keepCover: a.keepCover },
        { reason: "approved suggestion", claimKey: claim && claim.claim_key, evidence: claim && claim.evidence_json });
      if (db.prepare("SELECT status FROM review_items WHERE id = ?").get(r.id).status === "open") ctx.closeReview(r, "resolved", ctx.d.created[0], "approved");
      return ctx.finish({ model: survivor.uuid, from: { uuid: absorbed.uuid, name: absorbed.name }, into: { uuid: survivor.uuid, name: survivor.name }, files: n });
    }
    case "reject": {
      const r = openReview(db, a.review, ["suggested_match"]);
      const x = modelByUuid(db, r.model_uuid), y = modelByUuid(db, r.other_model_uuid);
      const claim = r.claim_key ? db.prepare("SELECT claim_key, evidence_json FROM claims WHERE claim_key = ?").get(r.claim_key) : null;
      const ctx = begin(db, kind, { modelUuid: x.uuid, otherUuid: y.uuid, actor, now });
      const id = ctx.decide({ subject_type: "model", subject_key: x.uuid, relation: "distinct_from", object_type: "model", object_key: y.uuid, reason: "rejected suggestion",
        from_claim_key: claim && claim.claim_key, evidence_snapshot_json: claim && claim.evidence_json });
      ctx.closeReview(r, "resolved", id, "kept apart");
      return ctx.finish({ model: x.uuid, a: { uuid: x.uuid, name: x.name }, b: { uuid: y.uuid, name: y.name } });
    }
    case "dismiss": {
      const r = openReview(db, a.review);
      const ctx = begin(db, kind, { modelUuid: r.model_uuid, otherUuid: r.other_model_uuid, actor, now });
      ctx.closeReview(r, "dismissed", null, "dismissed");
      return ctx.finish({ review: r.id, reviewKind: r.kind });
    }
    case "move": {
      const from = modelByUuid(db, a.model), to = modelByUuid(db, a.to);
      if (from.id === to.id) fail(400, "same_model", "The file is already in that model.");
      const files = filesInModel(db, from, a.files);
      const ctx = begin(db, kind, { modelUuid: from.uuid, otherUuid: to.uuid, actor, now });
      place(db, ctx, files, to, from, { reason: "moved by hand" });
      if (a.review != null) { const r = openReview(db, a.review, ["ambiguous_grouping"]); ctx.closeReview(r, "resolved", ctx.d.created[0], "chosen"); }
      return ctx.finish({ model: to.uuid, from: { uuid: from.uuid, name: from.name }, to: { uuid: to.uuid, name: to.name }, files: files.map(f => f.name) });
    }
    case "split": {
      const from = modelByUuid(db, a.model);
      const files = filesInModel(db, from, a.files);
      const name = cleanName(a.name).slice(0, 120) || cleanName(files[0].name.replace(/\.[^.]+$/, ""));
      const ctx = begin(db, kind, { modelUuid: from.uuid, actor, now });
      const uuid = crypto.randomUUID();
      const nid = Number(db.prepare("INSERT INTO models (uuid, origin, name, name_source, created_at, updated_at, updated_by) VALUES (?, 'user', ?, 'user', ?, ?, ?)").run(uuid, name, now, now, ctx.by).lastInsertRowid);
      const created = db.prepare("SELECT * FROM models WHERE id = ?").get(nid);
      ctx.d.createdModel = uuid; ctx.d.retireInto = from.uuid;
      db.prepare("UPDATE actions SET other_model_uuid = ? WHERE id = ?").run(uuid, ctx.id);
      place(db, ctx, files, created, from, { reason: "separated by hand" });
      return ctx.finish({ model: uuid, from: { uuid: from.uuid, name: from.name }, to: { uuid, name }, files: files.map(f => f.name) });
    }
    case "hide": case "unhide": {
      const m = modelByUuid(db, a.model);
      const ctx = begin(db, kind, { modelUuid: m.uuid, actor, now });
      ctx.setModel(m, { hidden: kind === "hide" ? 1 : 0 });
      return ctx.finish({ model: m.uuid, name: m.name });
    }
    case "hide_file": case "unhide_file": {
      const m = modelByUuid(db, a.model);
      const [f] = filesInModel(db, m, a.files || [a.file]);
      const keys = keysFor(db, f.key), ph = keys.map(() => "?").join(",");
      const active = db.prepare(`SELECT id FROM decisions WHERE ${ACTIVE} AND relation = 'hidden' AND subject_type = 'file' AND subject_key IN (${ph})`).all(...keys).map(r => r.id);
      const ctx = begin(db, kind, { modelUuid: m.uuid, actor, now });
      if (kind === "hide_file") { if (!active.length) ctx.decide({ subject_type: "file", subject_key: f.key, relation: "hidden", polarity: "affirm", subject_hint: f.hint, reason: "hidden by hand" }); }
      else { if (!active.length) fail(409, "not_hidden", "That file isn't hidden."); ctx.withdraw(active); }
      return ctx.finish({ model: m.uuid, file: f.name });
    }
    case "rename": {
      const m = modelByUuid(db, a.model);
      const ctx = begin(db, kind, { modelUuid: m.uuid, actor, now });
      if (a.auto) ctx.setModel(m, { name_source: "auto" });   // grouping names it again
      else {
        const name = cleanName(a.name);
        if (!name) fail(400, "name_required", "Enter a name.");
        if (name.length > 120) fail(400, "name_too_long", "A name can be at most 120 characters.");
        ctx.setModel(m, { name, name_source: "user" });
      }
      return ctx.finish({ model: m.uuid, before: ctx.d.models[0] ? ctx.d.models[0].before.name : m.name, after: m.name });
    }
    case "cover": {
      const m = modelByUuid(db, a.model);
      const ctx = begin(db, kind, { modelUuid: m.uuid, actor, now });
      if (a.auto) ctx.setModel(m, { cover_source: "auto", cover_content_key: null, cover_plate: null });
      else {
        const ck = String(a.file || "");
        const plate = a.plate == null ? null : Number(a.plate);
        const ok = plate != null
          ? db.prepare(`SELECT 1 FROM plates p JOIN projects pr ON pr.id = p.project_id JOIN files f ON f.id = pr.file_id WHERE f.content_key = ? AND f.model_id = ? AND p.plate_no = ? AND p.thumb_key IS NOT NULL`).get(ck, m.id, plate)
          : db.prepare("SELECT 1 FROM files WHERE content_key = ? AND model_id = ? AND thumb_key IS NOT NULL").get(ck, m.id);
        if (!ok) fail(409, "stale_cover", "That picture is no longer part of this model.");
        ctx.setModel(m, { cover_content_key: ck, cover_plate: plate, cover_source: "user" });
      }
      return ctx.finish({ model: m.uuid });
    }
    case "set_printer": {
      const m = modelByUuid(db, a.model);
      const [f] = filesInModel(db, m, [a.file]);
      const plate = a.plate == null ? null : Number(a.plate);
      const v = db.prepare(`SELECT v.* FROM variants v JOIN files fi ON fi.id = v.file_id WHERE fi.content_key = ? AND ${plate == null ? "v.plate_no IS NULL" : "v.plate_no = ?"} LIMIT 1`).get(...(plate == null ? [f.key] : [f.key, plate]));
      if (!v) fail(409, "stale_variant", "That printable file or plate is no longer there.");
      const family = a.family == null || a.family === "" ? null : String(a.family);
      if (family && !FAMILY_KEYS.has(family)) fail(400, "unknown_family", "Unknown printer.");
      const key = plate == null ? f.key : f.key + "#" + plate;
      const keys = keysFor(db, f.key).map(k => (plate == null ? k : k + "#" + plate));
      const active = db.prepare(`SELECT id FROM decisions WHERE ${ACTIVE} AND relation = 'targets_printer' AND subject_type = 'variant' AND subject_key IN (${keys.map(() => "?").join(",")})`).all(...keys).map(r => r.id);
      const fileSays = db.prepare(`SELECT object_key, confidence, state FROM claims WHERE subject_type = 'variant' AND subject_key = ? AND relation = 'targets_printer'
        ORDER BY CASE state WHEN 'applied' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END LIMIT 1`).get(key);
      const ctx = begin(db, kind, { modelUuid: m.uuid, actor, now });
      ctx.d.printerKeys.push(key);
      if (family) {
        const id = ctx.decide({ subject_type: "variant", subject_key: key, relation: "targets_printer", polarity: "affirm", object_type: "printer_family", object_key: family,
          value_json: JSON.stringify({ printer_family: family, fileSays: fileSays ? fileSays.object_key : null }), subject_hint: f.hint, reason: "set by hand" });
        ctx.supersede(active, id);
      } else {
        if (!active.length) fail(409, "not_set", "This printer wasn't set by hand.");
        ctx.withdraw(active);
      }
      refreshPrinters(db, [key]);
      return ctx.finish({ model: m.uuid, file: f.name, plate, family, fileSays: fileSays ? fileSays.object_key : null });
    }
    default: fail(400, "unknown_action", "Unknown action.");
  }
}

// An unlinked Print (M7, §8): a person says which Model it was. Written as a
// printed_as Decision on the Print; the Print row itself is never rewritten,
// so undo withdraws the Decision and the Print is unlinked again. The choice
// is one of the Models the Review Item offered.
function linkPrint(db, r, a, { actor, now }) {
  const ev = (() => { try { return JSON.parse(r.evidence_json || "{}"); } catch { return {}; } })();
  const offered = new Set((ev.candidates || []).map(c => c.uuid));
  if (!a.model || !offered.has(String(a.model))) fail(400, "bad_choice", "Choose one of the models offered.");
  const m = modelByUuid(db, a.model, { allowMerged: true });
  const live = (() => { let x = m; for (let i = 0; i < 10 && x && x.merged_into; i++) x = db.prepare("SELECT * FROM models WHERE uuid = ?").get(x.merged_into); return x; })();
  if (!live) fail(409, "model_not_found", "That model no longer exists.");
  const p = r.print_id ? db.prepare("SELECT id, remote_name, printer_name, started_at, ended_at FROM prints WHERE id = ?").get(r.print_id) : null;
  if (!p) fail(409, "print_not_found", "That print is no longer recorded.");
  const ctx = begin(db, "approve", { modelUuid: live.uuid, actor, now });
  const id = ctx.decide({ subject_type: "print", subject_key: String(p.id), relation: "printed_as", polarity: "affirm", object_type: "model", object_key: live.uuid,
    subject_hint: p.remote_name, reason: "linked by hand", evidence_snapshot_json: r.evidence_json });
  ctx.closeReview(r, "resolved", id, "linked");
  return ctx.finish({ model: live.uuid, name: live.name, print: { id: p.id, file: p.remote_name, at: p.started_at || p.ended_at }, reviewKind: "unlinked_print" });
}

function undo(db, actionId, { actor = {}, now = Date.now() } = {}) {
  const a = db.prepare("SELECT * FROM actions WHERE id = ?").get(Number(actionId));
  if (!a) fail(404, "action_not_found", "That change no longer exists.");
  if (a.undone_at) fail(409, "already_undone", "That change was already undone.");
  const d = JSON.parse(a.detail_json || "{}");
  // Nothing later may depend on it.
  for (const id of d.created || []) {
    const dec = db.prepare("SELECT superseded_by, withdrawn_at FROM decisions WHERE id = ?").get(id);
    if (dec && (dec.superseded_by || dec.withdrawn_at)) fail(409, "undo_blocked", "A later change depends on this one. Undo that first.");
  }
  for (const id of d.withdrawn || []) {
    const dec = db.prepare("SELECT superseded_by FROM decisions WHERE id = ?").get(id);
    if (dec && dec.superseded_by) fail(409, "undo_blocked", "A later change depends on this one. Undo that first.");
  }
  for (const mc of d.models || []) {
    const row = db.prepare("SELECT * FROM models WHERE uuid = ?").get(mc.uuid);
    if (!row || Object.keys(mc.after).some(k => row[k] !== mc.after[k])) fail(409, "undo_blocked", "That model was changed again since. Undo the later change first.");
  }
  if (d.createdModel && db.prepare(`SELECT 1 FROM decisions WHERE ${ACTIVE} AND relation = 'member_of' AND polarity = 'affirm' AND object_key = ? AND (action_id IS NULL OR action_id != ?)`).get(d.createdModel, a.id)) {
    fail(409, "undo_blocked", "Other files were added to the new model since. Move them first.");
  }
  // Reverse.
  for (const id of d.created || []) db.prepare("UPDATE decisions SET withdrawn_at = ? WHERE id = ?").run(now, id);
  for (const id of d.superseded || []) db.prepare("UPDATE decisions SET superseded_by = NULL WHERE id = ? AND superseded_by IN (SELECT value FROM json_each(?))").run(id, JSON.stringify(d.created || []));
  for (const id of d.withdrawn || []) db.prepare("UPDATE decisions SET withdrawn_at = NULL WHERE id = ?").run(id);
  const by = actor.userLabel || actor.userId || null;
  for (const mc of (d.models || []).slice().reverse()) {
    db.prepare(`UPDATE models SET ${Object.keys(mc.before).map(k => k + " = ?").join(", ")}, updated_at = ?, updated_by = ? WHERE uuid = ?`).run(...Object.values(mc.before), now, by, mc.uuid);
  }
  if (d.tagsModel) {
    for (const t of d.tags || []) db.prepare("DELETE FROM model_tags WHERE model_id = ? AND tag_id = ?").run(d.tagsModel, t);
    for (const c of d.collections || []) db.prepare("DELETE FROM collection_models WHERE model_id = ? AND collection_id = ?").run(d.tagsModel, c);
  }
  if (d.createdModel) db.prepare("UPDATE models SET merged_into = ?, updated_at = ?, updated_by = ? WHERE uuid = ?").run(d.retireInto, now, by, d.createdModel);
  // Each placed file's last-known membership goes back where it was, so the
  // grouping that follows re-finds its earlier Model instead of a new one.
  for (const p of (d.placed || []).slice().reverse()) {
    db.prepare("DELETE FROM model_anchors WHERE content_key = ? AND model_id = (SELECT id FROM models WHERE uuid = ?)").run(p.key, p.to);
    if (p.was) db.prepare("INSERT OR REPLACE INTO model_anchors (model_id, content_key, last_seen) SELECT id, ?, ? FROM models WHERE uuid = ?").run(p.key, now, p.was);
  }
  for (const r of d.reviews || []) {
    db.prepare("UPDATE review_items SET status = ?, resolution_decision_id = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
      .run(r.status, r.resolution_decision_id, r.resolution_note, r.resolved_by, r.resolved_at, now, r.id);
  }
  if ((d.printerKeys || []).length) refreshPrinters(db, d.printerKeys);
  db.prepare("UPDATE actions SET undone_at = ?, undone_by = ? WHERE id = ?").run(now, by, a.id);
  return { actionId: a.id, kind: a.kind, undone: true, model: a.kind === "split" ? (d.retireInto || a.model_uuid) : (a.model_uuid || null), summary: d.summary || {} };
}

// A Model's history, newest first, with whether each change can still be undone.
function history(db, uuid, { limit = 30 } = {}) {
  return db.prepare("SELECT * FROM actions WHERE model_uuid = ? OR other_model_uuid = ? ORDER BY id DESC LIMIT ?").all(uuid, uuid, limit).map(a => {
    const d = JSON.parse(a.detail_json || "{}");
    let undoable = !a.undone_at;
    if (undoable) for (const id of d.created || []) { const dec = db.prepare("SELECT superseded_by, withdrawn_at FROM decisions WHERE id = ?").get(id); if (dec && (dec.superseded_by || dec.withdrawn_at)) undoable = false; }
    if (undoable) for (const mc of d.models || []) { const row = db.prepare("SELECT * FROM models WHERE uuid = ?").get(mc.uuid); if (!row || Object.keys(mc.after).some(k => row[k] !== mc.after[k])) undoable = false; }
    return { id: a.id, kind: a.kind, at: a.created_at, by: a.user_label || null, undoneAt: a.undone_at || null, undoneBy: a.undone_by || null, undoable, summary: d.summary || {} };
  });
}

module.exports = { apply, undo, history, ActionError, CAPABILITY, coverRef };
