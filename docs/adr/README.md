# SnapCon — retroactive Architecture Decision Records

These ADRs record significant architectural decisions already made in upstream SnapCon (Eran Zeitoun, [ezeitoun/SnapCon](https://github.com/ezeitoun/SnapCon)), so the fork (csmarshall/SnapCon) can refer to them.

**They are retroactive.** The maintainer did not write them at the time. Each one was reconstructed from evidence: git history (`main` up to `3b9ba5f`, 2026-10-04), `RELEASE_NOTES.md`, `README.md`, the design docs under `docs/` (especially `docs/library-design.md` and `docs/superpowers/specs/*`), the rationale comments in source headers, and upstream PRs, issues and releases. The fork's own commits (`8397489`, `cc4a5f3`, `f2ffe69`, and later fork branches) are excluded. Line references are to `main` at `3b9ba5f`.

## Format

MADR-lite. Each ADR has: Title, Status, Date (when the decision landed in git), Area, Context, Decision, Alternatives considered (only those the evidence shows; otherwise "none recorded"), Consequences, Evidence, and Confidence.

- **Confidence: Stated** means the rationale is written down by the maintainer (code comment, commit body, spec, release note).
- **Confidence: Inferred** means the decision is visible in the code, but its rationale or deliberateness is our reading.
- **Superseded** decisions are kept as separate ADRs, linked in both directions.

## Evidence gaps

- History starts at `4e293c3` "Initial commit — SnapCon v0.0.6, independent release". Decisions made before that (Node/Express, pkg, vanilla JS) are dated to that commit but predate it.
- The maintainer untracked his internal working docs on 2026-08-08 (`b94631f`: design notes, code/security reviews, his `CLAUDE.md`). Source comments cite `CODE_AUDIT.md` (P0-1…P1-2, C-1, H-2, H-3) and `docs/TODO.md`, which are not in the repo. The finding IDs are quoted from comments and commit bodies only.
- Several early commits are bulk "accumulated work" commits (`e551a7e`, `02b28fe`, `6bc559e`, `b0ad936`), so dates for the connector layer are when it was committed, not when it was designed.

## Index

| # | Title | Status | Date | Area |
|---|---|---|---|---|
| [0001](0001-node-express-monolith-with-server-side-printer-proxy.md) | Single Node.js + Express process proxying every printer call server-side | Accepted | 2026-07-07 | Runtime architecture |
| [0002](0002-single-file-binaries-via-pkg.md) | Single-file desktop executables via pkg; BASE_DIR / ASSET_DIR split | Accepted | 2026-07-07 | Packaging |
| [0003](0003-vanilla-js-front-end-no-build-step.md) | Vanilla JS front end, no bundler or build step | Accepted | 2026-07-07 | Front end |
| [0004](0004-express-as-sole-runtime-dependency.md) | Express as the only runtime dependency; in-house protocol clients | Accepted | 2026-07-07 | Dependencies |
| [0005](0005-json-files-for-config-and-users.md) | Config and users in separate JSON files; corrupt config quarantined | Accepted | 2026-07-07 / 07-10 / 08-11 | Persistence |
| [0006](0006-stable-printer-ids-and-idempotent-startup-migrations.md) | Stable printer ids; idempotent startup migrations | Accepted | 2026-07-21 | Data model |
| [0007](0007-node-sqlite-per-feature-stores-with-graceful-degrade.md) | node:sqlite per-feature stores with graceful degrade | Accepted | 2026-08-08 | Persistence |
| [0008](0008-queue-pure-engine-and-synchronous-atomic-json-store.md) | Queue: pure engine + synchronous atomic JSON store | Accepted | 2026-08-08 | Queue |
| [0009](0009-per-brand-connector-registry-with-declared-capabilities.md) | Per-brand connector registry with declared capabilities and addressing | Accepted (amended 2026-08-25) | 2026-07-21 | Printer integration |
| [0010](0010-u1-status-by-http-polling.md) | U1 status by HTTP polling | Superseded by 0011 | 2026-07-07 | Snapmaker U1 |
| [0011](0011-u1-websocket-connector-delegating-to-http-original.md) | U1 WebSocket connector delegating to, and falling back on, the HTTP original | Accepted | 2026-08-11 / 08-22 | Snapmaker U1 |
| [0012](0012-flashforge-transport-detected-not-configured.md) | FlashForge transport detected at runtime by a pure anti-flap state machine | Accepted | 2026-08-29 | FlashForge |
| [0013](0013-bambu-lab-lan-connector-beta.md) | Bambu Lab LAN-only connector (beta), Developer-Mode degrade, verified-only fields | Accepted | 2026-09-16 | Bambu Lab |
| [0014](0014-camera-snapshot-throttle-live-relay-and-webrtc.md) | Cameras: throttled snapshots, server live relay, browser WebRTC | Accepted | 2026-07-25 / 08-25 / 09-16 | Cameras |
| [0015](0015-optional-user-access-management.md) | Opt-in User Access Management: implicit admin, three roles, OTP | Accepted | 2026-07-10 | AuthN |
| [0016](0016-printer-group-scoping-through-one-choke-point.md) | Printer-group scoping through one `printerVisibleTo` choke point | Accepted | 2026-08-08 / 08-11 | AuthZ |
| [0017](0017-library-capability-grants.md) | Library capabilities in a grants table, not roles | Accepted | 2026-09-30 | AuthZ |
| [0018](0018-slicer-hook-trusted-by-loopback.md) | Slicer hook trusted by loopback | Superseded by 0019 | 2026-07-10 | Slicer hook / security |
| [0019](0019-slicer-hook-authenticated-by-single-writer-token.md) | Slicer hook authenticated by a single-writer local token | Accepted | 2026-08-11 | Slicer hook / security |
| [0020](0020-directory-jail-by-path-relative.md) | Directory jail via segment-aware `path.relative` | Accepted | 2026-08-11 | Filesystem security |
| [0021](0021-remote-access-via-managed-cloudflare-tunnel.md) | Remote Access via a managed cloudflared tunnel, pinned checksums, OS secret store | Accepted | 2026-07-21 | Remote access |
| [0022](0022-remote-access-shared-provisioning-key.md) | Remote Access backend: shared provisioning key | Superseded by 0023 | 2026-07-21 | Remote access |
| [0023](0023-remote-access-ed25519-installation-identity.md) | Remote Access backend: per-installation Ed25519 identity | Accepted | 2026-07-22 | Remote access |
| [0024](0024-async-jobs-for-long-printer-operations.md) | Long printer operations as async jobs + polling | Accepted | 2026-09-08 | API |
| [0025](0025-netfs-worker-lanes-and-availability-breaker.md) | netfs: worker-thread lanes + availability breaker for network storage | Accepted | 2026-10-02 | Filesystem resilience |
| [0026](0026-model-library-architecture.md) | Model Library: read-only SQLite index, Claims vs Decisions, three data lifetimes | Accepted | 2026-09-30 → 10-03 | Model Library |
| [0027](0027-shared-printer-identity-resolver.md) | Shared server/browser printer-identity resolver | Accepted | 2026-09-30 | Send compatibility |
| [0028](0028-i18n-json-locales-english-canonical.md) | i18n: JSON locales, English canonical, never-overwritten runtime copy | Accepted | 2026-08-17 | i18n |
| [0029](0029-theming-css-tokens-data-theme.md) | Theming: CSS tokens + `data-theme`, pre-paint, per-account | Accepted | 2026-08-13 | Theming |
| [0030](0030-testing-node-test-pure-extraction-source-text.md) | Testing: node:test, pure-module extraction, source-text and derived structural tests | Accepted | 2026-07-21 / 08-11 | Testing |
| [0031](0031-docker-image-and-per-feature-mounts.md) | Docker: alpine image, host networking, one mount per persisted feature | Accepted | 2026-07-07 (expanded since) | Deployment |
| [0032](0032-u1-firmware-deploy-outside-connector-interface.md) | U1 firmware deploy outside the connector interface, admin-only, gated | Accepted | 2026-08-25 | Snapmaker U1 / safety |
| [0033](0033-update-check-via-github-releases.md) | Update check via GitHub Releases API (unreleased) | Accepted | 2026-10-04 | Updates |

## Supersession chains

- 0010 U1 HTTP polling → superseded by 0011 U1 WebSocket + HTTP fallback
- 0018 Slicer hook trusted by loopback → superseded by 0019 single-writer local token (forced by 0021: tunnel traffic arrives as localhost)
- 0022 Remote Access shared provisioning key → superseded by 0023 per-installation Ed25519 identity

Changes recorded inside a single ADR rather than as a pair, because the earlier state was implicit behaviour rather than a recorded decision: the URL → IP+port addressing in 0009, the synchronous `/api/printfile` in 0024, the string-prefix path check in 0020, and the M1 main-thread reachability probes in 0025.
