# ADR-0004: Express is the only runtime dependency; protocol clients are written in-house on Node built-ins

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-07 (`4e293c3`, `package.json` has had exactly one runtime dependency since the first commit); rationale written down 2026-07-21 (`f814969`) and 2026-09-16 (`30a7862`)
- **Area:** Dependencies

## Context
pkg cross-builds four targets and native addons are "a common breakage source for that build model". A larger dependency tree also increases audit surface for an app that holds printer credentials.

## Decision
`dependencies` contains only `express`. Everything else is implemented on Node built-ins:
- MQTT 3.1.1 subset for Bambu (`connectors/bambu-mqtt.js`), implicit FTPS (`connectors/ftps-client.js`), RTSP + RTP H.264 depacketizer + fragmented-MP4 muxer (`connectors/rtsp-client.js`, `connectors/h264-fmp4.js`), ZIP/3MF readers (`connectors/zip-reader.js`, `library/zipReader.js`), cookie parsing and scrypt password hashing (`auth.js`), OS secret storage via `security` / `secret-tool` / PowerShell DPAPI child processes (`remote-access/SecureCredentialStore.js`), SQLite via `node:sqlite` (ADR-0007), HTTP via built-in `fetch`.
- The Model Library spec records it as owner decision D3: "No new dependency unless necessary. Result: none needed."

## Alternatives considered
- `mqtt` npm package — rejected: "A full MQTT stack … would be most of the dependency tree" (`bambu-mqtt.js:5-11`).
- `keytar` — rejected for native-addon packaging risk (`SecureCredentialStore.js:10-12`).
- WebCodecs for camera decoding — rejected because plain-http LAN pages are not a secure context (`h264-fmp4.js:5-10`).
- ffmpeg is used only opportunistically if already on PATH, for still frames (`bambu-camera.js:15-19`).

## Consequences
- Positive: tiny install, reliable pkg builds, small supply-chain surface.
- Negative: SnapCon owns and must test protocol code (MQTT framing, zip64 edge cases, RTP fragmentation) that libraries would otherwise cover; each is unit-tested against fixtures or real sockets.
- Negative: optional features that need heavy tooling (still JPEGs from H.264) degrade when the tool is absent.

## Evidence
- `package.json` `dependencies`.
- `connectors/bambu-mqtt.js:5-11`; `remote-access/SecureCredentialStore.js:10-12`; `connectors/h264-fmp4.js:5-10`.
- `docs/library-design.md` §1 D3; `docs/superpowers/specs/2026-09-15-bambu-connector-beta-design.md` §4 "No new runtime dependency (Node built-ins only; express stays the only one)."
- `updateCheck.js` / commit `6fba8e6`: "Node's built-in fetch, 10 s timeout, no new dependency."

## Confidence
Stated.
