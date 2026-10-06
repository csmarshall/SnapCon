# ADR-0013: Bambu Lab support is a LAN-only connector (MQTT/TLS + implicit FTPS) that degrades to monitoring without Developer Mode and reports only verified fields

- **Status:** Accepted (retroactive)
- **Date:** 2026-09-16 (`30a7862`, 0.7.1 beta); `942de99` (0.7.2) added time remaining and fan speed
- **Area:** Printer integration (Bambu Lab)

## Context
Bambu printers are cloud-first. SnapCon is local-first (README) and MIT-licensed. The maintainer had one physical printer (P2S) and an external PR #9 (H2 monitoring) to draw on.

## Decision
- Talk to the printer directly: MQTT 3.1.1 over TLS on 8883 (user `bblp` + access code), files over implicit FTPS on 990, camera over RTSPS on 322. No cloud, no Bambu Studio. TLS verifies against a bundled Bambu device CA and requires CN = configured serial.
- One MQTT connection per printer, lazily created on first `probe()`, closed after 5 minutes without probes; only `push_status` is state, and a command reply counts only if its `sequence_id` matches one we sent (the report topic is shared with other clients).
- Without Developer Mode, print commands are refused by the printer. SnapCon then degrades to monitoring and says so on the card instead of failing on every button.
- Anything not observed on the reference printer is reported as unavailable rather than guessed; non-P2S models get an "Untested model" badge, not a refusal. Time remaining was withheld in 0.7.1 and enabled in 0.7.2 with a self-check against the slicer's estimate (hidden if off by ~60×).
- `.3mf` sliced-ness is decided by content (`Metadata/plate_N.gcode`), never by name. Filament-to-tray mapping is material first, then colour.
- E-Stop and Eject are disabled by capability. Queue pools are not offered in the beta.
- Licensing: protocol facts only from AGPL sources (BambuStudio tables, Joel's driver); MIT PR #9 parts reused (MQTT client, FTPS, CA bundle, RTSP→fMP4 relay).

## Alternatives considered
- Merging PR #9 as submitted: the PR was closed, and the maintainer built "approach A", reusing its monitoring parts and adding control (spec §3.6).
- Copying BambuStudio's error-text tables: rejected for licence reasons (spec §3.5).
- PR #9's TLS 1.2 pin: rejected because the P2S negotiated 1.3 (spec §5).

## Consequences
- Positive: works fully offline; honest about what is unverified.
- Negative: beta coverage only (one AMS, no external-spool printing, no pools, plate > 1 untested on hardware at 0.8.0).
- Negative: SnapCon owns MQTT/FTPS/RTSP code (ADR-0004).

## Evidence
- `connectors/bambu-lab.js:1-25`; `connectors/bambu-mqtt.js:1-16`.
- `docs/superpowers/specs/2026-09-15-bambu-connector-beta-design.md` §2 evidence table, §3 decisions, §5 lifecycle, §10 security.
- RELEASE_NOTES 0.7.1 "Bambu Lab Support (Beta)", 0.7.2, 0.8.0 "Bambu Lab projects with several plates".
- Upstream PR #9 (closed 2026-09-11) comments.

## Confidence
Stated.
