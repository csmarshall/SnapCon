# ADR-0015: User Access Management is opt-in; when off, every request is an implicit admin; when on, three roles with password or OTP login and in-memory sessions

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-10 (`20c633c`, shipped 0.1.0); Telegram OTP added 2026-07-26 (`5919038`, 0.4.1)
- **Area:** Security / authentication

## Context
Many installs are a single operator on a trusted LAN, and existing users must not be locked out by an upgrade. Shared farms need per-person control.

## Decision
- Off by default. With `CFG.usersEnabled` unset, `makeAuthMiddleware` sets `req.user = { role: "admin", implicit: true }` on every `/api` request. "That is the entire back-compat story." Routes layer `requireAuth` / `requireRegular` / `requireAdmin` on top.
- Three roles: `view` (read-only), `regular` (operate printers), `admin` (settings, users, remote access, firmware).
- Passwords are hashed with async scrypt (N=16384, r=8, p=1), stored as a self-describing string. It is async so login cannot stall the 2-second fleet poll for other users.
- Optional per-user OTP login: 8 characters from an alphabet without 0/O/1/I, 10-minute TTL, 5 attempts, delivered by email (Resend), ntfy.sh, or Telegram. An OTP-enabled account cannot log in with a password.
- Sessions are an in-memory `Map` behind an `sc_session` cookie with an ~18-hour sliding idle timeout. A restart logs everyone out.
- Enabling with zero users is refused server-side.

## Alternatives considered
"a single shared password as the security model" is listed as rejected in the Library spec's u1hub comparison (§18).

## Consequences
- Positive: zero friction for single-user installs; no dependency (hand-rolled cookie parsing).
- Negative: the implicit-admin mode means any LAN client is admin. That is acceptable only on a trusted LAN, and is why the tunnel-forwarded-localhost problem (ADR-0019) mattered.
- Negative: in-memory sessions don't survive restarts.
- Role checks were later complemented by group scoping (ADR-0016) and by Library capabilities (ADR-0017).

## Evidence
- `auth.js:1-3, 5-21, 77-111, 125-158`.
- Commit `20c633c` body; RELEASE_NOTES 0.1.0 "User Management", 0.4.1 "Telegram OTP Login".
- `server.js:418-423` (middleware comment).

## Confidence
Stated.
