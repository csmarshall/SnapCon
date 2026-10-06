# ADR-0007: node:sqlite for append-heavy / indexed data, one database per feature, degrading to a no-op when unavailable

- **Status:** Accepted (retroactive)
- **Date:** 2026-08-08 (`e6b0cba`, Audit Trail, v0.5.0; `engines.node` raised from `>=18` to `>=22.5`)
- **Area:** Persistence

## Context
The audit trail (0.5.0), Logs/Camera sync history (0.7.0) and later the Model Library (0.8.0) need indexed queries and frequent appends that a whole-file JSON rewrite cannot serve at fleet scale. A native SQLite addon would break the pkg build model (ADR-0002).

## Decision
- Use Node's built-in `node:sqlite` `DatabaseSync`. Each feature owns its own database in its own directory: `audit-data/audit.db`, `sync-data/sync.db`, `library-data/library.db`, all `PRAGMA journal_mode = WAL`.
- If `require("node:sqlite")` throws, the feature degrades to a logged no-op rather than crashing the app ("never blocks or crashes any request either way").
- SQL is built only from allow-listed column names with bound parameters (`AuditLog.js` `ALLOWED_COLUMNS`).
- Audit rows store denormalised labels (`userLabel`, `printerName`) so history survives a printer's removal.

## Alternatives considered
- Flat JSON history — rejected for sync: "every append would rewrite the entire file, and the dedup check would mean loading and scanning the whole history" (`sync/SyncStore.js:8-12`).
- Native SQLite addons — rejected for packaging risk (`audit/AuditLog.js:2-5`).

## Consequences
- Positive: no dependency, indexed lookups, packaged builds carry no native addon (verified for the Library worker under pkg on win-x64, `docs/library-design.md` §21).
- Negative: Node ≥ 22.5 required; `node:sqlite` is still labelled "Active Development" by Node.
- Negative: WAL sidecar files mean Docker must mount directories, not single files (ADR-0031).
- PR #8 (external, "parameterized queries in AuditLog.js") was closed as a false positive with a data-flow explanation, confirming the allow-list design is intentional.

## Evidence
- `audit/AuditLog.js:1-7`; `sync/SyncStore.js:1-12`; `library/LibraryStore.js:4-5, 73, 213`.
- `package.json` `engines`; `docker-compose.yml` audit-data / sync-data / library-data comments.
- Upstream PR #8 maintainer comment (2026-09-11).

## Confidence
Stated.
