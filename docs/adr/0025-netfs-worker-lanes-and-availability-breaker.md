# ADR-0025: All network-storage file access runs in dedicated worker-thread lanes behind a per-root availability breaker (netfs)

- **Status:** Accepted (retroactive)
- **Date:** 2026-10-02 (`cd006bc`; spec `e4659bd`, `docs/library-design.md` §23); shipped 0.8.0
- **Area:** Filesystem / resilience

## Context
The owner keeps the G-code folder and Library locations on a NAS. On Windows, a call to an unreachable SMB host blocks for about 21 seconds and cannot be cancelled. About 50 synchronous fs calls on the main thread each froze the whole server. Async calls are no cure, because libuv's four process-wide threads starve, and `UV_THREADPOOL_SIZE` cannot be raised from JS. The owner's requirement: "a dead or slow NAS may make NAS-backed features unavailable, but it must never make the SnapCon server itself unavailable".

## Decision
- `netfs/` runs synchronous fs calls inside a fixed set of worker threads, split into lanes: interactive 2 (browser, map, thumbnails, upload, print, queue), background 1 (Library indexer, sync), probe 1. A hung call blocks one worker of one lane only.
- Per-operation timeouts start when a worker takes the job; time spent waiting for a worker is bounded separately.
- A per-root or per-UNC-share breaker (`online` / `offline` / `checking`): a network error or timeout marks the root offline, operations then fail at once with `NAS_UNREACHABLE` (HTTP 503 `gcode_folder_unreachable`), and one probe at a time brings it back.
- "The breaker is an optimisation, never proof that a file exists." Containment, symlink rules, the forced pre-dispatch hash and exclusive-create uploads still run on every use.
- One availability concept is shared by the G-code folder, sync folders, firmware folder and Library. Queue dispatch claims nothing while the folder is down. A read failing mid-upload tears the request down, so a printer never receives a short file that looks complete.

## Alternatives considered
- Async `fs.promises`: rejected because of thread-pool starvation.
- A bigger thread pool: "only moves the cliff".
- Relaunching with a different pool size: "The relaunch approach was rejected."
- An earlier M1 decision (serialise reachability probes, keep them async on the main thread) was superseded by this design (§23 "supersedes the related lines in §22").

## Consequences
- Positive: measured max 85 ms and no request over 1 s with an unreachable share, against 21-second stalls before. Known-down roots answer in about 2 ms.
- Negative: every fs call on network storage must go through netfs. A worker entry must be in `pkg.scripts`. Two bounded exceptions remain on `fs.promises`: the sync download write stream and firmware image reads.
- Negative: a mapped drive letter counts as network storage only when registered as a root.

## Evidence
- `netfs/NetFs.js:1-27`; `server.js:33-36, 116`.
- Commit `cd006bc` body; `docs/library-design.md` §22 (M1 measurements), §23.
- `test/queueRootOutage.test.js`.

## Confidence
Stated.
