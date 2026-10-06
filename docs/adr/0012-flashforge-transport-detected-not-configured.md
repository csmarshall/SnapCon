# ADR-0012: A FlashForge printer's transport (native API vs Moonraker) is detected at runtime by a pure, anti-flapping state machine

- **Status:** Accepted (retroactive)
- **Date:** 2026-08-29 (`0779ea0`, `cf9284a`, `507cc2a`, design doc `91b43bc`), hardened 2026-08-30 (`8a10370`, `df2af92`, `38400c1`)
- **Area:** Printer integration (FlashForge)

## Context
Stock FlashForge firmware serves a native JSON API on 8898. Community mods (ZMOD, Forge-X) take 8898 down and expose Moonraker on 7125. A printer was observed serving one transport and then the other within one session, so a configured or one-time-detected mode goes stale.

## Decision
- "The axis is transport, not vendor mod." `connectors/flashforge-mode.js` is only the decision state machine: cache, invalidation, re-probe, anti-flap, transition logging. It performs no I/O; callers inject liveness probes as thunks.
- 3 consecutive failures trigger a re-check; 2 consecutive detections of a different transport are needed before the mode switches. The cache is keyed by stable printer id and invalidated when the URL or an explicit `transport` pin changes.
- Model semantics stay in `flashforge-ad5x.js` / `flashforge-adventurer.js`; the Moonraker transport helper is `flashforge-moonraker.js`. Capabilities follow the detected transport.
- Print start is a hard gate, not a runtime fallback: an unknown print-start state fails closed (`df2af92`).

## Alternatives considered
A config-only mode field — kept as an optional manual pin, not the default ("detected rather than configured, and re-checked", RELEASE_NOTES 0.7.0).

## Consequences
- Positive: modded and stock printers both work without user configuration, and flapping doesn't drag controls in and out.
- Negative: synchronous `capabilities` had to be reconciled with an asynchronously detected mode (spec §6 "Synchronous constraint").
- The spec carries explicit hardware validation gates (`flashforge-hardware-verification.md`).

## Evidence
- `connectors/flashforge-mode.js:1-35`.
- `docs/superpowers/specs/flashforge-dual-transport-design.md` §1 (transport axis), §4, §5 (anti-flap, invalidation), §8 (print-start hard gate), §12 (resolved contradictions).
- RELEASE_NOTES 0.7.0 "FlashForge Printers Running ZMOD or Forge-X".

## Confidence
Stated.
