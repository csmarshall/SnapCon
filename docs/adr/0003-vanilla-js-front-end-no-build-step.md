# ADR-0003: Vanilla JavaScript front end with no bundler or build step

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-07 (`4e293c3`)
- **Area:** Front end

## Context
The UI is served as static files by the same Express process and must be bundled verbatim into the pkg snapshot (ADR-0002).

## Decision
The browser UI is hand-written HTML/CSS/JS in `public/` (`index.html`, `app.js`, `style.css`, plus `i18n.js`, `error-codes.js`, `library.js`, `printer-identity.js`). Scripts are plain `<script>` tags that attach globals to `window`; there is no framework, no module bundler, no transpile step. Shared logic that the server also needs (`public/printer-identity.js`) is written as a UMD-style file that both `require()` and the browser can load.

## Alternatives considered
None recorded.

## Consequences
- Positive: no build toolchain; `public/` is exactly what ships; works under pkg's asset bundling without configuration.
- Negative: `public/app.js` is very large and its functions cannot be imported by tests; tests extract named functions from source text and run them in a `vm` sandbox, or assert on source text directly (ADR-0030).
- Negative: XSS discipline, theming and i18n all have to be enforced by convention and tests rather than by a framework.
- Fleet rendering does its own DOM diffing (per-card signatures, in-place `data-live` patches, position-aware insertion) instead of relying on a virtual DOM (`73ef416`, `7faeff9`).

## Evidence
- `public/i18n.js:3-5`: "Loaded as a plain <script> before app.js, same non-module pattern error-codes.js already establishes (no bundler, no build step)."
- `test/i18n-closure.test.js` header: "Neither public/i18n.js nor public/app.js are Node modules … A lightweight source-text check is the proportionate way".
- `test/topbar.test.js` (functions loaded from `public/app.js` into a `vm` sandbox).
- `server.js:50-52` requires `./public/printer-identity.js` ("Shared with the browser").
- Commit `7faeff9` (in-place card updates; 100 printers ~63 ms → ~8 ms per poll).

## Confidence
Stated for "no bundler, no build step" (i18n.js). Inferred that it was a deliberate choice from the start rather than a default.
