// library/titles.js — filename/title normalisation (docs/library-design.md §6.3).
//
// Two uses, never mixed:
//   1. candidate discovery — normalise aggressively, only to find pairs worth
//      comparing;
//   2. Evidence — compareTitles() turns a pair into an Evidence item whose
//      strength follows the conservative table below. Stripping words never
//      makes two files the same model by itself.
//
// Every transformation is recorded (rule + what it removed), so Diagnostics
// can show original → normalised and why.
"use strict";
const { GENERIC_TITLE_WORDS, STOP_WORDS } = require("./genericNames");

const RULE_VERSION = 1;

const TIME = /^(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?$/i;          // 5h41m, 1d2h, 51m47s
const TIME_LOOSE = /^\d+(?:d|h|m|s|dh)\d*(?:h|m|s)?\d*[ms]?\.?$/i; // 16h31, 1dh14h, 15h15m.
const WEIGHT = /^\d+(?:\.\d+)?\s*(?:g|kg)$/i;                      // 120g, 553G
const MONEY = /^(?:\$\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*\$)$/;        // 9.82$, $14.27
const NUMBER = /^\d+(?:[.,]\d+)?$/;
const TEMP = /^@\s*\d{3}$/;                                        // @190
const COLOUR_CODE = /^[A-Z]{1,4}-?\d+g?$/;                          // W74, BL308, ONG 174g → handled as pairs too
const FILAMENTS = ["pla", "pla+", "petg", "tpu", "abs", "asa", "pc", "pa", "nylon", "silk", "matte", "hs", "hf"];
const COLOURS = ["red", "orange", "yellow", "green", "blue", "purple", "violet", "pink", "white", "black", "grey", "gray", "brown",
  "gold", "silver", "beige", "teal", "cyan", "magenta", "rainbow", "transparent", "clear", "darkgreen", "darkblue", "lightblue", "skin"];
const FORMAT_WORDS = ["stl", "stls", "3mf", "obj", "step", "stp", "gcode", "g-code"];

const isStat = t => TIME.test(t) && /\d/.test(t) || TIME_LOOSE.test(t) || WEIGHT.test(t) || MONEY.test(t) || NUMBER.test(t);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// name: the file name, or a 3MF's project title. ctx: { designers: [names] }.
function normalizeTitle(name, ctx = {}) {
  const transformations = [];
  const record = (rule, removed) => { if (removed && String(removed).trim()) transformations.push({ rule, removed: String(removed).trim() }); };
  let s = String(name || "");
  // Extensions (".gcode.3mf" counts as one).
  const ext = /(\.gcode)?\.(gcode|gco|g|gx|bgcode|3mf|stl|obj|step|stp|amf|ply|png|jpe?g|webp|pdf|zip)$/i.exec(s);
  if (ext) { s = s.slice(0, ext.index); record("extension", ext[0]); }
  const original = s;

  // Bracketed tags: "[CP] TinyTREX".
  s = s.replace(/\[[^\]]{1,12}\]/g, m => { record("tag", m); return " "; });
  // Orca/Snapmaker material + time tails: "_PLA_3h55m", "_PLA_15h12m", "_TPU_2h46m".
  s = s.replace(/[_\s]+([A-Za-z+]{2,5})_(\d+[dhms][\dhms]*)$/i, (m, mat, t) => (FILAMENTS.includes(mat.toLowerCase()) ? (record("material_time", m), "") : m));
  // Parentheticals, innermost first: stats removed token by token; a group
  // left holding only colour words goes too (a trailing colour parenthetical).
  // A kept group is marked (not re-parenthesised), so an enclosing group is
  // processed next: "(3 Colors (Macaron), 25h47m)".
  const OPEN = "\u0001", CLOSE = "\u0002";
  for (let guard = 0; guard < 8 && /\([^()]*\)/.test(s); guard++) {
    s = s.replace(/\(([^()]*)\)/g, (m, inner) => {
      const parts = inner.split(/[,;]/).map(p => p.trim()).filter(Boolean);
      const keep = [];
      for (const part of parts) {
        const toks = part.split(/\s+/);
        const statLike = toks.every(t => isStat(t) || TEMP.test(t) || /^@$/.test(t) || COLOUR_CODE.test(t) || /^(?:PLA|PETG|TPU)_?\d/i.test(t)) ||
          /^@\s*\d{3}$/.test(part) || /^[A-Z]{1,4}\s*-?\s*\d+\s*g$/i.test(part) || /^(?:[A-Z]{1,3}\d+-?)+[A-Z]{0,3}\d*$/.test(part.replace(/\s/g, "")) ||
          /^(?:pla|petg|tpu)[_\s]+\d+[dhms]/i.test(part);
        if (statLike) record("print_stats", part); else keep.push(part);
      }
      if (keep.length && keep.every(p => p.split(/[\s\-]+/).every(w => COLOURS.includes(w.toLowerCase())))) { record("colour", keep.join(", ")); return " "; }
      return keep.length ? " " + OPEN + keep.join(", ") + CLOSE + " " : " ";
    });
  }
  s = s.split(OPEN).join(" ").split(CLOSE).join(" ").replace(/[()]/g, " ");
  // Trailing colour/part weight lists outside parentheses: "WHT 418g, GRD 156g, BLK 2g".
  s = s.replace(/\s+((?:[A-Z]{1,4}\s*\d+\s*g\s*,?\s*){2,})$/i, (m) => { record("colour_weights", m); return ""; });
  // Trailing hyphen-joined colour list: "- Green-White-Red-DarkGreen".
  s = s.replace(/\s+-\s+([A-Za-z]+(?:-[A-Za-z]+){2,})\s*$/, (m, list) => (list.split("-").every(w => COLOURS.includes(w.toLowerCase()) || w.toLowerCase() === "blank") ? (record("colour_list", m), "") : m));
  // Print temperature: "@ 190", "@190".
  s = s.replace(/@\s*\d{3}\b/g, m => { record("temperature", m); return " "; });
  // Copy counts: "4x ", "22x", "4xx", "x24", trailing " x3".
  s = s.replace(/^\s*(\d{1,3})\s*x{1,2}\b\s*/i, m => { record("copy_count", m); return ""; });
  s = s.replace(/\bx\s?(\d{1,3})\b/gi, m => { record("copy_count", m); return " "; });
  s = s.replace(/\b(\d{1,3})x\b/gi, m => { record("copy_count", m); return " "; });
  // "Plate 3", "Plate_10".
  s = s.replace(/\bplate[\s_]*\d+\b/gi, m => { record("plate", m); return " "; });
  // Remaining stray time tokens ("Rose Dragon(20h16m)" was handled; "_9h22m").
  s = s.replace(/[_\s](\d+[dh]\d*[hms]?\d*[ms]?)(?=$|[_\s])/gi, (m, t) => (isStat(t) ? (record("print_stats", t), " ") : m));

  // Words: separators to spaces, then word-level removals.
  let words = s.replace(/[_.]+/g, " ").replace(/\s+-\s+/g, " ").replace(/[,;:!?'"]/g, " ").split(/\s+/).filter(Boolean);
  const lower = words.map(w => w.toLowerCase());
  // Known designer names, as whole word runs at the start or end ("Flexi Factory Skeleton…").
  for (const d of (ctx.designers || []).map(x => String(x).toLowerCase().split(/[\s_\-]+/).filter(Boolean)).filter(x => x.length).sort((a, b) => b.length - a.length)) {
    const n = d.length;
    if (lower.length > n && lower.slice(0, n).join(" ") === d.join(" ")) { record("designer", words.slice(0, n).join(" ")); words = words.slice(n); lower.splice(0, n); }
    else if (lower.length > n && lower.slice(-n).join(" ") === d.join(" ")) { record("designer", words.slice(-n).join(" ")); words = words.slice(0, -n); lower.splice(-n); }
  }
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = lower[i];
    if (FILAMENTS.includes(w)) { record("filament", words[i]); continue; }
    if (FORMAT_WORDS.includes(w)) { record("format_token", words[i]); continue; }
    if (isStat(w) && !/^\d{1,2}$/.test(w)) { record("print_stats", words[i]); continue; }
    out.push(w.replace(/[()]/g, ""));
  }
  const normalized = out.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const tokens = normalized ? normalized.split(" ") : [];
  const meaningful = tokens.filter(t => !STOP_WORDS.has(t));
  const genericTokens = meaningful.filter(t => GENERIC_TITLE_WORDS[t]);
  const genericScore = meaningful.length ? +(genericTokens.length / meaningful.length).toFixed(2) : 1;
  return {
    original, normalized, transformations, tokenCount: meaningful.length, genericScore,
    generic: genericScore >= 0.5 ? genericTokens.map(t => ({ term: t, reason: GENERIC_TITLE_WORDS[t] })) : [],
    ruleVersion: RULE_VERSION,
  };
}

// The Evidence a pair of titles gives (§6.3):
//   exact normalised, ≥ 2 meaningful tokens, not generic        medium
//   exact normalised, one word of ≥ 4 characters, not generic   medium  (§7: "Beardie")
//   whole-word containment                                       weak
//   generic (generic_score ≥ 0.5)                                weak at most
//   anything else, or names under 4 characters                   none
function compareTitles(a, b) {
  const compare = { original_a: a.original, original_b: b.original, normalized_a: a.normalized, normalized_b: b.normalized,
    transformations_a: a.transformations, transformations_b: b.transformations, method: null, score: 0, result: "none" };
  const done = (method, score, strength, note) => ({ strength, compare: { ...compare, method, score, result: strength, ...(note ? { note } : {}) } });
  if (!a.normalized || !b.normalized) return done("empty", 0, "none", "nothing left of a title after normalisation");
  const generic = Math.max(a.genericScore, b.genericScore) >= 0.5;
  if (a.normalized === b.normalized) {
    const tooShort = a.tokenCount < 2 && a.normalized.replace(/\s/g, "").length < 4;
    if (tooShort) return done("exact", 1, "none", "names under 4 characters are never evidence");
    if (generic) return done("exact", 1, "weak", "generic title: at most weak");
    return done("exact", 1, "medium", a.tokenCount >= 2 ? null : "one-word title: exact match only");
  }
  const wa = a.normalized.split(" "), wb = b.normalized.split(" ");
  const [shortW, longW] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const shortText = shortW.join(" ");
  if (shortText.length >= 4 && new RegExp(`(^| )${escapeRe(shortText)}( |$)`).test(longW.join(" "))) {
    return done("containment", +(shortW.length / longW.length).toFixed(2), "weak", generic ? "generic title" : null);
  }
  return done("different", 0, "none");
}

module.exports = { normalizeTitle, compareTitles, RULE_VERSION };
