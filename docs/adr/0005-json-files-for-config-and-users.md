# ADR-0005: Configuration and user accounts live in flat JSON files, kept separate, and a corrupt config is quarantined rather than replaced

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-07 for `config.json` (`4e293c3`); 2026-07-10 for the separate `users.json` (`20c633c`); 2026-08-11 for quarantine (`1f9a357`)
- **Area:** Persistence

## Context
Settings are edited live from the browser ("no restart needed") and must be human-editable and easy to back up. `GET /api/config` is reachable before login.

## Decision
- `config.json` (printers, folders, notification settings, groups, maintenance history) and `users.json` (accounts, password hashes, per-user theme/locale) are plain JSON under `BASE_DIR`, loaded into module-level `CFG` / `USERS` and rewritten whole on save.
- Users are kept out of `config.json` "so GET /api/config (still unauthenticated pre-login) can't leak password hashes or the Resend API key"; `publicCfg(role)` further strips secrets by role.
- `configLoader.js` distinguishes a legitimate first run (ENOENT → defaults, silent) from a failure (unreadable, invalid JSON, wrong top-level type). A failure is logged loudly, the original is renamed to `config.json.corrupt-<ts>`, and `CONFIG_LOAD_FAILED` blocks the startup migrations from saving defaults over it; an admin banner surfaces it.

## Alternatives considered
None recorded for the file format. The quarantine behaviour replaced a silent fallback-and-overwrite that destroyed every printer, user and credential (release notes 0.7.0 "Security Fixes").

## Consequences
- Positive: trivially inspectable and restorable; no schema migrations engine — migrations are small pure functions run at startup (ADR-0006).
- Negative: whole-file rewrites; no concurrency control beyond the single process; append-heavy or indexed data had to move to SQLite (ADR-0007) and queue state to its own atomic store (ADR-0008).
- Negative: Docker single-file bind mounts need the file pre-created (`touch users.json`), documented in `docker-compose.yml`.

## Evidence
- Commit `20c633c` body; `server.js:93-117` (`loadConfig`, CONFIG_LOAD_FAILED comment); `configLoader.js:1-14`.
- Commit `1f9a357` "Fix silent config.json corruption/data-loss on startup (P0-1)".
- `server.js:3667` `publicCfg(role)`.

## Confidence
Stated for the users split and the quarantine. Inferred for JSON-as-format being a deliberate choice.
