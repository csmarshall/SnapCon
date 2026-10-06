# ADR-0006: Printers get stable generated ids, and config schema changes are idempotent startup migrations

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-21 (`e551a7e`, `ensurePrinterIds`)
- **Area:** Data model / upgrades

## Context
Printers were originally identified by array position and their maintenance log was stored inside the printer object, so deleting, renaming or re-addressing a printer lost its history. Later features (groups, queue pools, audit, Library print history) all need to key data by printer.

## Decision
- Every printer gets a persistent `p_<hex>` id (`newPrinterId`). Maintenance history moves to `CFG.maintenanceHistory[id]`. Subsystems key by this id (e.g. `flashforge-mode.js` caches by `p.id`, "NOT the array-index `id` in API responses").
- Config shape changes are pure `migrateX(cfg) → { cfg, changed }` functions run unconditionally at every startup, no-ops once applied, preserving every other field verbatim: `ensurePrinterIds`, `migrateU1Connector` (ADR-0011), `migratePrinterAddress` (ADR-0009), `queue/migratePrinterPool.js`.
- A value a migration cannot safely transform is reported and left untouched.

## Alternatives considered
None recorded (a "have I run yet" flag is mentioned as the thing this avoids).

## Consequences
- Positive: upgrades never detach a printer from its history, group access or queue; migrations are unit-testable pure functions.
- Negative: some API responses still use array indexes (`/api/snapshot?printer=<idx>`), so two identities coexist and callers must know which one they hold.

## Evidence
- `server.js:145-160` (`newPrinterId`, `ensurePrinterIds` comment); commit `e551a7e` "Persistent printer IDs + one-time migration (ensurePrinterIds), so maintenance history survives…".
- `connectors/migrateU1Connector.js:7-13`; commit `a3e7119` "A URL the migration cannot take apart is reported and left exactly as it is".
- `connectors/flashforge-mode.js:30-35`.

## Confidence
Stated.
