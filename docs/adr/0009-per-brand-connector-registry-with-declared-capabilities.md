# ADR-0009: A per-brand connector registry; the UI and server branch on declared capabilities and addressing, not on brand

- **Status:** Accepted (retroactive); amended 2026-08-25 (addressing declaration, `a3e7119`)
- **Date:** 2026-07-21 (`e551a7e` moved protocol calls behind `getConnector`; connector files first committed `b0ad936`, 2026-07-25; shipped in 0.2.0)
- **Area:** Printer integration

## Context
SnapCon was built for the Snapmaker U1 and talked Moonraker inline. Supporting other printers (FlashForge AD5X first, then generic Klipper, Creality, Bambu Lab, a Simulator) without forking every route required an abstraction. The release notes state the U1 remains the primary target.

## Decision
- `connectors/index.js` maps a printer's `connector` string to a module via lazy `require`. "Adding a new brand means adding one file + one line here — nothing else in the app should need to change." Unknown types fall back to `DEFAULT_TYPE`.
- Each connector exports `label`, `brand`, `printerFamily`, a static `capabilities` object (camera, estop, eject, firmwareDeploy, …) or `getCapabilities(printer)` where one connector covers several hardware shapes, plus `probe()` returning a normalised status and control functions.
- Routes and UI gate actions on capabilities (e.g. E-Stop disabled with an explanation where the firmware fakes success, `394cef5`).
- Amendment (0.7.0): each connector also declares `address = { scheme, defaultPort, portEditable, required }`; Settings asks for IP/hostname and, only where meaningful, a port. `url` stays the canonical value connectors read, now derived; existing configs are split by an idempotent startup migration (ADR-0006).
- A Simulator connector exists so queue behaviour can be tested without hardware.

## Alternatives considered
- Previous model: a single free-text URL per printer (pre-0.7.0). Replaced because users "actually know" IP and port, and an empty URL silently dropped the printer.
- For U1 replacement, a new connector beside the old one rather than editing it (ADR-0011).

## Consequences
- Positive: brand-specific quirks stay in one file; capabilities make "this printer cannot do X" explicit in the UI rather than failing on press.
- Negative: capability objects are synchronous, which forced design work for transports discovered at runtime (FlashForge, ADR-0012).
- Negative: some cross-cutting features deliberately live outside the interface (firmware, ADR-0032).

## Evidence
- `connectors/index.js:1-66`.
- Commits `e551a7e`, `b0ad936`, `a3e7119` (body: "Each connector now declares how it is addressed … rather than special-casing brands").
- RELEASE_NOTES 0.2.0 "Connectors Architecture Introduced"; 0.7.0 "Printers Are Now Set Up by IP and Port".
- `docs/superpowers/specs/flashforge-dual-transport-design.md` §6 "Synchronous constraint".

## Confidence
Stated.
