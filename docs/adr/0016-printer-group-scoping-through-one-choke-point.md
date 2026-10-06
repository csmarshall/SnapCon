# ADR-0016: Printer visibility is scoped by groups, decided by one function that every route must call

- **Status:** Accepted (retroactive)
- **Date:** 2026-08-08 (`e6b0cba`, 0.5.0); enforcement completed 2026-08-11 (`731aff9`)
- **Area:** Security / authorisation

## Context
Shared farms need users who only see some printers. The first rollout left 13 routes unguarded, including a fleet-wide maintenance-mode switch (0.7.0 "Security Fixes").

## Decision
- Printers carry `allowedGroups` and users carry `groupIds`. `groupAccess.printerVisibleTo(user, p)` is "the ONLY place" the fallback to the implicit `grp_everyone` group is applied. Admins, including the implicit admin, see everything.
- Every route that names a printer calls `printerVisibleTo`, and an invisible printer is answered as "Unknown printer" rather than 403.
- Pure membership logic lives in `groupAccess.js` so it can be unit-tested. Group CRUD and persistence stay in `server.js`.
- Downstream features inherit it: the Library filters print history by visible printers but shows aggregate counts to everyone (Library D6), and location errors are withheld from users who cannot see the folder (`63244b7`).

## Alternatives considered
None recorded.

## Consequences
- Positive: one definition of visibility; testable.
- Negative: enforcement is per route by convention. The 13-route gap shows that a missed call is a silent hole, and the only guard is review and tests.

## Evidence
- `groupAccess.js:1-35`.
- Commit `731aff9` "Enforce printer-group access control on 13 previously-unguarded routes (P0-2)".
- `server.js:2903-2905`, `1946`, `2132` (routes call `printerVisibleTo` and answer "Unknown printer").
- `docs/library-design.md` §1 D6, §17 R9.

## Confidence
Stated.
