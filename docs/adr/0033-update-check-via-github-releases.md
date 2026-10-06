# ADR-0033: "Update available" asks the public GitHub Releases API once a day, carrying nothing about the farm

- **Status:** Accepted (retroactive). Unreleased at the time of writing (RELEASE_NOTES "Unreleased")
- **Date:** 2026-10-04 (`6fba8e6` server, `3b9ba5f` UI)
- **Area:** Distribution / updates

## Context
Users run packaged binaries and need to learn about new releases. SnapCon is local-first and should not phone home with farm data.

## Decision
- `updateCheck.js` calls `api.github.com/repos/ezeitoun/SnapCon/releases/latest` 30 seconds after startup when the stored answer is over a day old, then daily with up to 30 minutes of jitter. It uses built-in `fetch` with a 10-second timeout and ETag / `If-None-Match`.
- The request carries only Accept, a `SnapCon/<version>` User-Agent, the API version and the ETag. No token, nothing about printers or files.
- State lives in `data/update-check.json` (atomic write). Rate limits are honoured only within 2 hours, and absurd values become a fixed 1-hour wait, "so a bad value can never block checks indefinitely". It never throws.
- GitHub's text is untrusted: the link must be on this repo's releases page, and the name is rendered as plain text.
- Shown to admins only (top bar and Settings → General → Updates). On by default, with a "Check for updates" switch.
- Decisions are pure functions (`compareVersions`, `shouldCheck`, `nextState`) for testing.

## Alternatives considered
None recorded. No auto-update is attempted; it only notifies.

## Consequences
- Positive: no new dependency or backend; minimal data disclosure.
- Negative: on by default, which is an outbound request on every install unless disabled; tied to the upstream repo name (forks will be told about upstream releases).

## Evidence
- `updateCheck.js:1-30`; `server.js:431-434`; commits `6fba8e6`, `3b9ba5f`; `test/updateCheck.test.js`; RELEASE_NOTES "Unreleased / Update check".

## Confidence
Stated.
