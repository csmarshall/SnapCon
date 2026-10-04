// library/searchTerms.js — extra word forms for Library search (M6 follow-up
// to M5). Candidate retrieval only: these forms go into the derived search
// index (model_fts.search_terms) and nowhere else. They are never grouping
// Evidence and never change a displayed name.
//
// Word-prefix search alone misses the obvious: "trex" does not find
// "TinyTREX" (one word: "tinytrex") or "T-Rex" ("t" + "rex"). So a name also
// contributes:
//   camelCase split     TinyTREX → tiny trex      FlexiKitty → flexi kitty
//   adjacent joins      T-Rex / T Rex → trex       Baby T Rex → babyt, trex …
// and a query also tries its words joined ("t rex" → trex*).
"use strict";

const MAX_FORMS = 400;   // a Model with hundreds of files must not bloat the index

// "TinyTREX" → "Tiny TREX"; "TREXModel" → "TREX Model"; "v02Final" → "v02 Final".
function splitCamel(s) {
  return String(s || "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L}{2,})/gu, "$1 $2");
}
const words = s => (String(s || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);

function searchForms(texts) {
  const out = new Set();
  for (const text of texts) {
    if (out.size >= MAX_FORMS) break;
    const plain = words(text), camel = words(splitCamel(text));
    for (const w of camel) out.add(w);
    // Adjacent words joined, both from the camel-split and the plain words.
    for (const ws of [camel, plain]) {
      for (let i = 0; i + 1 < ws.length; i++) {
        out.add(ws[i] + ws[i + 1]);
        if (i + 2 < ws.length) out.add(ws[i] + ws[i + 1] + ws[i + 2]);
      }
    }
  }
  return [...out].filter(w => w.length > 1).slice(0, MAX_FORMS).join(" ");
}

// The FTS5 query for what a person typed: every word as a prefix, or — with
// several words — the words joined ("t rex" → trex*). Nothing typed is
// passed through as FTS syntax.
function ftsQuery(q) {
  const toks = words(q).slice(0, 8);
  if (!toks.length) return "";
  // A one-letter word is matched whole: "t rex" must not find "the".
  const all = toks.map(t => (t.length === 1 ? `"${t}"` : `"${t}"*`)).join(" AND ");
  return toks.length > 1 ? `(${all}) OR "${toks.join("")}"*` : all;
}

module.exports = { searchForms, ftsQuery, splitCamel };
