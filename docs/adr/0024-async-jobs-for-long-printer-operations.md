# ADR-0024: Long printer operations return a jobId at once and are polled; success means "it happened", not "the request was accepted"

- **Status:** Accepted (retroactive). Replaces the earlier synchronous `/api/printfile` contract (an implicit behaviour, not a recorded decision)
- **Date:** 2026-09-08 (`b9ed7eb`, `1772c12`; shipped 0.7.0); the `JOBS` + `/api/print-status` mechanism for uploads predates it
- **Area:** API / printer control

## Context
Starting a file already on the printer held the HTTP request open through head mapping and, on Creality, a bed-levelling pass bounded at 12 minutes. Browsers timed out on prints that had in fact started. A gcode command can also queue behind a blocking macro: a `CANCEL_PRINT` executed about 46 seconds after it was sent. So a failed request says nothing about whether the printer acted.

## Decision
- `POST /api/printfile` runs only cheap synchronous guards (unknown printer, visibility, maintenance mode, filename), allocates a jobId in the in-memory `JOBS` map, responds immediately, and runs the work detached, writing `job.phase` (`mapping → starting → done|error`).
- Clients poll `GET /api/print-status?job=<id>`. Success bookkeeping (clearing "Loaded", suppressing the duplicate start notification, the audit row) moves into the background success path and fires exactly once, never for a failed job. "An audit trail claiming a print started when it did not is worse than no trail at all."
- This reuses the upload path's existing job machinery rather than adding a second one. The detached half is a named function so it can be tested without an Express harness.
- Related: slow control commands no longer report false failures (`f05e7f5`), and a start-sequence guard keeps a printer that is starting a print from looking idle (`033412a`, `07d9c7c`).

## Alternatives considered
Keeping the synchronous call with longer timeouts. Rejected implicitly by the 46-second measurement.

## Consequences
- Positive: honest success reporting; failures after acceptance become visible; the UI shows phases.
- Negative: breaking API change for automation ("Scripts that relied on the old synchronous success or error response need updating"). Jobs are in memory and lost on restart.

## Evidence
- Commit `b9ed7eb` body; `server.js:1563` (`JOBS`), `server.js:1928`, `server.js:2058`; `test/printFileAsyncJob.test.js`.
- RELEASE_NOTES 0.7.0 "Printing a File Already on the Printer No Longer Freezes the Button".

## Confidence
Stated.
