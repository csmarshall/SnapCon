# ADR-0018: The slicer CLI hook's local file-path branch is trusted because the request comes from loopback

- **Status:** Superseded by [ADR-0019](0019-slicer-hook-authenticated-by-single-writer-token.md)
- **Date:** 2026-07-10 (`fbff116`), shipped with the Orca integration in 0.1.0 (`47b4cc7`)
- **Area:** Slicer integration / security

## Context
SnapCon's own executable doubles as a slicer post-processing hook: `SnapCon --load <file> --printer <name>` pings an already-running instance and exits. On the same machine it can pass a path reference ("zero-copy") rather than the bytes.

## Decision
`POST /api/notify-load` with a JSON `{file, printer, outputname}` reads an arbitrary local path and pushes it to a printer. It is gated only by `isLoopback(req)`, which checks that `req.socket.remoteAddress` is 127.0.0.1 or ::1. The remote `--snapcon host` variant streams bytes instead and was later gated like a normal print request (`requireRegular`).

## Alternatives considered
None recorded.

## Consequences
- Positive: no credentials to configure for the common same-machine slicer setup.
- Negative: became unsound once Remote Access shipped. cloudflared runs as a local child process forwarding to `http://localhost:<port>`, so tunnel traffic is indistinguishable from loopback at the socket level. Fixed by ADR-0019.

## Evidence
- `fbff116:server.js:645-652` (`if (!isLoopback(req)) return res.status(403)…`).
- Commit `394ef09` body; RELEASE_NOTES 0.7.0 "Security Fixes" ("identified callers only by them appearing to be local").

## Confidence
Inferred as a decision (no rationale was recorded at the time); the behaviour itself is in the code.
