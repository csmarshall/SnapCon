// library/folders.js — folder classification (docs/library-design.md §6.4).
//
// Every folder level of every location is labelled format / printer-family-
// like / designer / unknown, with the method and the Evidence that decided it.
// Uses: navigation, candidate discovery, Diagnostics, weak `location` Evidence
// for grouping (M4). NEVER Evidence for which printer a file targets: a
// printer-looking folder may only help navigation and discovery, raise
// "folder disagrees with file", and appear in Diagnostics.
"use strict";
const PrinterIdentity = require("../public/printer-identity");

const RULE_VERSION = 1;

// File-format and asset-kind folder names: what a folder of a downloaded pack
// holds, not who made it or what it is.
const FORMAT_RE = /^(?:stls?|3mfs?|objs?|steps?|stps?|gcodes?|g-?codes?|bgcodes?|meshes|images?|imgs?|pics?|pictures?|photos?|renders?|previews?|thumbnails?|(?:pre-?)?supported|unsupported|supports?|lychee|chitubox|print[\s_-]*files?|files?|sources?|cad|parts?)$/i;

// Two spellings of the same folder name compare equal: case, spaces and
// punctuation are ignored ("Cinderwin 3D" = "Cinderwin3D"). Nothing fuzzier —
// near-misses ("Cinderwing 3D") are candidate discovery, which is M4's.
const nameKey = s => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// dirs: [{ root_id, rel_path }] for every folder of every location ("/"-joined,
// no leading slash). Returns one classification per input folder.
function classifyFolders(dirs) {
  // Where each folder name occurs: name key -> Set of "root:parent" locations.
  const occurrences = new Map();
  for (const d of dirs) {
    const parts = d.rel_path.split("/");
    const key = nameKey(parts[parts.length - 1]);
    if (!key) continue;
    const parent = d.root_id + ":" + parts.slice(0, -1).join("/");
    if (!occurrences.has(key)) occurrences.set(key, new Map());
    occurrences.get(key).set(parent, d.root_id + ":" + d.rel_path);
  }

  return dirs.map(d => {
    const parts = d.rel_path.split("/");
    const name = parts[parts.length - 1];
    const out = (cls, method, evidence) => ({ root_id: d.root_id, rel_path: d.rel_path, class: cls, method, evidence, rule_version: RULE_VERSION });

    if (FORMAT_RE.test(name.trim())) {
      return out("format", "format_token", [{ signal: "folder_name", value: name, rule: "format-token pattern", strength: "medium" }]);
    }
    const families = PrinterIdentity.familiesLikeName(name);
    if (families.length) {
      return out("printer_family_like", "resolver_family_name", [{
        signal: "folder_name", value: name, families, rule: "matches the printer family names supplied by the resolver",
        strength: "none", note: "navigation only — never Evidence for targets_printer",
      }]);
    }
    const seen = occurrences.get(nameKey(name));
    const elsewhere = seen ? [...seen.entries()].filter(([parent]) => parent !== d.root_id + ":" + parts.slice(0, -1).join("/")).map(([, loc]) => loc) : [];
    if (elsewhere.length) {
      return out("designer", "recurs_under_other_folders", [{
        signal: "folder_name", value: name, rule: "the same folder name appears under other parent folders",
        also_at: elsewhere.slice(0, 8), count: elsewhere.length + 1, strength: "weak",
      }]);
    }
    return out("unknown", "none", [{ signal: "folder_name", value: name, rule: "no rule matched", strength: "none" }]);
  });
}

module.exports = { classifyFolders, nameKey, FORMAT_RE, RULE_VERSION };
