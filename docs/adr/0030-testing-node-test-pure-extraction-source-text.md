# ADR-0030: Tests use node:test only; logic is extracted into side-effect-free modules, and what cannot be imported is checked by source-text and derived structural tests

- **Status:** Accepted (retroactive)
- **Date:** First tests 2026-07-21 (`f814969`, Remote Access); the pattern was formalised 2026-08-11 with the P0/P1 fixes (`1f9a357`, `394ef09`, `a7252b9`) and `test/docker.test.js`
- **Area:** Quality / testing

## Context
`server.js` starts a real listening server and touches the repo's own `config.json` when required, so it has no test harness. `public/app.js` is not a module (ADR-0003). There is no test dependency budget (ADR-0004).

## Decision
- `npm test` = `node --test "test/**/*.test.js"`. No framework, no Express harness.
- Safety-critical logic is extracted into small modules "specifically so this is unit-testable without requiring server.js itself": `configLoader.js`, `notifyToken.js`, `pathSafety.js`, `groupAccess.js`, `locales.js`, `webhookNotify.js`, `updateCheck.js` (pure `compareVersions` / `shouldCheck` / `nextState`), the pure `QueueEngine`, the pure `flashforge-mode` state machine, and pure migrations. Detached route halves are named functions so they can be tested (`b9ed7eb`).
- Browser functions are tested by extracting them from `public/app.js` source with a regex and running them in a `vm` sandbox, or by asserting on source text when that is "the proportionate way".
- Structural invariants are tested by deriving the expectation rather than hardcoding it. `docker.test.js` walks `server.js`'s transitive `require()` graph and asserts that every top-level component has a Dockerfile `COPY`. `versionConsistency.test.js` pins every hardcoded version literal to `package.json`. `schema.test.js` asserts `library/schema.js` equals the spec's SQL.
- Hardware facts are captured as fixtures from real devices (e.g. `test/fixtures/bambu-p2s-report.js`).

## Alternatives considered
Deriving `VERSION` at runtime from `package.json` was rejected in favour of literals plus a test. The browser can't `require` it, and pkg snapshot paths differ between source and packaged runs.

## Consequences
- Positive: zero-dependency test suite; regressions like the missing Dockerfile `COPY` (C-1) are caught generically for future modules.
- Negative: source-text tests prove that code is present and shaped right, not that it behaves correctly in a browser. Server routes stay largely untested end to end. Docker behaviour is verified statically only ("No Docker engine was available", Library §22).

## Evidence
- `package.json` `scripts.test`; headers of `configLoader.js`, `notifyToken.js`, `pathSafety.js`, `groupAccess.js`, `locales.js`, `webhookNotify.js`, `updateCheck.js`.
- `test/docker.test.js:1-12`; `test/versionConsistency.test.js:1-20`; `test/i18n-closure.test.js:9-15`; `test/topbar.test.js:1-25`.

## Confidence
Stated.
