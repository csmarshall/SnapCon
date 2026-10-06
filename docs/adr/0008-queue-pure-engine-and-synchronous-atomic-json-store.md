# ADR-0008: Queue Management splits a pure state-transition engine from a single synchronous, atomically-persisted store

- **Status:** Accepted (retroactive)
- **Date:** 2026-08-08 (`e6b0cba`, v0.5.0)
- **Area:** Queue Management

## Context
The queue dispatches physical prints. Two concurrent dispatchers claiming the same item, or a crash between "decided" and "persisted", would start a real print twice or lose track of one.

## Decision
- `queue/QueueEngine.js` is pure `(state, …args) => result`, no I/O; it defines the queue states (`unmanaged`, `idle`, `dispatching`, `printing`, `awaiting_bed_clear`, `bed_clear_running`, `queue_attention_required`), attention reasons, and the narrow set of legal resolutions per reason.
- `queue/QueueStore.js` is the only owner of authoritative state and of `data/queue-data.json`. Persistence is synchronous (`writeFileSync` temp → `renameSync`, with a `.bak` and a corrupt-file quarantine chain) so read-compute-write shares one JS call stack and `claimNextForDispatch` is atomic without a lock library.
- Intent-driven actions persist the candidate first and commit to memory only on success; observed physical events update memory immediately and persist best-effort, marking the store globally degraded on failure (which then blocks new intent-driven actions).
- A missing folder is an outage, not proof of deletion: dispatch defers instead of failing "file missing" (`527a984`, ADR-0025).

## Alternatives considered
"calling a 'pure' function twice and hoping" for atomicity — rejected in the header. SQLite was not used for queue state; no rationale recorded.

## Consequences
- Positive: atomic claims and crash-safe writes with no dependencies; the engine is fully unit-testable.
- Negative: synchronous disk writes on the event loop; a Windows process briefly holding the file needed a transient-retry wrapper (`243847c`).
- Negative: one shared file means one write failure degrades the queue for every printer (deliberate).

## Evidence
- `queue/QueueEngine.js:1-45`; `queue/QueueStore.js:1-24, 85-165`.
- Commits `e6b0cba`, `243847c` ("Queue saves survive another process holding queue-data.json for a moment"), `527a984`.
- `docker-compose.yml` `./data` mount comment (temp-file-then-rename requires the same mount).

## Confidence
Stated.
