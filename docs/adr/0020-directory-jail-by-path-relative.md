# ADR-0020: File operations are jailed to their folder with a segment-aware path.relative check, shared by all routes

- **Status:** Accepted (retroactive)
- **Date:** 2026-08-11 (`a7252b9`, "P1-1", shipped 0.7.0)
- **Area:** Security / filesystem

## Context
The G-code folder browser supports mkdir, move, upload, search and print. Containment was previously a raw `candidate.startsWith(folder)` string check, duplicated in three places. A sibling such as `.../gcode-backup` passed it.

## Decision
- `pathSafety.js` provides `isPathWithinFolder(candidate, folder)`. It computes `path.relative(folder, candidate)` and rejects the result if it is absolute (a different drive or root) or if its first segment is exactly `..`. The `..` must be the whole first segment: a descendant named `..hidden` is allowed.
- `resolveWithinFolder(sub, folder)` returns the resolved path or null. `safePath()` and the mutation routes use these instead of their own copies.
- The check is lexical by design and does not resolve symlinks. Callers that care handle symlinks explicitly: firmware listing never lists them and `lstat` rejects them (`4c78eba`); Library roots use realpath containment and refuse overlapping roots (Library R8).
- The browser sends folder-relative paths only (e.g. `/api/firmware-files`).

## Alternatives considered
String-prefix checks, including the `startsWith(folder + sep)` variant: rejected in the header for missing segment boundaries and mishandling a filesystem-root folder.

## Consequences
- Positive: one tested containment primitive.
- Negative: symlink semantics are each caller's responsibility, which is documented but easy to forget.

## Evidence
- `pathSafety.js:1-45`; `server.js:549` (`safePath`); `test/pathSafety.test.js`.
- Commit `a7252b9`; RELEASE_NOTES 0.7.0 "The gcode folder boundary could be sidestepped".
- Commit `4c78eba` body (symlink handling for the firmware folder); `docs/library-design.md` §17 R8.

## Confidence
Stated.
