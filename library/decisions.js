// library/decisions.js — writing the owner's Decisions (§4.1, §4.5). Authored
// rows: never dropped by a rebuild, keyed only by stable keys (content keys,
// Model uuids), superseded rather than deleted (undo keeps the history).
//
// M4 has no UI for this (Diagnostics is read-only until M6); tests and the
// owner's checkpoint use it directly.
"use strict";

const RELATIONS = new Set(["member_of", "distinct_from", "source_of", "sliced_from", "targets_printer", "printed_as", "hidden"]);

function recordDecision(db, d, now = Date.now()) {
  if (!RELATIONS.has(d.relation)) throw new Error("unknown relation " + d.relation);
  if (!d.subject_type || !d.subject_key) throw new Error("a Decision needs a subject");
  const id = Number(db.prepare(`INSERT INTO decisions (subject_type, subject_key, relation, polarity, object_type, object_key, value_json, subject_hint, reason,
      from_claim_key, evidence_snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.subject_type, d.subject_key, d.relation, d.polarity || "affirm", d.object_type || null, d.object_key || null, d.value_json || null,
      d.subject_hint || null, d.reason || null, d.from_claim_key || null, d.evidence_snapshot_json || null, d.created_by || null, now).lastInsertRowid);
  return id;
}

// Undo: a later Decision supersedes an earlier one; the earlier stays.
function supersede(db, id, byId) {
  db.prepare("UPDATE decisions SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL").run(byId, id);
}

// The location of a content key, for subject_hint ("root:rel_path").
function hintFor(db, contentKey) {
  const f = db.prepare("SELECT root_id, rel_path FROM files WHERE content_key = ? AND entry_path = '' ORDER BY id LIMIT 1").get(contentKey);
  return f ? f.root_id + ":" + f.rel_path : null;
}

module.exports = { recordDecision, supersede, hintFor };
