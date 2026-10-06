# ADR-0001: A single Node.js + Express process that proxies every printer call server-side

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-07 (`4e293c3`, the initial public commit, v0.0.6; the decision predates the public history)
- **Area:** Runtime architecture

## Context
SnapCon controls a LAN fleet of printers (originally 25 Snapmaker U1s) that each expose Moonraker/Klipper HTTP APIs, cameras and file stores. A browser talking to each printer directly would hit CORS, would need every printer's credentials in the page, and could not run background work (notifications, queue dispatch, sync) while no tab is open.

## Decision
SnapCon is one long-running Node.js process (`server.js`) using Express. It serves the static UI from `public/`, exposes a JSON `/api/*` surface, and makes every printer request itself; the browser only ever talks to SnapCon. Background loops (fleet polling, notification watcher, queue dispatch, sync, audit pruning) run as `setInterval` timers in the same process. Feature subsystems were later split into directories (`connectors/`, `queue/`, `audit/`, `sync/`, `remote-access/`, `library/`, `netfs/`), each with a single entry point that `server.js` talks to, but routes and orchestration remain in the one `server.js` (≈6,000 lines at 0.8.0).

## Alternatives considered
None recorded.

## Consequences
- Positive: no CORS problem; printer secrets (Moonraker tokens, access codes) stay server-side; background work runs without a browser; one artifact to ship (see ADR-0002).
- Positive: modules expose "the only module server.js talks to" facades (`RemoteAccessService`, `SyncEngine`, `AuditLog`, `QueueStore`, `LibraryService`), which keeps subsystems testable.
- Negative: `server.js` starts a listening server on `require`, so it has no test harness; logic that needs tests is extracted into side-effect-free modules (ADR-0030).
- Negative: all in-memory state (sessions, jobs, OTP codes, caches) is lost on restart; there is no horizontal scaling story, which is acceptable for a single-site farm tool.

## Evidence
- `server.js:1-4` header: "pushes the chosen file to the chosen printer via Moonraker (server-side, so no browser CORS headaches)".
- `auth.js` "Sessions: in-memory only, same simplification as JOBS/offlineCache/camState".
- `remote-access/RemoteAccessService.js:1-7`, `sync/SyncEngine.js:1-6`, `audit/AuditLog.js:1` — "the only module server.js talks to".
- Commit `e551a7e` (2026-07-21) moved inline Moonraker calls behind the connector registry.

## Confidence
Stated for the server-side proxy (header comment). Inferred for "monolith" as a deliberate choice: no rationale for one process over services is recorded.
