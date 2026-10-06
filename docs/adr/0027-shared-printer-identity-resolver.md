# ADR-0027: One printer-identity resolver, shared by server and browser, decides which machine a file was sliced for

- **Status:** Accepted (retroactive)
- **Date:** 2026-09-30 (`04ead35`, 0.8.0); families extended `c49b1bb`
- **Area:** Send compatibility

## Context
Send compared brands only, so a file sliced for one Creality was offered to every Creality. Real files carry generic `printer_model` values while `printer_settings_id` names the real machine. The Library also needed printer identity (Library D15: "The Library contains no printer-detection logic of its own").

## Decision
- `public/printer-identity.js` is "the one place slicer metadata and connector knowledge become a printer identity". It is loaded by the browser and `require`d by `server.js`.
- `identifyFile()` returns family, brand, confidence (high / medium "likely") and evidence. `default_print_profile` is recorded but never decides. `identifyPrinter()` uses the connector's `printerFamily`, the Creality-detected model, or the model a Bambu reports. `compare()` returns `match` / `model_mismatch` / `brand_mismatch` / `unknown`.
- Policy: a different model of the same brand is warned about and unticked only when the file is sure. "Can't tell" never unticks, and nothing is refused on identity alone (type incompatibility is refused separately). Only strings seen on real files go into the family table.

## Alternatives considered
Brand-only comparison (the previous behaviour).

## Consequences
- Positive: one table to extend; the browser and server can't disagree; the Library reuses it.
- Negative: requires the UMD-style shared file pattern (ADR-0003). Coverage grows only as real files are observed.

## Evidence
- `server.js:50-52`; commit `04ead35` body; RELEASE_NOTES 0.8.0 "Send checks the printer model, not only the brand"; `test/printerIdentity.test.js`; `docs/library-design.md` §1 D15, D19.

## Confidence
Stated.
