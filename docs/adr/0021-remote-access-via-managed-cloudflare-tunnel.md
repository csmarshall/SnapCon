# ADR-0021: Remote Access is a SnapCon-managed Cloudflare Tunnel (cloudflared child process) provisioned through a maintainer-run backend

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-21 (`f814969`, `7347399`, `196744e`, `9a398f4` and follow-ups; shipped 0.2.0 as a Development Preview; UX rework 0.4.1)
- **Area:** Remote access

## Context
Users want to check prints away from home "no port forwarding, no VPN, no messing with your router" (RELEASE_NOTES 0.2.0), while SnapCon stays local-first and opt-in.

## Decision
- SnapCon downloads the official `cloudflared` binary, verifies it fail-closed against a committed, hand-reviewed SHA-256 manifest (`cloudflared-checksums.json`), and runs it as a supervised child process (`CloudflaredManager`, serialised start/stop/restart, instance lock). There is no runtime checksum fetch and no trust-on-first-use. Platforms whose published checksums didn't match (darwin) are excluded.
- A provisioning backend (`api.snapcon.app`, a separate maintainer project `snapcon-api`) creates the tunnel and hostname and returns a tunnel token. Its response is validated (hubId, hostname, https-only publicUrl).
- The tunnel token is the one secret. It is stored only in OS-native secure storage (DPAPI, Keychain, Secret Service) via CLI child processes. With no native store it throws, and an insecure file store exists only as an explicit opt-in.
- `RemoteAccessService` is the only module `server.js` talks to. It is constructed cheaply and started inside `app.listen`'s callback; routes are admin-only. Local and public reachability probes run concurrently.
- Fully opt-in and reversible.

## Alternatives considered
None recorded for tunnel vendor or approach.

## Consequences
- Positive: one-click remote access with no router changes; binary supply chain pinned and human-reviewed.
- Negative: depends on a maintainer-operated backend and on Cloudflare. macOS is unsupported until checksums verify. Each cloudflared upgrade needs a manual manifest update.
- Negative: tunnel traffic arrives as localhost, which broke loopback-based trust (ADR-0018 → ADR-0019) and makes WebRTC cameras LAN-only (ADR-0014).

## Evidence
- `remote-access/CloudflaredManager.js:1-31`; `remote-access/cloudflared-checksums.json` `note`; `remote-access/SecureCredentialStore.js:1-17`; `remote-access/RemoteAccessService.js:1-7`.
- Commits `f814969` body, `b94081b`, `cee962d`, `626e3c2`, `0e9952f`, `c77ac2e`; `server.js:425-429`.
- RELEASE_NOTES 0.2.0 "Remote Access".

## Confidence
Stated for verification and secret storage. Inferred for why Cloudflare in particular was chosen.
