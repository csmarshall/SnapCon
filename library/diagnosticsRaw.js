// library/diagnosticsRaw.js — the M2 raw diagnostic view (read-only):
// every indexed File → its printer family → confidence and state → the
// Evidence behind it → the classification of each folder above it, and its
// status. The full Diagnostics of §13.1 (Models, Suggestions, Ambiguous…) is
// M4; this is what checkpoint 1 is judged on.
"use strict";
const PrinterIdentity = require("../public/printer-identity");

const labelOf = fam => (PrinterIdentity.FAMILIES.find(f => f.key === fam) || {}).label || null;
const RANK = { exact: 0, high: 1, medium: 2, low: 3 };

// What the targets_printer policy (§4.4) still needs before it would apply a
// Claim automatically. Shown for everything that is not applied.
function missingRequirement(claim, ev) {
  if (!claim) return null;
  if (claim.state === "applied") return null;
  if (claim.state === "overridden") return "rejected by a person";
  const pm = ev.find(e => e.signal === "printer_model");
  if (claim.method === "resolver:settings_id") {
    return pm && pm.generic
      ? `printer_model is generic ("${pm.value}"), so only the settings fields name the printer — a single group of internal Evidence at medium. Auto-apply needs a printer_model that names the machine and agrees, or a Bambu model id.`
      : "only the settings fields name the printer, and nothing names the machine itself.";
  }
  if (claim.method === "resolver:printer_model_contradicted") return "printer_model names this family, but a settings field names another — the file's own fields disagree.";
  if (claim.state === "recorded") return "the file's fields disagree about the family, so nothing is suggested.";
  return "not enough independent Evidence.";
}

function diagnosticsRaw(db, { root = null, q = null, limit = 5000 } = {}) {
  const where = ["f.entry_path = ''"], args = [];
  if (root) { where.push("f.root_id = ?"); args.push(root); }
  if (q) { where.push("f.rel_path LIKE ? ESCAPE '\\'"); args.push("%" + String(q).replace(/[\\%_]/g, m => "\\" + m) + "%"); }
  const rows = db.prepare(`SELECT f.id, f.root_id, f.rel_path, f.name, f.role, f.size, f.mtime_ms, f.state, f.content_key, f.quick_fp, f.sha256,
      f.thumb_key, f.meta_json, f.meta_version, f.missing_since, f.first_seen, f.last_seen,
      v.printer_family, v.printer_claim_key, v.printer_decision_id, v.printer_model, v.printer_model_id, v.printer_settings_id,
      v.print_settings_id, v.compatible_printers, v.slicer, v.slicer_version, v.config_block, v.est_seconds, v.weight_g, v.copies,
      v.color_count, v.layer_height, v.nozzle
    FROM files f LEFT JOIN variants v ON v.file_id = f.id WHERE ${where.join(" AND ")} ORDER BY f.root_id, f.rel_path LIMIT ?`).all(...args, limit);

  const claimsBy = new Map();
  const claimStmt = db.prepare("SELECT claim_key, subject_key, relation, object_key, method, confidence, state, groups, evidence_json, rule_version FROM claims WHERE subject_key = ?");
  for (const ck of new Set(rows.map(r => r.content_key))) claimsBy.set(ck, claimStmt.all(ck));

  const folders = db.prepare("SELECT root_id, rel_path, class, method, evidence_json, rule_version FROM folder_classes ORDER BY root_id, rel_path").all()
    .map(f => ({ ...f, evidence: JSON.parse(f.evidence_json || "[]"), evidence_json: undefined }));
  const folderAt = new Map(folders.map(f => [f.root_id + ":" + f.rel_path, f]));
  const objStmt = db.prepare("SELECT name_norm, raw_name, copies, origin, generic FROM file_objects WHERE file_id = ? ORDER BY origin, name_norm");
  const roots = db.prepare("SELECT id, name, path, grouping, status, last_scan_at, last_ok_at, last_error FROM roots").all();

  const files = rows.map(r => {
    const claims = (claimsBy.get(r.content_key) || []).map(c => ({ ...c, evidence: JSON.parse(c.evidence_json || "[]"), evidence_json: undefined }));
    const tp = claims.filter(c => c.relation === "targets_printer").sort((a, b) => (a.state === "applied" ? -1 : 0) - (b.state === "applied" ? -1 : 0) || RANK[a.confidence] - RANK[b.confidence]);
    const top = tp[0] || null;
    const meta = r.meta_json ? JSON.parse(r.meta_json) : null;
    let printer;
    if (r.printer_decision_id) printer = { family: r.printer_family, label: labelOf(r.printer_family), confidence: "authoritative", state: "decision", method: "decision", evidence: [], missing: null };
    else if (top) printer = { family: top.object_key, label: labelOf(top.object_key), confidence: top.confidence, state: top.state, method: top.method, groups: top.groups, claimKey: top.claim_key, evidence: top.evidence, missing: missingRequirement(top, top.evidence), applied: top.state === "applied" };
    else if (r.role === "sliced" && r.meta_version > 0) {
      const id = PrinterIdentity.identifyFile({ printerModel: r.printer_model, printerSettingsId: r.printer_settings_id, printCompatiblePrinters: r.compatible_printers, printerModelId: r.printer_model_id });
      printer = { family: null, label: null, confidence: null, state: "unknown", method: null, evidence: id.evidence,
        missing: id.hasData ? `the file's printer fields name no known printer family (printer_model "${r.printer_model || ""}", settings "${r.printer_settings_id || ""}")${id.brand ? "; brand " + id.brand : ""}` : "the file carries no printer fields" };
    } else printer = null;
    const others = tp.slice(1).map(c => ({ family: c.object_key, confidence: c.confidence, state: c.state, method: c.method }));

    // Each folder above the file, with its class.
    const parts = r.rel_path.split("/");
    const chain = [];
    for (let i = 1; i < parts.length; i++) {
      const rel = parts.slice(0, i).join("/");
      const fc = folderAt.get(r.root_id + ":" + rel);
      chain.push({ path: rel, class: fc ? fc.class : "unclassified", method: fc ? fc.method : null, families: fc && fc.evidence[0] && fc.evidence[0].families || undefined });
    }
    // A printer-looking folder that disagrees with the file's own Evidence.
    // Informational only: the folder never decides the printer.
    let folderDisagrees = null;
    const fam = printer && printer.family;
    for (const c of chain.filter(x => x.class === "printer_family_like")) {
      if (fam && !(c.families || []).includes(fam)) { folderDisagrees = { folder: c.path, folderFamilies: c.families, fileFamily: fam, fileConfidence: printer.confidence }; break; }
    }
    // A moved_from Claim is keyed by content, which identical files share; it
    // belongs to the location the file moved to.
    const here = r.root_id + ":" + r.rel_path;
    const moved = claims.filter(c => c.relation === "moved_from" && (c.evidence[0] || {}).at === here).map(c => ({ from: c.object_key, confidence: c.confidence }));
    return {
      root: r.root_id, path: r.rel_path, name: r.name, role: r.role, state: r.state, size: r.size, missingSince: r.missing_since,
      contentKey: r.content_key, fullHash: !!r.sha256, quickFp: r.quick_fp, thumb: r.thumb_key,
      slicer: r.slicer ? (r.slicer + (r.slicer_version ? " " + r.slicer_version : "")) : null,
      profile: r.printer_model || r.printer_settings_id ? { printer_model: r.printer_model, printer_settings_id: r.printer_settings_id, print_settings_id: r.print_settings_id, compatible_printers: r.compatible_printers, printer_model_id: r.printer_model_id } : null,
      configBlock: r.config_block == null ? null : !!r.config_block,
      estSeconds: r.est_seconds, weightG: r.weight_g, copies: r.copies, colors: r.color_count, layerHeight: r.layer_height, nozzle: r.nozzle,
      printer, otherPrinterClaims: others, folders: chain, folderDisagrees, moved,
      objects: r.role === "sliced" ? objStmt.all(r.id).map(o => ({ name: o.name_norm, raw: o.raw_name, copies: o.copies, origin: o.origin, generic: !!o.generic })) : undefined,
      window: meta && meta.gcode ? meta.gcode.window : null, error: meta && meta.error || null,
    };
  });

  const count = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const sliced = files.filter(f => f.role === "sliced");
  return {
    generatedAt: Date.now(),
    roots,
    summary: {
      files: files.length,
      byRoot: count(files, f => f.root),
      byRole: count(files, f => f.role),
      byState: count(files, f => f.state),
      fullHashed: files.filter(f => f.fullHash).length,
      withThumbnail: files.filter(f => f.thumb).length,
      printer: {
        byFamily: count(sliced, f => (f.printer && f.printer.family) || "(unknown)"),
        byConfidenceState: count(sliced, f => f.printer ? `${f.printer.confidence || "-"} / ${f.printer.state}` : "(not read)"),
        unknown: sliced.filter(f => f.printer && f.printer.state === "unknown").map(f => ({ root: f.root, path: f.path, why: f.printer.missing })),
        notApplied: sliced.filter(f => f.printer && f.printer.state !== "applied" && f.printer.state !== "unknown" && f.printer.state !== "decision").map(f => ({ root: f.root, path: f.path, family: f.printer.family, confidence: f.printer.confidence, state: f.printer.state, missing: f.printer.missing })),
        conflicts: sliced.filter(f => f.otherPrinterClaims.length).map(f => ({ root: f.root, path: f.path, claims: [f.printer, ...f.otherPrinterClaims].map(c => c.family + ":" + c.state) })),
      },
      folderClasses: count(folders, f => f.class),
      folderDisagrees: files.filter(f => f.folderDisagrees).map(f => ({ root: f.root, path: f.path, ...f.folderDisagrees })),
      windowExpansions: files.filter(f => f.window && (f.window.grew && f.window.grew.length || f.window.streamed)).map(f => ({ root: f.root, path: f.path, ...f.window })),
      moved: files.filter(f => f.moved.length).map(f => ({ root: f.root, path: f.path, from: f.moved.map(m => m.from) })),
      errors: files.filter(f => f.error || f.state === "unreadable").map(f => ({ root: f.root, path: f.path, error: f.error })),
    },
    folders,
    files,
  };
}

module.exports = { diagnosticsRaw, missingRequirement };
