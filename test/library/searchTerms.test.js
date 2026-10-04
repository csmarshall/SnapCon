// test/library/searchTerms.test.js — search word forms (M6 follow-up to M5):
// candidate retrieval only, never grouping Evidence or a display name.
const test = require("node:test");
const assert = require("node:assert/strict");
const { searchForms, ftsQuery, splitCamel } = require("../../library/searchTerms");

test("camel-case names split into words, and adjacent words are also joined", () => {
  assert.equal(splitCamel("TinyTREX"), "Tiny TREX");
  assert.equal(splitCamel("TREXModel"), "TREX Model");
  const forms = searchForms(["TinyTREX"]).split(" ");
  for (const w of ["tiny", "trex", "tinytrex"]) assert.ok(forms.includes(w), w);
  for (const name of ["T-Rex", "T Rex", "Skeleton T-Rex", "T_Rex"]) assert.ok(searchForms([name]).split(" ").includes("trex"), name);
});

test("a typed query tries every word as a prefix, or the words joined; one letter matches whole; no FTS syntax passes through", () => {
  assert.equal(ftsQuery("trex"), '"trex"*');
  assert.equal(ftsQuery("t rex"), '("t" AND "rex"*) OR "trex"*');
  assert.equal(ftsQuery("T-REX"), ftsQuery("t rex"));
  assert.equal(ftsQuery('"; DROP TABLE models --'), '("drop"* AND "table"* AND "models"*) OR "droptablemodels"*');
  assert.equal(ftsQuery("  "), "");
});
