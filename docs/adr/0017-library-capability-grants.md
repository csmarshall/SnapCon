# ADR-0017: The Model Library authorises by capabilities stored in a grants table, not by roles in code

- **Status:** Accepted (retroactive)
- **Date:** 2026-09-30 (`97e3480`, Library M1)
- **Area:** Security / authorisation

## Context
The Library has finer-grained actions (edit cover, edit grouping, review, hide, manage sources, back up, diagnostics) than the app's three roles (ADR-0015), and the owner wanted "Permissions … refinable later without changing the data architecture" (D1).

## Decision
- Library routes check capabilities (`library.view`, `library.edit.grouping`, `library.sources.manage`, …), never roles.
- `permission_grants(subject_type, subject_id, capability, allow)` is seeded with role defaults: view, regular (view + edit), admin (+ sources, backup, diagnostics). `library.files.delete` exists but is granted to nobody (D2).
- Resolution is most-specific-wins: user row, then group rows (a group deny beats a group allow), then role row. No row means no. The implicit admin (UAM off) can do everything.
- Revoking a default writes `allow=0` and never deletes the row, because seeding is `INSERT OR IGNORE` and a deleted default would silently come back.

## Alternatives considered
Role checks as in the rest of the app (`requireRegular` / `requireAdmin`). Not chosen for the Library, so that finer control is "new rows, not new code or schema".

## Consequences
- Positive: per-user and per-group overrides become possible without code changes.
- Negative: two authorisation models coexist (roles app-wide, capabilities in the Library). No UI for grants is recorded in Phase 1a.

## Evidence
- `library/permissions.js:1-50`.
- `docs/library-design.md` §1 D1, D2, D11; §11 Permissions.

## Confidence
Stated.
