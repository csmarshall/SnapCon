// library/genericNames.js — which object names and title words carry no
// identity, and WHY (docs/library-design.md §4.4 rule 7, §6.3). Explainable,
// not a hidden list: every entry has a reason Diagnostics shows, and the
// usage rule ("appears under unrelated titles") reports the evidence it saw.
//
// A generic name never corroborates grouping. It may still be recorded, so
// Diagnostics can say "ignored: generic".
"use strict";

// Object names a slicer or modeller gives to anything.
const GENERIC_OBJECTS = {
  assembly: "default name for a multi-part object (Bambu/Orca \"Assembly\")",
  object: "default object name", objects: "default object name",
  body: "a part, not a model", part: "a part, not a model", parts: "a part, not a model",
  model: "default name", mesh: "default name", untitled: "default name",
  plate: "a build plate, not a model", shape: "default name", cube: "primitive / default name", group: "default name",
  // Common test and calibration prints (§6.3): thousands of unrelated files
  // carry these names, so two of them are no evidence of each other.
  "3dbenchy": "common test print (3DBenchy)", benchy: "common test print (Benchy)",
  calibration: "calibration print", "calibration cube": "calibration print",
  test: "test print", stand: "a generic accessory name", holder: "a generic accessory name",
};

// Title words that say nothing about which model a file is (§6.3: stand,
// holder, test, benchy, calibration, …) and words that carry no meaning.
const GENERIC_TITLE_WORDS = {
  ...Object.fromEntries(Object.entries(GENERIC_OBJECTS).filter(([k]) => !k.includes(" "))),
  print: "generic word", base: "a part, not a model", head: "a part, not a model", single: "a quantity, not a model",
};
const STOP_WORDS = new Set(["the", "a", "an", "of", "and", "with", "for", "in", "on", "to", "by"]);

// A name is "common" when files with this many different titles use it: it
// identifies nothing then, whatever it says (§4.4 rule 7).
const COMMON_MIN_TITLES = 3;

// Static: generic by the list. Returns null or { term, reason }.
function genericObject(norm) {
  const n = String(norm || "").trim().toLowerCase();
  if (!n) return { term: n, reason: "empty name" };
  if (/^\d+$/.test(n)) return { term: n, reason: "a bare number" };
  if (GENERIC_OBJECTS[n]) return { term: n, reason: GENERIC_OBJECTS[n] };
  const stem = n.replace(/[\s\-_.#]*\d+$/, "").trim();   // "part 3", "object_12"
  if (stem && GENERIC_OBJECTS[stem]) return { term: stem, reason: GENERIC_OBJECTS[stem] + " (numbered)" };
  return null;
}

// Titles that are the same or one contained in the other as whole words
// ("baby butterfly dragon" / "baby butterfly dragon blaze") are RELATED: a
// model's own colourways. Rule 7 is about unrelated titles.
function titleGroups(titles) {
  const ts = [...new Set([...titles].filter(Boolean))].sort();
  const parent = ts.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // Related also when they differ only in spacing/punctuation ("TinyTREX",
  // "Tiny T-REX") or word order ("Flexi Kitty", "Kitty Flexi"). This decides
  // only whether a NAME is common; title Evidence still needs an exact match.
  const contains = (a, b) => b.length >= 4 && (` ${a} `).includes(` ${b} `);
  const compact = t => t.replace(/[^\p{L}\p{N}]/gu, "");
  const bag = t => t.split(/\s+/).sort().join(" ");
  const related = (a, b) => contains(a, b) || contains(b, a) || bag(a) === bag(b) ||
    (compact(a).length >= 4 && compact(b).length >= 4 && (compact(a).includes(compact(b)) || compact(b).includes(compact(a))));
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
    if (related(ts[i], ts[j])) parent[find(j)] = find(i);
  }
  const groups = new Map();
  ts.forEach((t, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  return [...groups.values()];
}

// Usage: object name -> the normalised titles of the files using it. A name
// used under COMMON_MIN_TITLES or more unrelated titles is common.
function commonObjects(usage) {
  const out = new Map();
  for (const [name, titles] of usage) {
    const groups = titleGroups(titles);
    if (groups.length >= COMMON_MIN_TITLES) {
      out.set(name, { term: name, reason: `used by files with ${groups.length} unrelated titles`, titles: groups.map(g => g[0]).slice(0, 8) });
    }
  }
  return out;
}

module.exports = { GENERIC_OBJECTS, GENERIC_TITLE_WORDS, STOP_WORDS, COMMON_MIN_TITLES, genericObject, commonObjects, titleGroups };
