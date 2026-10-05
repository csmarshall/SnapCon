# CLAUDE.md — context for working on this fork

This is a fork of SnapCon (MIT, https://github.com/ezeitoun/SnapCon), a local-first fleet manager built mainly for
Snapmaker U1 printers. Node 22 + Express, vanilla JS front end, no build step except `pkg`.
Run: `npm start`. Tests: `npm test` (node:test; ~2,000 tests, ~2 min). Config: `config.json` (see `config.example.json`).

**Delete this file (and `HANDOFF` notes below) before opening any pull request upstream.**

## What the owner is trying to build

Charles runs a U1 at home and wants a family/multi-user setup where nobody has to juggle files or remember slicer
settings. The goal, in his words: a **replay library**. Anything a person prints is saved automatically (no separate
"save" step) into a separate storage dir, so a print can be replayed later, and a new print can be made from an
old one and saved as a **tweak** of it. The slicer settings must be extractable from the saved files so he can see
"what did we use three months ago?" in a web UI.

Intended flow: **user → Orca → SnapCon → printer**. SnapCon sits in the middle, is the one client the printer sees,
and records everything that passes through. (Snapmaker Orca's own LAN connection appears to use a separate MQTT
channel with an approve-on-the-printer handover, which a Moonraker proxy cannot intercept; that is why the plan goes
through vanilla Orca and SnapCon's Orca plugin / CLI hook instead. This is unverified on real hardware.)

## What is already done (branch `feature/replay-archive`)

- `archivePush.js` — saves one copy of every slicer push to
  `<replayFolder>/<user>/<YYYY-MM-DD>/<file name>`. Exclusive create (never overwrites); identical bytes are kept once
  (size check, then sha256); same name with different bytes gets an 8-char hash suffix; user labels and file names are
  sanitised so nothing escapes the folder. It never throws — a failed archive must never block a print.
- `server.js` — `/api/notify-load` (the raw-bytes branch used by the `--snapcon` CLI hook and the Orca plugin) calls
  `archivePush()` after the temp file is written and before the temp file is handed to `uploadNotifiedFile()` (which
  deletes it). Gated by `CFG.archivePushes !== false`. Writes an audit-log entry, event `file-archived`.
- Config: `archivePushes` (default true) and `replayFolder` (default `<gcodeFolder>/Archive`, which the Model Library
  already indexes). Documented in the README and `config.example.json`. `archivePush.js` is added to the Dockerfile COPY
  line (a test enforces this for every new top-level module).
- `test/archivePush.test.js` — 10 tests, all passing.

Not yet verified against a real U1 or a real Orca push. Two pre-existing failures also fail on a clean checkout:
`test/library/printService.test.js` and `test/library/routes.test.js` (not caused by this work — confirm on your machine).

## What is NOT done yet (suggested order)

1. **Replay view in the web UI.** List archived prints per user/date with the model name, printer, and extracted
   settings; allow "Send again" through the existing Send / Queue dialogs. Reuse the Model Library rather than building
   a parallel index: `library/gcodeExtract.js` already reads the slicer config block from sliced G-code
   (`parser._internal.matchCfgLine`, `CONFIG_BLOCK_START`) and `library/threemfExtract.js` reads
   `Metadata/project_settings.config` from a 3MF. Today they surface only layer height, nozzle and filaments.
2. **Settings viewer and diff.** Show the full set of settings of a saved print (key/value, searchable) and a diff
   between two saved prints. The settings are inside the files themselves — no sidecar is required.
3. **Tweaks.** A saved print can record `based_on` another saved print (by sha256). Decide whether this lives in the
   Library's Decisions/Claims model (see `docs/library-design.md`) or in a small sidecar next to the archived file.
4. **Opt-in checkbox.** The owner asked for a checkbox. Slicer pushes have no dialog, so the current switch is global
   (`archivePushes`). Options: a per-user setting, or a checkbox in the Send dialog for UI-initiated sends plus a
   `--archive` flag on the CLI hook. UI sends (`/api/print`, `/api/printfile`) do not archive yet.
5. **Capture the editable project (3MF), not just the sliced file.** A slicer push only carries the sliced file.
   One-time setup, not per-print: point Orca's project folder at a synced share that the Library indexes.

## Conventions in this repo worth following

- Look at how a neighbouring feature is built before writing new code. `audit/`, `sync/`, `queue/`, `library/` each
  own a directory and a small service object that `server.js` talks to.
- All file access that can touch a network share goes through `netfs` (it handles a share going offline). Use
  `netfs.writeFileExclusive`, `netfs.stat`, `netfs.readFile`, `netfs.mkdir`.
- Many tests read `server.js` as text and assert on route structure (`test/fileTypeCompatibility.test.js` is an
  example). Keep new routes greppable (`app.post("/api/...")`) and add a test for each behaviour.
- Audit events use `auditLog.log({ category, event, ...actor, printerId, printerName, detail })`.
- Roles are `admin`, `regular`, `view` — enforced in the UI and the API (`requireAuth`, `requireRegular`, `requireAdmin`).
- Log with timestamps, and put useful variable state in debug-level messages. Never log secrets.

## The owner's preferences

Charles is a staff-level SRE: skip the basics, explain decisions, state what is unverified, and keep explanations
short. He wants to review the work as diffs in a terminal, one piece at a time. Please complete implementations in
full (no "implement X here" stubs), and tell him when something has not been tested on real hardware.

## Related findings from earlier research

- U1 runs Klipper with Snapmaker's modified Moonraker (port 7125, `trusted_clients` allowlist in `moonraker.conf`).
- Orca's G-code output embeds the full slicer settings in a config block near the end of the file; a 3MF project
  carries them in `Metadata/project_settings.config` (JSON). Both are real files he has used, e.g. `Harper.3mf`.
- Snapmaker's Full Spectrum filaments are semi-translucent (TD: cyan 5.5, magenta 5.5, yellow 9.5, gray 6.5).
  Not needed for this work — mentioned only because SnapCon flags Full Spectrum files with an "FS" badge.
