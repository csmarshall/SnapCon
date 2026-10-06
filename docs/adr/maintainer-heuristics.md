# SnapCon upstream maintainer heuristics (ezeitoun / Eran Zeitoun)

Sources: local history at /Users/charles/work/claude/SnapCon (`main` @ 3b9ba5f, 185 maintainer commits; fork commits by Claude / Charles Marshall excluded), upstream GitHub (2 PRs, 7 issues, 8 releases, no Discussions), RELEASE_NOTES.md, README.md, docs/review-and-planning.md, docs/library-design.md, docs/superpowers/specs/*, .archon/config.yaml, .gitignore, and comments in server.js, connectors/, audit/, test/. Line numbers for server.js refer to `main` (`git show main:server.js`).

Labels: **[STATED]** = the maintainer wrote it as a rule or rationale. **[INFERRED]** = a pattern observed across commits/code, not declared. **[THIN]** = one or two data points only.

---

## 1. How this maintainer thinks

Eran treats SnapCon as safety-critical equipment control, not a web app: a printer that is wrongly believed idle, a stop that claims success but does nothing, or a config file silently overwritten are the failures he fears most, so he defaults to **fail closed, never lie to the operator, never destroy user data**. He is evidence-driven to the point of ritual: hardware behaviour is "verified" on a named real printer and firmware version, performance is measured before building (Library M0 spike), and anything unverified ships labelled beta/untested with its limits stated in the release notes. He keeps the footprint tiny (one runtime dependency, express; Node built-ins for SQLite, fetch, zip, workers) because the app ships as `pkg` single binaries and a Docker image to non-technical farm operators. He works milestone by milestone against written specs that he personally approves ("OK to Dev"), writes long rationale into commit bodies and code comments (roughly a third of server.js lines are comments), and pins every fix with a test — often a source-text or vm-extracted test because server.js is a 6k-line monolith with no express harness. He is courteous but rigorous with outside contributions, rejects scanner-driven or scope-creeping patches with a detailed data-flow rebuttal, and tends to absorb good external ideas by reimplementing them himself rather than merging PRs. He appears to work AI-assisted (Claude Code + Archon, private CLAUDE.md and reviewer subagents), and his written review/planning guide reads like an instruction set for those agents.

---

## 2. Core principles

### P1. Fail closed; ambiguity means "no" [STATED]
- server.js@main:2331-2342 — `DISPATCH_IDLE_STATES` is "An ALLOWLIST on purpose ... a state we have not thought about, or one a future connector introduces, cannot silently authorise starting a job." FlashForge "busy" removed from idle "merely to preserve previous behavior" is rejected.
- 8a201dc "Refuse to start work on a faulted printer" (denylist → allowlist; firmware gate refuses `error` explicitly "rather than relying on the connector mapping").
- df2af92 "Fail closed on unknown FlashForge print-start state"; RELEASE_NOTES 0.7.0 "A Crashed Printer No Longer Looks Idle": "if in doubt, it waits rather than starting a job."
- **So when contributing:** gate on allowlists, treat unknown states/values as unsafe, and say in the comment what happens for a state nobody has thought of yet.

### P2. Never lie to the operator; truthful UI over convenient UI [STATED]
- 394cef5 "Stop offering an emergency stop FlashForge cannot perform" — the button is disabled with an explanation rather than offering a stop that "does not stop anything"; RELEASE_NOTES 0.7.0 "E-Stop No Longer Claims Success on FlashForge".
- 1e1615e / RELEASE_NOTES 0.8.0 "'Upload' now always means upload": "A setting that only sometimes does what its label says is the thing this replaces."
- b9ed7eb + RELEASE_NOTES "Printing a File Already on the Printer...": "Success is only reported when the print has really started, not when the request was accepted."
- **So when contributing:** a status, label or success message must be literally true; if a capability is missing, disable and explain rather than hide or fake.

### P3. Never destroy or silently overwrite user data [STATED]
- 1f9a357 (P0-1) configLoader.js: corrupt config is "quarantined aside with a timestamp, preserving its exact bytes"; startup migrations no longer write when the load failed.
- 97e3480 LibraryStore: corrupt DB "quarantined, never deleted"; pre-migration `VACUUM INTO` snapshot; unknown tables or newer schema "leave the file untouched".
- docs/library-design.md §1 D2 "No physical deletion, rename or move of files in Phase 1"; §18 rejects "destructive Rename / Move / Delete as normal Library behaviour"; c5a4d09 locales "never silently overwritten by an update".
- **So when contributing:** any write to user state needs a first-run vs failure distinction, an atomic write, and a quarantine-not-delete path on corruption.

### P4. Evidence before belief: verify on real hardware, measure before building [STATED]
- docs/superpowers/specs/2026-09-15-bambu-connector-beta-design.md §2: a table of every protocol fact marked "verified" / "one sample" against a named P2S + firmware; "one sample, not used as a rule".
- 4311c47 "Library M0 spike: measure before building"; cd006bc reports "max 85 ms and no request over 1 s, against 21 s stalls on 40 of 160 samples before".
- c00d0f6 "Confirmed live: auto-level ON gave bad Z"; 394cef5 "Verified on a real 5M Pro (firmware 5.1.7) three separate ways".
- **So when contributing:** put the evidence in the commit body — model, firmware, how it was observed, numbers — and distinguish verified from assumed.

### P5. Unverified features ship as beta with explicit limits [STATED]
- RELEASE_NOTES 0.7.1 "Bambu Lab Support (Beta)": "built and checked against one real printer ... Treat the first few prints as a test."
- RELEASE_NOTES 0.8.0 "Known limitations" and "Plate 1 was validated. Starting a plate other than 1 ... has not been tested yet ... It fails safely."
- Bambu spec §3.4: non-P2S models get an "Untested model" badge; "unverified features stay off".
- **So when contributing:** scope what you could not test, label it, and make the untested path fail safe.

### P6. Minimal dependencies; Node built-ins first [STATED]
- package.json: one runtime dependency (`express`), one dev (`@yao-pkg/pkg`).
- audit/AuditLog.js:1-7 "node:sqlite ... no added dependency — keeps this out of the native-addon packaging risk pkg cross-builds already hit once".
- docs/library-design.md D3 "No new dependency unless necessary. Result: none needed"; §10 "Covers and thumbnails (no dependency)"; 6fba8e6 "Node's built-in fetch, 10 s timeout, no new dependency"; 2d11e7a hand-written hardened zip reader; Bambu MQTT/FTPS/RTSP clients hand-written (connectors/bambu-mqtt.js, ftps-client.js, rtsp-client.js).
- **So when contributing:** assume a new npm dependency will be refused; if you truly need one, justify it against pkg cross-build and Docker size, and offer the built-in alternative you rejected.

### P7. Additive features must never block or crash the core (printing) [STATED]
- server.js@main:435-437 audit log "never blocks or crashes any request either way"; AuditLog.js degrades to no-op when node:sqlite is missing.
- 6fba8e6 updateCheck "It never throws"; RELEASE_NOTES 0.8.0 skip-identical-upload "The check can only ever skip work, never block it."
- cd006bc netfs: an unreachable NAS must not freeze the server; "The breaker never stands in for a file check".
- **So when contributing:** new subsystems (archive push, sync, notifications) must degrade to off with a log line, run off the request path, and be unable to fail a print.

### P8. Every fix gets a regression test that would have failed [STATED + INFERRED]
- test/versionConsistency.test.js header: "nothing failed ... nothing could"; the fix is "deliberately a test".
- test/docker.test.js derives the expected COPY list from server.js's require() graph "rather than hardcoding today's fix" (a derived, not hardcoded, detector).
- c00d0f6 "hiding a control is not the same as not running the command, and there is a test for exactly that"; bff5569 fixes a flaky test with a mock clock rather than loosening the assertion.
- **So when contributing:** include `node:test` tests in the same commit, explain in the test header what bug it pins and why this harness.

### P9. Local-first, privacy-minimal, secrets never return to the browser [STATED]
- README.md:9-30 "local-first", "Nothing needs to leave the local network unless Remote Access is explicitly enabled."
- RELEASE_NOTES 0.7.0 Discord: webhook URL "is effectively a password ... never comes back to the browser ... strips it out of error messages and logs"; 30a7862 access code moved to configured/replace/clear.
- 6fba8e6 update check "sends only Accept, a SnapCon/<version> User-Agent ... no token and nothing about the farm".
- **So when contributing:** anything that leaves the LAN is opt-in or justified; credentials are write-only from the UI and redacted from logs.

### P10. Security means a concrete exploit path, not a scanner hit [STATED]
- PR #8 close comment: "the finding is a false positive and the patch does something other than what it says ... silencing a scanner rather than changing what the code does ... If you find something with a concrete path from request input to the SQL text, please do open an issue with the trace."
- docs/review-and-planning.md: "Do not inflate severity", "CONFIRMED FROM CODE" vs "REQUIRES LIVE VERIFICATION".
- a7252b9 (P1-1) explains who could exploit it ("Any authenticated user, including the lowest 'view' role") and why `path.relative()` was chosen over `startsWith(folder + sep)`.
- **So when contributing:** security PRs need a source-to-sink trace, an attacker model, and no unrelated changes bundled.

### P11. Backward compatibility via silent, pure, idempotent startup migrations [STATED]
- server.js@main:146-300: a chain of "One-time migration" IIFEs, each backed by a pure module (queue/migratePrinterPool.js, connectors/migrateU1Connector.js, connectors/migratePrinterAddress.js); "a no-op once nothing names the old connector"; "Reported, never rewritten: a URL this migration can't take apart".
- 1d25abc: retired connector kept as live code; migration "moves only the connector string"; "Verified against a copy of a real 20-printer config".
- c5a4d09 i18n: "Additive `code`/param fields ... existing `reason`/`message`/`error` fields are unchanged for any other consumer".
- **So when contributing:** never require users to edit config; add a pure migration with tests, preserve ids verbatim, and keep old API fields when adding new ones. API-breaking changes get a "For anyone automating SnapCon" note (RELEASE_NOTES `/api/printfile`).

### P12. One place decides; centralise rules and derive the rest [STATED]
- 0020cf0 top bar: "One place decides which cells show (topbarVisibility())", "One place decides which cell is active".
- docs/library-design.md D15 "The Library contains no printer-detection logic of its own" (shared printer-identity resolver); 04ead35.
- a7252b9 replaced three duplicated jail checks with one pathSafety.js; 407a4af "extract the duplicated serialize() helper into a shared module".
- **So when contributing:** reuse the existing gate/resolver (e.g. safePath, printerVisibleTo, isPrinterIdle, uploadDisposition) rather than adding a parallel check.

### P13. Spec, milestone, owner approval — then build [STATED]
- docs/library-design.md header: "The owner approves each milestone before the next begins"; D16 "M4 ... is the hard checkpoint"; §21-31 "Mn results" written back into the spec after each milestone.
- Bambu spec "design approved section by section ... awaiting 'OK to Dev'".
- docs/review-and-planning.md planning standard: "verify the premise", "identify non-goals", "Is every planned change actually necessary? Remove unnecessary work".
- **So when contributing:** for anything bigger than a fix, open an issue with a short design (goal, non-goals, evidence, risks) and wait for a yes before sending code.

### P14. Ownership boundaries with printer firmware [STATED]
- c00d0f6 "the Creality print-start flow owns the Z reference for the print, and SnapCon must not inject a mesh calibration ahead of it."
- server.js@main:24 firmware flashing "lives outside the connector interface on purpose".
- 394cef5 UI gates on `capabilities.estop === false`, "never on truthiness".
- **So when contributing:** let the printer do what it owns; express connector differences through capabilities flags, defaulting to existing behaviour when absent.

---

## 3. Decision paths

- **Adding a dependency** → choose a Node built-in or a hand-written module, because pkg cross-builds already broke once on a native addon and the binary/Docker image must stay small (AuditLog.js:1-7; library-design D3; 6fba8e6). Even 3MF zip parsing, MQTT, FTPS and RTSP were hand-rolled. [STATED]
- **Persistence: SQLite vs JSON** → small config/state stays JSON (config.json, users.json, queue-data.json, data/update-check.json with atomic write); append-heavy or queryable data goes to `node:sqlite` in its own `*-data/` dir with WAL, degrade-to-no-op, versioned via `user_version`, backups, quarantine on corruption (audit/, sync/, library/; 97e3480). Because no added dependency and each store must be independently losable. [STATED for sqlite; INFERRED for the split rule]
- **Extracting from server.js** → extract when logic is pure, duplicated, or a whole new subsystem (configLoader.js, pathSafety.js, groupAccess.js, updateCheck.js, queue/, library/, netfs/), wired by one line in server.js and a `create*()` factory taking `baseDir`/injected deps; but routes and small gates stay in server.js and are tested by vm extraction (033412a explicitly accepts that "standing cost"). No big-bang refactor of server.js has ever happened. [INFERRED, with 033412a STATED on the harness]
- **Security fix** → labelled by severity (P0-1, P1-1 ... in 1f9a357, a7252b9, 731aff9, 394ef09, ba0e95d), one issue per commit, body states the exploit scenario, who can reach it, why this fix over alternatives, and which callers benefit transitively; release notes get a plain-English "Security Fixes" section recommending upgrade. Scanner-only findings are rejected (PR #8). [STATED]
- **UI / i18n** → vanilla JS, theming via CSS tokens (`--tb-*` aliased to core tokens, 0020cf0), every string through `t()` with English fallback, "never a raw key or a broken screen" (c5a4d09); server errors carry a stable `code` so the client translates without parsing prose; third-party reference text (Snapmaker error catalog) is not translated. Known limitation accepted: existing locale files are not overwritten on upgrade. [STATED]
- **New printer brand / connector** → one file plus one REGISTRY line (connectors/index.js:1-3 "nothing else in the app should need to change"), capabilities flags for anything unsupported, connector core methods enforced by test (test/connectorCoreMethods.test.js; 30a7862 "every registered connector is checked to implement the whole control" surface), a real-hardware capture as a test fixture (test/fixtures/bambu-p2s-report.js), a probe tool (bambu-probe.js), and a hardware-compatibility wizard (b5af0b2). Ships as beta. No AGPL/GPL code copied; protocol facts only (Bambu spec §3.5-3.6; library-design R13). [STATED]
- **Testing approach** → `node --test`, no frameworks; fakes for protocols (test/helpers/fakeBambuBroker.js, fakeFtpsServer.js, fakeRtspCamera.js, mockU1.js); server.js internals extracted into a `vm` sandbox (38 tests) or asserted as source text (43 tests read server.js) "because no express harness exists"; static checks over Dockerfile, versions and the require() graph. A plain source-text assertion is used where it is "proportionate" (test/i18n-closure.test.js header), otherwise behaviour is executed. [STATED]
- **Packaging (pkg / Docker)** → every new top-level module must be added to the Dockerfile COPY list (test/docker.test.js fails otherwise) and worker entry points to `pkg.scripts` (library-design P5); version literals stay hardcoded in several places but are pinned by test rather than derived, because the browser and pkg snapshot paths cannot read package.json the same way (versionConsistency.test.js). [STATED]
- **Defaults: opt-in vs opt-out** → anything that changes what a click does or reaches outside the LAN starts OFF (usersEnabled off by default per a7252b9; Remote Access "explicitly enabled"; "Upload into queue" off). Pure safety/efficiency improvements start ON (skip identical upload, overwrite-when-differs to preserve existing workflows, update check — justified by minimal payload and a visible switch). Behaviour-changing defaults get a bold "If you use X, read this one" in release notes. [INFERRED from several cases, rationale STATED per case]
- **Backwards compat / migrations** → silent startup migration, pure function, idempotent, ids preserved, old module kept as delegate (P11). When a fix cannot repair old data, say so in release notes ("Items added before this fix still carry only the name; if one fails as missing, remove it and queue the file again"). [STATED]
- **Error handling** → background work never throws into the app (updateCheck, audit, webhooks), printer commands get timeouts with longer allowances for slow ops (ba0e95d), unreachable storage returns 503 fast via a breaker (cd006bc), and a leaked guard is treated as worse than the bug (033412a: every path goes through a `finally`). For the print path itself the inverse holds: refuse loudly before sending if anything is unconfirmed ("A changed file is refused rather than printed", 0.8.0). [STATED]
- **Contributor PR with good ideas** → engage, offer the maintainer's own version for testing, then reimplement, possibly reusing parts. PR #9 (6k lines, Bambu monitoring) was closed by its author; the Bambu spec §3.6 says "reuse PR #9's monitoring parts ... No credits/outreach (user's decision)", while RELEASE_NOTES 0.7.1 and connectors/bambu-lab.js:304 do mention PR #9. [STATED in spec; THIN — one case]
- **Feature requests (issues)** → implemented quickly by the maintainer, answered with a bullet list of what was done (often broader than asked, plus guardrails such as the /20 scan floor in issue #2) and the target release. [STATED in issue comments #1, #2, #7]

---

## 4. Style conventions

- **Commit subjects:** plain-English, outcome-focused sentences, no conventional-commit prefixes (1 of 185 uses `fix(creality):`). Typical forms: imperative behaviour change ("Stop one unreachable printer hanging the whole Firmware tab", "Refuse to start work on a faulted printer"), or "Subsystem: outcome" for long-running work ("Library M5: the Library UI — ...", "Remote Access: ..."). Median subject 59 chars. Docs commits are "Document X" / "Record Mn results in the Library specification". Releases are "SnapCon 0.8.0" / "Release notes for ...".
- **Commit bodies:** long, wrapped at ~72-80 cols, explaining the bug mechanism, the exact window or condition, alternatives considered and rejected, what deliberately did NOT change, and how it was verified (hardware, numbers). Severity tags like "(P0-1)" for audit findings. No Co-Authored-By trailers (0 found).
- **Commit/PR size:** average ~6 files and ~570 insertions per commit; 27 commits exceed 1,000 insertions. Features are one coherent commit each, with separate commits for server/UI halves (6fba8e6 / 3b9ba5f) or for docs. Supporting fixes may ride along but are called out as "Supporting fixes, each independently useful" (30a7862). Early history (July) had "Accumulated ... work" dumps; later history is disciplined. He commits straight to main; only one merge commit exists (c8f93ad), no PR flow of his own.
- **Comments:** heavy, explanatory, history-aware. File header `// path/file.js — what it is`, then why. Use of "deliberately", "on purpose", "NOT" in caps for emphasis, references to docs/TODO.md item numbers and spec sections. Comments state what happens in the bad case.
- **Naming:** camelCase functions that read as predicates/decisions (`isPrinterIdle`, `uploadDisposition`, `firmwareDeployBlockedBy`, `assertNotActiveJobFile`, `withStartSequence`); `create*()` factories for modules; PascalCase class-like modules in subsystem dirs (QueueStore.js, LibraryService.js, WorkerHost.js); kebab-case connector files (creality-klipper.js); domain vocabulary is defined once (library-design "Canonical terminology") and used consistently.
- **File layout:** server.js monolith + top-level single-purpose modules; subsystem dirs (queue/, audit/, sync/, library/, netfs/, remote-access/, connectors/); runtime data in gitignored `*-data/` dirs; tests mirror under test/ with `*.test.js`; specs in docs/ and docs/superpowers/specs/; private working files gitignored (CLAUDE.md, docs/TODO.md, CODE_AUDIT.md, CODE_REVIEW.md, SECURITY_REVIEW.md, .claude/).
- **Release notes:** user-facing, plain English, headed by outcome ("A Crashed Printer No Longer Looks Idle"), bold lead bullets, explicit defaults, "Known limitations", and a short "For anyone automating SnapCon" note when the API changes. British spelling throughout ("behaviour", "colour", "normalisation").
- **Prose on GitHub:** courteous, precise, structured with bold mini-headings (PR #8 close comment).

---

## 5. Things they reject or avoid

- **Scanner-driven "hardening" that does not change behaviour** — PR #8 closed: template literal → concatenation is "behaviourally identical"; "silencing a scanner rather than changing what the code does". [STATED]
- **Unrelated changes bundled into a PR** — PR #8: the path-resolution rewrite "isn't mentioned in the description, and contradicts the 'scoped to 1 file' claims". [STATED]
- **Changes that make a security/safety feature less reliable** — PR #8: new throw sites would "silently disable audit logging". [STATED]
- **New dependencies** — none added after the initial commit besides dev tooling (package.json history). [INFERRED, strong]
- **Copying GPL/AGPL code** — Bambu spec §3.5 ("Nothing copied from BambuStudio's AGPL-3.0 tables (SnapCon is MIT)"); library-design R13. [STATED]
- **Guessing values the printer does not clearly report** — 30a7862 "no chamber temperature, no time remaining (its unit is unconfirmed), no fan percentage" (added later in 942de99 once confirmed). [STATED]
- **Folder-name or filename heuristics treated as truth** — library-design "Folders lie", D7/D10 filename matches never counted as confirmed. [STATED]
- **Preserving old behaviour just because it existed** — 8a201dc removes FlashForge "busy" from idle "on purpose". [STATED]
- **Destructive file operations as normal features** — library-design D2, §18. [STATED]
- **Deleting working code that is merely unused on one path** — c00d0f6 keeps `sendG29WithRecovery()`; 1d25abc keeps the retired connector as a delegate. [STATED]
- **Rewrites of the monolith** — no evidence of an express test harness or a server.js split being accepted; he explicitly lives with vm extraction (033412a). [INFERRED]
- **Reverts:** no revert commits on main (`git log --grep=revert` only hits Library feature commits that mention undo/revert in their bodies). [INFERRED — no data]

---

## 6. How to get a PR accepted upstream (checklist)

1. **Open an issue first** for anything beyond a small fix; include goal, non-goals, evidence and a short design. Wait for his go-ahead (he approves designs before code, and he may well build it himself).
2. **One concern per PR.** No drive-by refactors, formatting, or "while I was here" changes; if a supporting fix is needed, name it as such in the body.
3. **Zero new runtime dependencies.** Use Node built-ins; respect the `node >=22.5` engine and pkg/Docker constraints.
4. **Fail closed and never block a print.** New features degrade to off with a log line; safety gates use allowlists; nothing additive can fail the print path.
5. **Tests in the same commit** with `node --test`, following the house harness (vm extraction or source-text for server.js internals, fakes for protocols), with a header comment naming the bug it pins.
6. **Update packaging:** Dockerfile COPY list for new top-level modules/dirs (docker.test.js will fail otherwise), `pkg.assets`/`pkg.scripts` for new assets/workers, gitignored `*-data/` dir for new runtime state.
7. **Backwards compatible by default:** new settings default to today's behaviour (opt-in), config changes ship with a pure idempotent startup migration, API changes are additive.
8. **Evidence in the body:** real hardware/firmware, numbers, what was verified vs assumed; label anything untested.
9. **Match his voice:** plain-English outcome subject (no `feat:`/`ci:` prefixes), long explanatory body, British spelling, a RELEASE_NOTES.md-style paragraph he can paste; UI strings through `t()` with en.json keys.
10. **Strip fork artefacts:** no CLAUDE.md, session-state.md, TOOLS-INSTALLED.md, or other files he gitignores or does not use; do not assume he wants CI added.

---

## 7. Confidence notes

- **Strong, STATED:** fail-closed, honesty in UI, no data destruction, minimal dependencies, hardware evidence, beta labelling, migrations, test-per-fix, security-needs-a-trace. Each has multiple explicit statements in commits, comments, specs or release notes.
- **INFERRED, moderate:** the opt-in/opt-out rule (consistent across ~6 settings but never stated as a rule); when to extract from server.js; commit-size norms; British spelling as a convention.
- **THIN:** how he treats external PRs. Only 2 PRs exist and neither was merged — one was a bot-like scanner PR he rejected, the other was closed by its own author after he offered his own beta. There is **no example of an accepted external PR**, so his merge criteria are extrapolated from his own commits and docs/review-and-planning.md. The "reimplement rather than merge" pattern rests on PR #9 alone, plus the issue history (all three feature requests were implemented by him, not contributors).
- **THIN:** stance on CI. Upstream has no GitHub Actions; nothing says whether he would welcome one. The fork's `6aea0d7 ci: run npm test ...` is untested against his preferences.
- **INFERRED, worth knowing:** he works AI-assisted. `.archon/config.yaml` copies a gitignored CLAUDE.md ("project engineering rules"), docs/TODO.md and `.claude` ("project subagents (backend/connector/frontend/security/test reviewers) + skills") into worktrees; docs/review-and-planning.md reads as agent instructions ("When using parallel reviewers/subagents, their findings are leads"). His private engineering rules (CLAUDE.md, docs/TODO.md, CODE_AUDIT.md) are not public, so some of his conventions are invisible to us.
- **Caveat on evidence source:** docs/review-and-planning.md was added in c609723 (2026-10-04) and may be partly agent-authored; it is still committed by him and consistent with his commit bodies, so it is treated as STATED.
- **Line numbers** are for `main` @ 3b9ba5f; the fork branch `feature/replay-archive` adds lines to server.js, so numbers there differ.
