# ADR-0028: i18n uses plain JSON locale files, English is canonical, the runtime copy is never overwritten, and the client always falls back to English

- **Status:** Accepted (retroactive)
- **Date:** 2026-08-17 (`c5a4d09`, shipped 0.7.0)
- **Area:** Internationalisation

## Context
The whole UI, including the pre-login screen, needed English and Spanish, with admin-editable translations that survive upgrades. Bundled assets are read-only inside pkg (ADR-0002).

## Decision
- Bundled originals ship in `locales-default/{en,es}.json`. On first run they are seeded into a writable `BASE_DIR/locales/`, which is never overwritten afterwards, so admin edits survive upgrades. English is re-synced as the canonical source.
- Client runtime `public/i18n.js` provides `t()`/`tn()` as globals. Resolution order is the user's locale, then the site default, then English, then the raw key. A translation whose placeholder set differs from English is never rendered and falls back to English instead. Login must never show raw keys.
- Language can be chosen before login and per user; admins set the site default. An admin-only Language Editor adds, edits, imports and exports locales.
- Server errors gain additive machine `code` fields so the client can translate deterministic conditions without parsing English prose. Existing English fields are unchanged for other consumers.
- Snapmaker's own error-code catalogue is deliberately not translated (reference material).

## Alternatives considered
None recorded.

## Consequences
- Positive: upgrades never clobber a customised locale; no broken interpolations.
- Negative: also the documented 0.8.0 known limitation. An existing non-English file does not receive new keys, so new UI (the Library) shows in English until the file is replaced.
- Negative: the `locales/` directory needs its own Docker mount.

## Evidence
- `locales.js:1-17, 193, 228`; `public/i18n.js:1-10`; `server.js:86-92, 140-143`.
- Commit `c5a4d09` body; RELEASE_NOTES 0.7.0 "Multi-Language Support", 0.8.0 "Known limitations".
- `test/i18n-closure.test.js`.

## Confidence
Stated.
