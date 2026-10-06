# ADR-0019: The local slicer hook is authenticated by a server-generated token file that the CLI only reads

- **Status:** Accepted (retroactive). Supersedes [ADR-0018](0018-slicer-hook-trusted-by-loopback.md)
- **Date:** 2026-08-11 (`394ef09`, "P0-3", shipped 0.7.0)
- **Area:** Slicer integration / security

## Context
Loopback no longer means "local" once Remote Access forwards public traffic to localhost (ADR-0018, ADR-0021). The route is a privileged "read any local file and print it" primitive.

## Decision
- `notifyToken.js` holds a 256-bit random token in `notify-token.json` under `BASE_DIR`, as proof of local filesystem access rather than an inference from network location.
- Single writer: only the long-running server generates and persists it, once, at startup (`ensureNotifyToken`). The short-lived CLI only ever reads it (`readNotifyToken`) and sends `X-SnapCon-Local-Token`. If two processes could both generate a token, they could silently disagree.
- The file-path branch requires both `isLoopback()` (kept as defence in depth) and a timing-safe token match. If the token cannot be persisted, the route fails closed (503) and never falls back to loopback-only trust.
- Logic is extracted into its own module so it is unit-testable without starting the server.

## Alternatives considered
Loopback-only trust (ADR-0018), now explicitly "not a sufficient authentication boundary on its own". An in-memory token was rejected because the CLI is a separate process and could never learn it.

## Consequences
- Positive: closes a remote-trigger hole introduced by Remote Access, with no change to the slicer command line.
- Negative: the CLI must run as a user who can read `BASE_DIR`, and the server must have started at least once.

## Evidence
- `notifyToken.js:1-26, 40-55`; `server.js:397-402, 2760-2775`.
- Commit `394ef09` body ("confirmed via source in both repos plus a live mechanism test").
- `test/notifyToken.test.js`.

## Confidence
Stated.
