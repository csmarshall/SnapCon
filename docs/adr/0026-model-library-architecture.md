# ADR-0026: The Model Library is a read-only, SQLite-backed index built on Claims vs Decisions, with an audited authored / identity-cache / derived boundary

- **Status:** Accepted (retroactive)
- **Date:** 2026-09-30 spec v3.2 approved (`bf82ddb`) after an M0 measurement spike (`4311c47`); built M1–M8 between 2026-09-30 and 2026-10-03 (`97e3480` … `64eb96d`); shipped 0.8.0 (`675540c`)
- **Area:** Model Library

## Context
Users keep thousands of sliced files across local folders and NAS shares. "Folders lie" (a `K1C/` folder held an Ender-3 V3 Plus file), `printer_model` can be generic, and grouping on object names alone falsely merged 7 Models under `Assembly`. Users must stay in charge, and their choices must survive rescans and rebuilds.

## Decision
- **Never touch the files** (D2): no delete, rename or move in Phase 1. The only "destructive" action is Hide. Locations are mounted read-only in Docker.
- **Claims vs Decisions** (D4, D14): automation writes Claims (`subject —relation→ object` with Evidence, confidence and state) under one canonical confidence policy. People write Decisions of the same shape, which are authoritative and always win. Uncertainty becomes a Review Item ("Needs attention").
- **Three data lifetimes** (§4.6): authored data (models, decisions, actions, prints, grants) survives any rebuild; an identity cache (quick fingerprint → verified sha256) survives normal rebuilds (`819a099`); derived data is dropped and recreated in one transaction. Authored rows reference derived data only by content keys, uuids and plate numbers, never by row id or foreign key.
- **Grouping comes from file evidence** (object names, project titles, slicer metadata, identical content), never from folder names alone. Ties break deterministically. Generic names ("Assembly", "Benchy") are never matched by name.
- **Storage and execution:** `node:sqlite` at `library-data/library.db` (WAL, foreign keys on, schema version tracked; `library/schema.js` must match the spec SQL, enforced by `schema.test.js`). Backups use `VACUUM INTO` in a worker thread, with quick_check, quarantine and restore after an integrity failure. Indexing reads through the netfs background lane (ADR-0025), pauses while uploads run, and uses an adaptive 512 KB head / 256 KB tail read window for G-code and range reads for 3MF via a hardened zip reader (`2d11e7a`).
- **No printer detection of its own** (D15): the Library uses the shared resolver (ADR-0027).
- **Printing from the Library** re-verifies that the file is byte-identical before sending, and again at queue dispatch.
- **Measure, then build** with owner sign-off per milestone. M4 Diagnostics was a hard checkpoint (D16).

## Alternatives considered
- Recorded in spec §2 and §18: Manyfold's folder = model; u1hub's folder-name models, path-keyed attributes and destructive rename/delete (rejected); 3MF Explorer's content-hash-keyed tags (adopted); sharing credit between ambiguous filename matches (rejected).
- `DELETE`-cascade rebuild (12 s at 100k files) was rejected for drop-and-recreate (456 ms).
- A 3 MB + 3 MB G-code read window was replaced by an adaptive one, about 20× smaller.

## Consequences
- Positive: user decisions survive moves, renames and rebuilds; offline shares keep their Models; full explainability via Diagnostics.
- Negative: a large spec (≈2,150 lines) and schema; moved-and-modified-offline files can lose their Decisions (R11, documented limit); a pending send is forgotten on restart (0.8.0 known limitation).

## Evidence
- `docs/library-design.md` §1 (D1–D19), §2, §4.4–§4.6, §5, §6.2, §17, §18, §21–§31.
- `library/WorkerHost.js:1-11`; `library/permissions.js`; commits `4311c47`, `97e3480`, `819a099`, `2d11e7a`, `7dd02dc`, `657a25d`.
- RELEASE_NOTES 0.8.0 "Model Library (new)", "Print and queue from the Library", "Print history".

## Confidence
Stated (owner decisions are recorded in the spec's D-table).
