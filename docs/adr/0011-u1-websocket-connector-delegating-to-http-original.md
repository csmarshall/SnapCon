# ADR-0011: The U1 connector subscribes over WebSocket, delegates everything else to the untouched HTTP connector, and falls back to it

- **Status:** Accepted (retroactive). Supersedes [ADR-0010](0010-u1-status-by-http-polling.md)
- **Date:** 2026-08-11 introduced (`73ef416`); 2026-08-22 made the only U1 connector (`1d25abc`); shipped in 0.7.0
- **Area:** Printer integration (Snapmaker U1)

## Context
Polling every U1 on every tick (ADR-0010) is heavy for a 25-printer farm and slow to reflect changes. Rewriting the proven HTTP connector in place risked regressions on the primary hardware.

## Decision
- `connectors/snapmaker-u1-klipper-ws.js` holds a persistent Moonraker `printer.objects.subscribe` WebSocket, merges deltas, and detects staleness. When the WebSocket is unhealthy, it calls the original connector's own `probe()` as-is.
- Every other export (upload, start, pause, E-Stop, head mapping, camera, file sync) and the `capabilities` object are re-exported from `snapmaker-u1-klipper.js`, which "stays intact as the delegate underneath it and as the reference implementation". Status normalisation is deliberately duplicated rather than shared so the new file never requires touching the original.
- The old type is removed from the registry and becomes the delegate. Configs are rewritten at startup by `migrateU1Connector.js`, which moves only the `connector` string. The worst case for a migrated printer is exactly its previous behaviour.

## Alternatives considered
- Merging WebSocket support into the original connector — rejected in the file header ("Deliberately NOT merged into the original").
- Keeping both connectors user-selectable — done in 0.7.0 ("SnapMaker U1 (Old)"), then the old one was removed from the picker in `1d25abc`; the automatic HTTP fallback replaced a manual connector switch.

## Consequences
- Positive: live status with a proven fallback; zero-risk migration verified against a real 20-printer config.
- Negative: normalisation logic exists twice and must be kept in step by tests.
- Negative: a second independent connection per printer (camera uses its own).

## Evidence
- `connectors/snapmaker-u1-klipper-ws.js:1-26`; `connectors/migrateU1Connector.js:1-21`; `connectors/index.js:5-12`.
- Commit `1d25abc` body ("Verified against a copy of a real 20-printer config").
- RELEASE_NOTES 0.7.0 "The Snapmaker U1 Connector".

## Confidence
Stated.
