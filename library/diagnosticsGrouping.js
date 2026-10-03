// library/diagnosticsGrouping.js — the M4 Library Diagnostics (§13.1): every
// Model with its Files, Projects, Plates, Variants, printers, Claims,
// Decisions and Evidence; the suggestions and what each lacks; the protected
// and ambiguous cases; duplicates; the other Review Items. Read-only.
//
// The export is the same object, sorted, with the rule versions, so two runs
// (or two rule revisions) can be compared: Models are listed with their
// member locations, which survive rebuilds.
"use strict";
const fs = require("fs");
const PrinterIdentity = require("../public/printer-identity");

const labelOf = fam => (PrinterIdentity.FAMILIES.find(f => f.key === fam) || {}).label || fam || null;
const loc = f => f.root_id + ":" + f.rel_path;
const json = s => { try { return JSON.parse(s || "null"); } catch { return null; } };

function diagnosticsGrouping(db, { reportPath, includeEmpty = true } = {}) {
  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); } catch { /* no run yet */ }
  const roots = db.prepare("SELECT id, name, grouping, status FROM roots ORDER BY id").all();
  const files = db.prepare(`SELECT f.*, ft.original AS t_original, ft.normalized AS t_normalized, ft.transformations_json AS t_transformations, ft.generic_score AS t_generic
    FROM files f LEFT JOIN file_titles ft ON ft.file_id = f.id ORDER BY f.root_id, f.rel_path, f.entry_path`).all();
  const claimByKey = new Map(db.prepare("SELECT * FROM claims WHERE relation IN ('member_of', 'targets_printer', 'sliced_from', 'source_of', 'duplicate_of', 'same_model_as')").all().map(c => [c.claim_key, c]));
  // Lineage by file: subject and object keys can be "ck#plate".
  const claimsBySubject = new Map(), lineageOut = new Map(), lineageIn = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  const baseKey = k => String(k).split("#")[0];
  for (const c of claimByKey.values()) {
    push(claimsBySubject, c.subject_key, c);
    if (c.relation === "sliced_from" || c.relation === "source_of") { push(lineageOut, baseKey(c.subject_key), c); push(lineageIn, baseKey(c.object_key), c); }
  }
  const variantsByFile = new Map();
  for (const v of db.prepare("SELECT * FROM variants ORDER BY file_id, plate_no").all()) { if (!variantsByFile.has(v.file_id)) variantsByFile.set(v.file_id, []); variantsByFile.get(v.file_id).push(v); }
  const projects = new Map(db.prepare("SELECT * FROM projects").all().map(p => [p.file_id, p]));
  const plates = new Map();
  for (const p of db.prepare("SELECT * FROM plates ORDER BY project_id, plate_no").all()) { if (!plates.has(p.project_id)) plates.set(p.project_id, []); plates.get(p.project_id).push(p); }
  const decisions = db.prepare("SELECT * FROM decisions ORDER BY id").all();
  const models = db.prepare("SELECT * FROM models ORDER BY id").all();
  const reviews = db.prepare("SELECT * FROM review_items ORDER BY kind, subject_key").all();
  const locOfKey = new Map();
  for (const f of files) if (!f.entry_path && !locOfKey.has(f.content_key)) locOfKey.set(f.content_key, loc(f));
  const byModel = new Map();
  for (const f of files) if (f.model_id != null) { if (!byModel.has(f.model_id)) byModel.set(f.model_id, []); byModel.get(f.model_id).push(f); }

  const evidenceView = c => (c ? { method: c.method, confidence: c.confidence, state: c.state, groups: c.groups, evidence: json(c.evidence_json) || [], ruleVersion: c.rule_version } : null);
  const variantView = (f, v) => {
    const key = v.plate_no == null ? f.content_key : f.content_key + "#" + v.plate_no;
    const claims = (claimsBySubject.get(key) || []).filter(c => c.relation === "targets_printer").sort((a, b) => (a.state === "applied" ? -1 : 0) - (b.state === "applied" ? -1 : 0));
    const top = claims[0];
    return { plate: v.plate_no, printer: v.printer_decision_id ? { family: v.printer_family, label: labelOf(v.printer_family), state: "decision", confidence: "authoritative" }
      : top ? { family: top.object_key, label: labelOf(top.object_key), confidence: top.confidence, state: top.state, method: top.method, evidence: json(top.evidence_json) } : { family: null, state: "unknown" },
      slicer: v.slicer, estSeconds: v.est_seconds, weightG: v.weight_g, copies: v.copies, colors: v.color_count };
  };
  const fileView = f => {
    const membership = f.model_claim_key ? evidenceView(claimByKey.get(f.model_claim_key)) : null;
    const pr = projects.get(f.id);
    const lineage = (lineageOut.get(f.content_key) || []).map(c => ({ c, dir: "out", other: c.object_key }))
      .concat((lineageIn.get(f.content_key) || []).map(c => ({ c, dir: "in", other: c.subject_key })))
      .map(({ c, dir, other }) => ({ relation: c.relation, direction: dir, other: (locOfKey.get(baseKey(other)) || other) + (String(other).includes("#") ? " plate " + String(other).split("#")[1] : ""), otherKey: other, method: c.method, confidence: c.confidence, state: c.state, evidence: json(c.evidence_json) }));
    return {
      location: loc(f), entry: f.entry_path || undefined, role: f.role, state: f.state, size: f.size, contentKey: f.content_key,
      title: f.t_original != null ? { original: f.t_original, normalized: f.t_normalized, transformations: json(f.t_transformations) || [], genericScore: f.t_generic } : null,
      why: f.entry_path ? { method: "inside the project", confidence: "exact", evidence: [{ signal: "container", value: "an entry of the 3MF it belongs to" }] }
        : f.model_decision_id ? { method: "decision", confidence: "authoritative", decision: f.model_decision_id, claim: membership }
        : membership || { method: "standalone", confidence: null, evidence: [], note: "no automatic grouping Evidence links it to another file: its own Model" },
      variants: (variantsByFile.get(f.id) || []).map(v => variantView(f, v)),
      project: pr ? { flavour: pr.flavour, title: pr.title, designer: pr.designer, license: pr.license, designModelId: pr.design_model_id, plates: (plates.get(pr.id) || []).length,
        printablePlates: (plates.get(pr.id) || []).filter(p => p.sliced).length } : null,
      lineage,
    };
  };
  const modelViews = models.filter(m => includeEmpty || byModel.has(m.id)).map(m => {
    const fs_ = (byModel.get(m.id) || []).filter(f => !f.entry_path);
    const entries = (byModel.get(m.id) || []).filter(f => f.entry_path);
    const families = new Set();
    for (const f of fs_) for (const v of variantsByFile.get(f.id) || []) if (v.printer_family) families.add(v.printer_family);
    return {
      uuid: m.uuid, name: m.name, nameSource: m.name_source, origin: m.origin, hidden: !!m.hidden, designer: m.designer, license: m.license, designModelId: m.design_model_id,
      files: fs_.map(fileView), entries: entries.map(fileView), printers: [...families].sort().map(labelOf),
      decisions: decisions.filter(d => d.object_key === m.uuid || d.subject_key === m.uuid).map(d => ({ id: d.id, relation: d.relation, polarity: d.polarity, subject: d.subject_key, object: d.object_key, superseded: !!d.superseded_by, hint: d.subject_hint })),
      grouping: fs_.length > 1 ? [...new Set(fs_.map(f => (f.model_claim_key && claimByKey.get(f.model_claim_key) || {}).method).filter(Boolean))] : [],
      empty: fs_.length === 0,
    };
  }).sort((a, b) => (b.files.length - a.files.length) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.uuid < b.uuid ? -1 : 1));

  const reviewViews = reviews.map(r => ({ kind: r.kind, subject: r.subject_key, status: r.status, priority: r.priority, confidence: r.confidence, summary: r.summary,
    location: r.location, otherLocation: r.other_location, modelUuid: r.model_uuid, otherModelUuid: r.other_model_uuid, evidence: json(r.evidence_json), note: r.resolution_note }));
  const count = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const memberClaims = [...claimByKey.values()].filter(c => c.relation === "member_of");
  const modelled = files.filter(f => !f.entry_path && f.model_id != null);
  return {
    ruleVersion: report ? report.ruleVersion : null, titleRuleVersion: report ? report.titleRuleVersion : null, generatedAt: report ? report.generatedAt : null,
    roots,
    summary: {
      files: files.filter(f => !f.entry_path).length, entryFiles: files.filter(f => f.entry_path).length,
      models: modelViews.filter(m => !m.empty).length, emptyModels: modelViews.filter(m => m.empty).length,
      multiFileModels: modelViews.filter(m => m.files.length > 1).length,
      filesInMultiFileModels: modelViews.filter(m => m.files.length > 1).reduce((n, m) => n + m.files.length, 0),
      filesAutomaticallyGrouped: modelled.filter(f => f.model_claim_key).length,
      filesStandalone: modelled.filter(f => !f.model_claim_key && !f.model_decision_id).length,
      filesByDecision: modelled.filter(f => f.model_decision_id).length,
      notModelled: files.filter(f => !f.entry_path && f.model_id == null).length,
      memberOfByMethod: count(memberClaims, c => c.method), memberOfByConfidence: count(memberClaims, c => c.confidence),
      suggestions: report ? report.suggestions.length : 0, suggestionsByMethod: report ? count(report.suggestions, s => s.method) : {},
      ambiguousFiles: report ? report.ambiguousFiles.length : 0, protectedGeneric: report ? report.protectedClusters.length : 0,
      duplicates: report ? report.duplicates.length : 0, unresolvedSources: report ? report.unresolvedSources.length : 0,
      reviewsByKind: count(reviewViews.filter(r => r.status === "open"), r => r.kind), reviewsByStatus: count(reviewViews, r => r.status),
      decisions: { total: decisions.length, active: decisions.filter(d => !d.superseded_by).length, byRelation: count(decisions.filter(d => !d.superseded_by), d => d.relation + " " + d.polarity) },
      lastRun: report ? report.counts : null,
    },
    models: modelViews,
    suggestions: report ? report.suggestions : [],
    ambiguous: report ? { files: report.ambiguousFiles, protected: report.protectedClusters, commonBlocks: report.protectedBlocks, modelFolders: report.modelFolders,
      unresolvedSources: report.unresolvedSources, blocked: report.blocked, recorded: report.recorded } : null,
    duplicates: report ? report.duplicates : [],
    reviews: reviewViews,
    decisions: decisions.map(d => ({ id: d.id, subjectType: d.subject_type, subject: d.subject_key, relation: d.relation, polarity: d.polarity, objectType: d.object_type, object: d.object_key,
      hint: d.subject_hint, reason: d.reason, superseded: !!d.superseded_by, createdAt: d.created_at })),
  };
}

// The export: the same content without what changes from run to run (when
// it ran, how long it took, what that particular run created), so two exports
// of the same index under the same rule versions are byte-identical.
function stableExport(d) {
  const { generatedAt, lastRun, ...rest } = d;
  const { lastRun: _lr, ...summary } = d.summary;
  return { kind: "snapcon-library-grouping", ...rest, summary };
}

module.exports = { diagnosticsGrouping, stableExport };
