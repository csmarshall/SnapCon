# ADR-0029: Theming is CSS custom-property tokens switched by data-theme, applied before first paint, and stored on the user's account

- **Status:** Accepted (retroactive)
- **Date:** 2026-08-13 (`08dfad4`); account sync 2026-08-14 (`b13eefa`); shipped 0.7.0
- **Area:** Front end / theming

## Context
SnapCon was dark-only, with some status colours hardcoded in JS. A light theme had to keep status colours legible, not just invert them.

## Decision
- The colour system is tokenised as `:root` custom properties (`--chassis`, `--panel`, `--ink`, `--ok`, `--bad`, `--busy`, `--paused`, `--complete`, …), redefined explicitly under `[data-theme="dark"]` and `[data-theme="light"]`. Light values for every status colour were WCAG-checked rather than inverted. Hardcoded colours in `app.js` were moved into tokens.
- An inline `<head>` script sets `data-theme` from `localStorage`, else from `prefers-color-scheme`, before the stylesheet loads, so there is no flash of the wrong theme. The theme follows the OS live until the user makes an explicit choice.
- With User Access Management on, the choice is saved on the user record (`POST /api/session/theme`). It wins over the local guess and is mirrored back to `localStorage` for the next flash-free load.

## Alternatives considered
None recorded.

## Consequences
- Positive: one place per colour; theme travels with the account.
- Negative: every new colour must be added to both theme blocks (and, by convention, never hardcoded in JS).

## Evidence
- `public/style.css:5-47, 87` (token comments); `public/index.html:9-16` (pre-paint script).
- Commits `08dfad4`, `b13eefa`; RELEASE_NOTES 0.7.0 "Light and Dark Themes"; `0558e07` (themed scrollbars).

## Confidence
Stated.
