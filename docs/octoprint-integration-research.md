# OctoPrint local integration — research notes

Status: **research only, no connector implementation yet.** Companion to the Bambu/Prusa
research docs — groundwork for an eventual `connectors/octoprint.js`. Prompted by two
independent projects (`print-farm-manager`, `Mirdain_printer_manager`) both supporting
OctoPrint as a brand. Nothing here has been verified against a live OctoPrint instance; per
CLAUDE.md Section 2, confirm against real device/instance behavior before relying on any of
this in code.

Unlike Bambu, OctoPrint has a **complete, official REST API spec** (docs.octoprint.org) — this
doc is sourced primarily from there, cross-checked against two real third-party
implementations rather than triangulated from secondary sources the way the Bambu doc had to
be.

## 1. What OctoPrint is, and why it's a different kind of "brand"

OctoPrint isn't a printer brand — it's third-party control software (typically running on a
Raspberry Pi attached to the printer's USB/serial port) that sits in front of **any** printer
speaking standard G-code over serial. A SnapCon "OctoPrint connector" would therefore be
targeting one specific control layer that can front an open-ended range of actual hardware,
conceptually closer to how `klipper-moonraker.js` targets generic Moonraker instances than to
a single-vendor connector like the FlashForge ones. Capability differences (camera, filament
sensors, multi-extruder) would come from the underlying printer/its OctoPrint plugins, not from
OctoPrint itself — the connector can't assume a fixed hardware capability set the way
brand-specific connectors do.

## 2. Transport & auth

Pure HTTP/REST, default port **5000** (both third-party drivers note it's non-standard vs. 80 —
worth surfacing as a per-printer configurable port in Settings, not hardcoded).

- **Auth**: single scheme, `X-Api-Key: {key}` header — simpler than Prusa's two-generation
  split and far simpler than Bambu's TLS+SNI+shared-credential setup. No digest auth involved.
- A separate `X-OctoPrint-Api-Version` header exists for API version negotiation — unrelated to
  auth, not required for basic use.

## 3. Key endpoints

- `GET /api/version` — server/API version info.
- `GET /api/printer` — printer state flags (`operational`, `printing`, `paused`, `error`,
  `closedOrError`, etc.) plus `temperature` (per-tool and `bed`, each with `actual`/`target`).
- `GET /api/job` — combined job info in one call:
  ```json
  {
    "job": { "file": {...}, "estimatedPrintTime": 8811, "filament": {...} },
    "progress": { "completion": 0.23, "filepos": 337942, "printTime": 276, "printTimeLeft": 912 },
    "state": "Printing"
  }
  ```
- `POST /api/job` — job control via a `command` body: `start`, `cancel`, `restart` (only while
  paused), and `pause` with `action: pause|resume|toggle` (`toggle` is the default if `action`
  is omitted, kept for backwards compatibility). All succeed with `204 No Content`; `cancel`
  with nothing running returns `409 Conflict`.
- `POST /api/files/{location}` — upload, `multipart/form-data`, fields: `file`, `path`
  (target dir), `select` (bool, select after upload), `print` (bool, start immediately),
  `userdata`. Response echoes `effectiveSelect`/`effectivePrint` — these can come back `false`
  even on a 201 if the printer wasn't operational or another job was active, so a connector
  must check them rather than assuming upload success implies select/print success.
- `POST /api/files/{location}/{path}` — file commands, e.g. `{"command":"select","print":true}`
  → `204`, or `409` if the printer isn't operational.
- `GET /api/files[/{location}]` — listing, `?recursive=true` supported, response includes
  `free` disk space.
- Endpoints require `STATUS` permission for reads, `PRINT` permission for job-control writes —
  OctoPrint's permission model is more granular than a single API key implies; the key's
  associated user/permissions matter.

## 4. Camera / snapshot

**Not part of the core job/printer API** — camera config is separate, under
`GET /api/settings`: `webcam.streamUrl` and `webcam.snapshotUrl` (mapping to `webcam.stream`/
`webcam.snapshot` in `config.yaml`). A connector needs a second call to `/api/settings` to
discover these URLs before it can offer camera support — and **both third-party drivers
inspected here skip camera entirely** (`camera: false` in Mirdain's capabilities; not
implemented at all in print-farm-manager's `octoprint.js`), which is a real signal this is
more fiddly than it looks — likely because `streamUrl`/`snapshotUrl` are only meaningful if the
instance actually has the bundled webcam plugin configured, and the value may be a relative
path needing resolution against the instance's own host rather than a ready-to-use absolute
URL. Needs live verification against a real instance before assuming a shape.

## 5. Completion detection — the one real landmine here

This is the most important finding in this doc, and it shows up independently in **both**
third-party implementations, which is exactly the kind of "existing behavior is evidence" (and
the exact opposite failure mode) worth taking seriously:

- **OctoPrint has no persistent "job finished" state.** `/api/job`'s `state` string and
  `/api/printer`'s flags don't reliably distinguish "just finished successfully" from "was
  cancelled/errored moments ago" when read via plain polling.
- OctoPrint's own community forum has open threads about the `PrintDone` **event** (available
  via the real-time push/WebSocket API, not the polled REST API) not firing reliably in some
  setups either — so even the "better" mechanism isn't fully trustworthy on its own.
- **Mirdain's mitigation**: never trust a bare polled snapshot for completion — its code
  comment states outright *"Never release a bed from this ambiguous snapshot"* — and
  `job_outcome` is always `None` from the OctoPrint adapter's polling path (their README's
  mention of OctoPrint supporting "manual completion recording" is presumably the actual
  resolution path for this ambiguity, not the poller).
- **print-farm-manager's mitigation**: a heuristic — `flags.operational && hasJobFile &&
  completion === 100` — fires "finished," and relies on the condition naturally clearing once
  a new job starts so it only fires once per job. Pragmatic, but a heuristic, not a guarantee.
- **OctoPrint's actual push API** (`docs.octoprint.org/en/main/api/push.html`) delivers
  updates over WebSocket roughly twice a second and does carry distinct event types — the
  "correct" fix is almost certainly consuming that stream for completion events rather than
  polling `/api/job`, but that's a materially different integration shape (persistent WS
  connection per printer) than every other SnapCon connector currently uses (`http-utils.js`
  polling), and is a real architectural decision to make deliberately, not default into.

This directly parallels a caution already in SnapCon's own domain: `connectors/http-utils.js`
and the U1 connector already have to reason carefully about state-transition ambiguity per
CLAUDE.md Section 3's "inconsistent state vocabulary" / "reconnect/state problems" callouts —
this isn't a new category of problem, just a specific instance of it that two independent
third parties both hit and solved differently, neither fully satisfyingly.

## 6. Reference implementations consulted

- **Official docs** (`docs.octoprint.org`) — `api/job.html`, `api/files.html`,
  `api/settings.html`, `api/push.html` — authoritative source for Sections 2–4.
- **Mirdain_printer_manager** (`backend/app/adapters.py`, `OctoPrintAdapter`) — Python/FastAPI,
  confirms endpoint choices and contributes the completion-detection caution in Section 5.
- **print-farm-manager** (`server/drivers/octoprint.js`) — Node/Express, confirms the same
  endpoints independently and contributes the alternate completion heuristic plus an
  `UPLOAD_CONFLICT` (409-on-upload-during-print) handling note and a `checkIfPrinting` helper
  for upload-timeout edge cases where the file may have actually been received despite a
  client-side timeout.

## 7. Open questions before any connector work starts

- Resolve the camera/snapshot URL question concretely against a real OctoPrint instance —
  confirm whether `webcam.snapshotUrl` is absolute or needs resolving against the instance
  host, and whether it's reliably populated without extra plugin configuration.
- Decide polling vs. WebSocket push for completion detection — this is a bigger design call
  than it looks (persistent connection lifecycle, reconnect behavior, fits/doesn't fit
  SnapCon's existing poll-loop architecture) and deserves its own scoped discussion rather than
  being decided as a side effect of writing the connector.
- Confirm what capability set an OctoPrint connector can honestly claim given that the
  underlying hardware is unknown/variable — likely needs to default conservatively (most
  capabilities `false`) rather than assuming feature parity with any specific brand connector.
- Confirm the API-key's associated permission scope (`STATUS`/`PRINT`/others) is something
  SnapCon's Settings UI needs to communicate to the user, similar to how secrets are handled
  today (CLAUDE.md Section 5, masked-secret control) — an under-permissioned key would fail
  silently-ish at the job-control step, not at connection time.
- Same per-brand-connector-file question as the other two docs: OctoPrint's genuinely different
  nature (control-layer-over-arbitrary-hardware vs. a fixed printer brand) is itself an argument
  for its own connector file rather than folding it into any existing one.

Sources:
- [OctoPrint REST API — job](https://docs.octoprint.org/en/main/api/job.html)
- [OctoPrint REST API — files](https://docs.octoprint.org/en/main/api/files.html)
- [OctoPrint REST API — settings](https://docs.octoprint.org/en/main/api/settings.html)
- [OctoPrint REST API — push updates](https://docs.octoprint.org/en/main/api/push.html)
- [Mirdain_printer_manager](https://github.com/hbaig2021/Mirdain_printer_manager) — `backend/app/adapters.py`, `OctoPrintAdapter`
- [print-farm-manager](https://github.com/joeltelling/print-farm-manager) — `server/drivers/octoprint.js`
