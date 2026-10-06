# ADR-0023: Each installation has its own Ed25519 identity, registered through a browser verification step, and signs every backend call

- **Status:** Accepted (retroactive). Supersedes [ADR-0022](0022-remote-access-shared-provisioning-key.md)
- **Date:** 2026-07-22 (`d3dbc0a`, Milestone B); `4f6db99` (2026-07-23) adds `appVersion` to registration
- **Area:** Remote access

## Context
The backend moved to per-installation Ed25519-signed requests established through a browser-based Cloudflare Turnstile registration flow (`snapcon-api` CLIENT_INTEGRATION contract).

## Decision
- `Ed25519Identity.js` generates a per-install keypair with WebCrypto, exports the private key as single-line JWK, and signs requests. Single-line matters because the Windows DPAPI backend reads a stored value line by line.
- The private key is held in the OS secure store (ADR-0021). Signing happens inside `RemoteAccessApiClient` with a fresh timestamp and nonce per call. Registration endpoints are unsigned.
- `RemoteAccessService` gains a `registering` state (a human completes a one-time browser verification; poll every 3 s, no backoff) and a real `removeRemoteAccess()` that copes with pre-Milestone-B installs.

## Alternatives considered
The shared key (ADR-0022).

## Consequences
- Positive: no shared secret; each install can be revoked individually.
- Negative: losing the secure-store entry loses the identity. A corrupted identity key once crashed the whole server ("H-2"), which motivated the process-wide `unhandledRejection` logger (`server.js:55-64`, line 62).

## Evidence
- `remote-access/Ed25519Identity.js:1-35`; `remote-access/RemoteAccessApiClient.js:1-15`.
- Commits `d3dbc0a`, `4f6db99`, `5919038` (0.4.1 Remote Access rework).

## Confidence
Stated.
