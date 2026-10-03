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
  const rows = db.prepare(`SELECT f.id, f.root_id, f.rel_path, f.name, f.ext, f.role, f.size, f.mtime_ms, f.state, f.content_key, f.quick_fp, f.sha256,
      f.thumb_key, f.meta_json, f.meta_version, f.missing_since, f.first_seen, f.last_seen,
      v.printer_family, v.printer_claim_key, v.printer_decision_id, v.printer_model, v.printer_model_id, v.printer_settings_id,
      v.print_settings_id, v.compatible_printers, v.slicer, v.slicer_version, v.config_block, v.est_seconds, v.weight_g, v.copies,
      v.color_count, v.layer_height, v.nozzle
    FROM files f LEFT JOIN variants v ON v.file_id = f.id AND v.plate_no IS NULL WHERE ${where.join(" AND ")} ORDER BY f.root_id, f.rel_path LIMIT ?`).all(...args, limit);

  const claimsBy = new Map();
  const claimStmt = db.prepare("SELECT claim_key, subject_key, relation, object_key, method, confidence, state, groups, evidence_json, rule_version FROM claims WHERE subject_key = ?");
  for (const ck of new Set(rows.map(r => r.content_key))) claimsBy.set(ck, claimStmt.all(ck));

  const folders = db.prepare("SELECT root_id, rel_path, class, method, evidence_json, rule_version FROM folder_classes ORDER BY root_id, rel_path").all()
    .map(f => ({ ...f, evidence: JSON.parse(f.evidence_json || "[]"), evidence_json: undefined }));
  const folderAt = new Map(folders.map(f => [f.root_id + ":" + f.rel_path, f]));
  const objStmt = db.prepare("SELECT name_norm, raw_name, copies, origin, generic FROM file_objects WHERE file_id = ? ORDER BY origin, name_norm");
  const roots = db.prepare("SELECT id, name, path, grouping, status, last_scan_at, last_ok_at, last_error FROM roots").all();
  const projStmt = db.prepare("SELECT * FROM projects WHERE file_id = ?");
  const plateStmt = db.prepare("SELECT plate_no, name, sliced, objects_json, thumb_key, gcode_md5 FROM plates WHERE project_id = ? ORDER BY plate_no");
  const variantStmt = db.prepare("SELECT * FROM variants WHERE file_id = ? AND plate_no IS NOT NULL ORDER BY plate_no");
  const entryStmt = db.prepare("SELECT entry_path, name, role, size, thumb_key, state FROM files WHERE container_id = ? ORDER BY entry_path");
  const lineageStmt = db.prepare("SELECT relation, subject_key, object_key, method, confidence, state, groups, evidence_json FROM claims WHERE relation IN ('sliced_from', 'source_of') AND (subject_key = ? OR object_key = ?)");
  const keyLocs = db.prepare("SELECT root_id || ':' || rel_path AS loc FROM files WHERE content_key = ? AND entry_path = '' ORDER BY id");
  const whereIs = key => keyLocs.all(key).map(r => r.loc);
  const claimView = c => { const ev = JSON.parse(c.evidence_json || "[]"); return { family: c.object_key, label: labelOf(c.object_key), confidence: c.confidence, state: c.state, method: c.method, groups: c.groups, claimKey: c.claim_key, evidence: ev, missing: missingRequirement(c, ev), applied: c.state === "applied" }; };
  const plateClaims = db.prepare("SELECT * FROM claims WHERE subject_type = 'variant' AND subject_key = ? AND relation = 'targets_printer' ORDER BY CASE state WHEN 'applied' THEN 0 ELSE 1 END");

  const files = rows.map(r => {
    const claims = (claimsBy.get(r.content_key) || []).map(c => ({ ...c, evidence: JSON.parse(c.evidence_json || "[]"), evidence_json: undefined }));
    const tp = claims.filter(c => c.relation === "targets_printer").sort((a, b) => (a.state === "applied" ? -1 : 0) - (b.state === "applied" ? -1 : 0) || RANK[a.confidence] - RANK[b.confidence]);
    const top = tp[0] || null;
    const meta = r.meta_json ? JSON.parse(r.meta_json) : null;
    let printer;
    if (r.printer_decision_id) printer = { family: r.printer_family, label: labelOf(r.printer_family), confidence: "authoritative", state: "decision", method: "decision", evidence: [], missing: null };
    else if (top) printer = { family: top.object_key, label: labelOf(top.object_key), confidence: top.confidence, state: top.state, method: top.method, groups: top.groups, claimKey: top.claim_key, evidence: top.evidence, missing: missingRequirement(top, top.evidence), applied: top.state === "applied" };
    else if (r.role === "sliced" && r.meta_version > 0 && r.ext !== "3mf") {   // a 3MF: per plate, below
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

    // A 3MF: what it says (Project, Plates, Variants) and what SnapCon
    // inferred from it (printer Claims per sliced plate, lineage).
    let threemf = null;
    const pr = r.ext === "3mf" ? projStmt.get(r.id) : null;
    if (pr) {
      const m3 = (meta && meta.threemf) || {};
      const variants = new Map(variantStmt.all(r.id).map(v => [v.plate_no, v]));
      const plates = plateStmt.all(pr.id).map(pl => {
        const v = variants.get(pl.plate_no);
        const cl = v ? plateClaims.all(r.content_key + "#" + pl.plate_no) : [];
        let objects = {};
        try { objects = JSON.parse(pl.objects_json || "{}"); } catch {}
        return { plate: pl.plate_no, name: pl.name, printable: !!pl.sliced, gcodeMd5: pl.gcode_md5, thumb: pl.thumb_key,
          objects: objects.objects || [], slicedObjects: objects.slicedObjects || [],
          variant: v ? { estSeconds: v.est_seconds, weightG: v.weight_g, copies: v.copies, colors: v.color_count, nozzle: v.nozzle,
            filaments: JSON.parse(v.filaments_json || "[]"), printerModelId: v.printer_model_id,
            printer: v.printer_decision_id ? { family: v.printer_family, label: labelOf(v.printer_family), state: "decision", confidence: "authoritative" } : cl[0] ? claimView(cl[0]) : { family: null, state: "unknown" } } : null };
      });
      const lineage = lineageStmt.all(r.content_key, r.content_key).map(c => {
        const ev = JSON.parse(c.evidence_json || "[]");
        const out = c.object_key === r.content_key;   // this file is the object: something points at it
        return { relation: c.relation, direction: out ? "in" : "out", other: whereIs(out ? c.subject_key : c.object_key), method: c.method, confidence: c.confidence, state: c.state, evidence: ev };
      });
      let configuredPrinter = null;
      if (pr.printer_model || pr.printer_settings_id) {
        const id = PrinterIdentity.identifyFile({ printerModel: pr.printer_model, printerSettingsId: pr.printer_settings_id, printCompatiblePrinters: (m3.profile && (m3.profile.compatible_printers || []).join(";")) || null, printerModelId: pr.printer_model_id });
        configuredPrinter = { family: id.family, label: id.label, printerModel: pr.printer_model, resolverConfidence: id.confidence, note: "the printer the project is set up for (its own settings); not a Claim on a printable Variant" };
      }
      threemf = {
        flavour: pr.flavour, flavourMethod: m3.flavour && m3.flavour.method, flavourEvidence: m3.flavour && m3.flavour.evidence,
        producer: pr.producer, producerVersion: pr.producer_version, clientVersion: m3.clientVersion || null,
        title: pr.title, designer: pr.designer, license: pr.license, origin: pr.origin,
        externalIds: { DesignModelId: pr.design_model_id, DesignProfileId: pr.design_profile_id, DesignRegion: m3.project && m3.project.designRegion, DesignerUserId: m3.project && m3.project.designerUserId, ProfileUserId: m3.project && m3.project.profileUserId },
        profileTitle: pr.profile_title, profileUserName: m3.project && m3.project.profileUserName,
        printerProfile: { printer_model: pr.printer_model, printer_settings_id: pr.printer_settings_id, print_settings_id: pr.print_settings_id, layer_height: pr.layer_height, nozzle: pr.nozzle },
        configuredPrinter,
        filaments: m3.profile ? { settings: m3.profile.filament_settings_id, types: m3.profile.filament_type, colours: m3.profile.filament_colour, vendors: m3.profile.filament_vendor } : null,
        plateCount: pr.plate_count, slicedPlateCount: pr.sliced_plate_count, plates,
        sourceFiles: m3.sourceFiles || [], meshNames: m3.meshNames || [],
        entries: entryStmt.all(r.id).map(e => ({ entry: e.entry_path, role: e.role, size: e.size, thumb: e.thumb_key, state: e.state })),
        lineage, zip64: !!m3.zip64, entryCount: m3.entryCount, read: m3.read || null, problems: m3.problems || [],
      };
      if (!printer) {
        const firstSliced = plates.find(p => p.variant);
        printer = firstSliced ? { ...firstSliced.variant.printer, plate: firstSliced.plate }
          : { family: null, label: null, confidence: null, state: "not printable", method: null, evidence: [],
              missing: "an unsliced project: no printable plate, so no printer Claim" + (configuredPrinter && configuredPrinter.label ? `; it is set up for ${configuredPrinter.label}` : "") };
      }
    }
    // Lineage of a plain G-code file (it may have been sliced from a project).
    // Identical files share a content key, so a sliced_from Claim (whose
    // subject is the G-code) belongs to the location recorded in it; for
    // source_of the recorded location is the other end, the derived file.
    const gLineage = !pr ? lineageStmt.all(r.content_key, r.content_key).filter(c => {
      if (c.object_key === r.content_key || c.relation !== "sliced_from") return true;
      const ev = JSON.parse(c.evidence_json || "[]");
      return !ev[0] || !ev[0].at || ev[0].at === here;
    })
      .map(c => ({ relation: c.relation, direction: c.object_key === r.content_key ? "in" : "out", other: whereIs(c.object_key === r.content_key ? c.subject_key : c.object_key), method: c.method, confidence: c.confidence, state: c.state, evidence: JSON.parse(c.evidence_json || "[]") })) : [];
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
      threemf, lineage: threemf ? threemf.lineage : gLineage,
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
      threemf: {
        files: files.filter(f => f.threemf).length,
        byFlavour: count(files.filter(f => f.threemf), f => f.threemf.flavour),
        printable: files.filter(f => f.threemf && f.threemf.slicedPlateCount > 0).length,
        plates: files.reduce((n, f) => n + (f.threemf ? f.threemf.plateCount : 0), 0),
        printablePlates: files.reduce((n, f) => n + (f.threemf ? f.threemf.slicedPlateCount : 0), 0),
        withMakerWorldIds: files.filter(f => f.threemf && f.threemf.externalIds.DesignModelId).length,
        entryFiles: files.reduce((n, f) => n + (f.threemf ? f.threemf.entries.length : 0), 0),
        bytesRead: files.reduce((n, f) => n + (f.threemf && f.threemf.read ? f.threemf.read.bytes : 0), 0),
        bytesTotal: files.reduce((n, f) => n + (f.threemf ? f.size : 0), 0),
      },
      lineage: count(files.flatMap(f => (f.lineage || []).filter(l => l.direction === "out").map(l => l.relation + " · " + l.method + " · " + l.state)), x => x),
    },
    folders,
    files,
  };
}

module.exports = { diagnosticsRaw, missingRequirement };
