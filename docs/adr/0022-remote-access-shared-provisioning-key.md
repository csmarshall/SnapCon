# ADR-0022: The Remote Access backend authenticates installations with a single shared provisioning key

- **Status:** Superseded by [ADR-0023](0023-remote-access-ed25519-installation-identity.md)
- **Date:** 2026-07-21 (`f814969`, Milestone A)
- **Area:** Remote access

## Context
Milestone A needed a working provisioning call before per-installation identity existed on the backend.

## Decision
`RemoteAccessApiClient` sends an `X-SnapCon-Provisioning-Key` header taken from `SNAPCON_PROVISIONING_KEY`, with a locally generated random `installationId`. `isDevelopmentPreview()` always returned true, and the client was "designed to be swapped for per-installation account/Hub-pairing auth later without callers changing". Status, disable and token-rotation calls were named stubs.

## Alternatives considered
Per-installation auth was explicitly deferred to Milestone B.

## Consequences
- Negative: one shared secret for every install; "explicitly not a mechanism suitable for real customers".
- Positive: isolated behind one module, so replacing it a day later touched only the client and the service.

## Evidence
- `f814969:remote-access/RemoteAccessApiClient.js:1-30`.
- Commit `d3dbc0a` body.

## Confidence
Stated.
