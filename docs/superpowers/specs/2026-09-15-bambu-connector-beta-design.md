# Bambu Lab connector (beta) — design

Date: 2026-09-15. Status: design approved section by section; pre-development review against the
codebase applied (§15); awaiting "OK to Dev". Backlog/evidence trail: `docs/TODO.md` §13.

## 1. Goal and scope

Add Bambu Lab printers to SnapCon as a **beta** connector with **full control**: monitoring,
AMS trays, errors/prompts, `.3mf` upload, print start with AMS mapping, pause/resume/cancel, bed
temperature, and live camera.

**In the beta:** any Bambu model can be added (one connector); only the P2S is verified. One AMS
unit (4 trays) for printing; the external spool is shown but not selectable for printing until its
protocol is verified. Camera live view.

**Not in the beta:** Queue Management for Bambu printers (and pools), more than one AMS unit (or
AMS HT), printing files already on the printer's storage, SSDP discovery, FTPS file sync, HMS
alert list, E-Stop, Eject.

## 2. Evidence this design rests on

All from a real **Bambu Lab P2S, firmware 01.02.00.00, AMS 2 Pro**, 2026-09-15 (reports in
`Desktop\bambu-probe\bambu-report-2026-09-15-*.json`; details in TODO §13).

| Fact | Status |
|---|---|
| MQTT over TLS on 8883, user `bblp` + access code; TLS 1.3 negotiated | verified |
| Topics `device/<SERIAL>/report` and `/request`; **serial is case-sensitive, upper-case** | verified |
| `pushall` returns a full ~98-key status; ~1 message/s even idle | verified |
| Classic flat fields present: `gcode_state`, `mc_percent`, `mc_remaining_time`, `nozzle_temper`, `bed_temper`, `layer_num`, `total_layer_num`, `subtask_name`, `spd_mag`, `ams`, `print_error`, `hms`, `ipcam`, `lights_report`, `fun`; plus a newer `device.*` tree | verified |
| No `chamber_temper` field | verified |
| Many numbers arrive as strings | verified |
| Report topic also carries the printer's own `gcode_line`/`ledctrl` replies and other clients' replies | verified |
| `print.*` commands (incl. `stop`) are refused `result:"failed", reason:"mqtt message verify failed"` unless **Developer Mode** is on; `system.ledctrl` and `info.get_version` work without it | verified |
| With Developer Mode: `project_file` start and `stop` → `result/reason "SUCCESS"` (~0.5 s); `ledctrl` replies lower-case `"success"` | verified |
| Progression: `FINISH` → `RUNNING` (+3.4 s, `print_type` cloud→local) → self-`PAUSE` with `print_error` 0x0500803C → after `stop`: `FAILED` with `print_error` 0x0300400C | verified |
| 0x0500803C = nozzle setting does not match the slicing file (confirm-to-continue prompt); 0x0300400C = task cancelled | verified (BambuStudio tables, forum) |
| `fun` bit 0x20000000 set while control was refused, cleared after enabling Developer Mode | one sample |
| `get_version` lists modules: `ota` `product_name` "Bambu Lab P2S", firmware, AMS 2 Pro, buffer, exhaust fan | verified |
| TLS certs: CN = serial, issuer "BBL Device CA N7-V2", no SAN, not self-signed. "N7" matches the P2S file's `printer_model_id` — one sample, not used as a rule (§8) | verified |
| Implicit FTPS on 990: login, LIST, STOR (150 then 226), SIZE, DELE work without Developer Mode | verified |
| `STOR` to an existing name replaces it (the same `.3mf` uploaded 3×, 226 and matching `SIZE` each time) | verified |
| Printer storage holds sliced `.3mf` files; `/cache`, `/timelapse`, `/model` exist | verified |
| Camera: RTSPS on 322, Digest auth `bblp` + access code, LIVE555, one `H264/90000` track, `packetization-mode=1`, High profile L4.1, ~1 Mbit/s | verified (DESCRIBE only) |
| Sliced `.3mf` holds `Metadata/plate_N.gcode`, `slice_info.config` (`printer_model_id` N7, nozzle, filaments with type/colour/`tray_info_idx`), `plate_N.png` | verified |
| Every project `.3mf` checked — sliced or not — names its printer in `Metadata/project_settings.config` (`printer_model`, `printer_settings_id`): Bambu Lab A1, Creality Ender-3 V3 KE, Snapmaker U1, Anycubic Kobra 3, Flashforge AD5X (6 downloaded files) | verified |

## 3. Decisions

1. **File intake:** Bambu jobs are `.3mf` files in the existing gcode library. Sliced-ness is
   decided by content (`Metadata/plate_N.gcode` present), never by name. Each file is offered only
   to printers that can print it. `.3mf` is also the FlashForge AD5X multi-material format that the
   library already accepts today (server.js:473-476); the AD5X is set aside for this beta, so
   every non-Bambu `.3mf` behaves exactly as today (§8).
2. **Filament mapping:** automatic match (material, then closest colour) shown in the Send dialog
   with a per-filament override picker (AMS trays; the external spool joins the picker only after
   its protocol is verified — §7); sending blocked while a filament has no tray of its material.
3. **E-Stop disabled** on Bambu (`capabilities.estop:false`, title points to Cancel). Eject likewise
   disabled.
4. **Any Bambu model accepted;** non-P2S shows an "Untested model" badge; unknown/unverified values
   show as unavailable, unverified features stay off.
5. **Error text:** SnapCon-authored wording only for the codes the beta acts on; every other code
   shown as `0500-803C` with a "Look up this code" link to Bambu's wiki. Nothing copied from
   BambuStudio's AGPL-3.0 tables (SnapCon is MIT); nothing fetched in the background.
6. **Build approach A:** reuse PR #9's monitoring parts; add control, upload, `.3mf`, AMS mapping,
   Developer Mode handling. No credits/outreach (user's decision); any copyright line already in a
   reused file is left in place. Joel's driver: protocol facts only, no code.
7. **Camera in the beta** (PR #9 relay), with the WebRTC-camera precedent for snapshots.
8. **Tray names A1–A4 and Ext**, supplied by the connector (matches the printer's screen).

## 4. Components

| File | Purpose | Source |
|---|---|---|
| `connectors/bambu-lab.js` | Connector: metadata, `capabilities`/`getCapabilities(p)`, `probe()`, controls, `applyHeadMapping`. One line in `connectors/index.js` `REGISTRY`. | new, with PR #9 normalisation |
| `connectors/bambu-mqtt.js` | MQTT 3.1.1 client: framing, keepalive, reconnect/backoff, injected transport | PR #9 |
| `connectors/bambu-ftps.js` | Implicit FTPS: LIST/NLST, **STOR**, SIZE, **DELE**, TLS session reuse, timeouts | PR #9 + upload/delete |
| `connectors/bambu-ca.js` | Bambu device CA bundle (incl. N7-V2) | PR #9 |
| `connectors/rtsp-client.js`, `connectors/h264-fmp4.js`, `connectors/bambu-camera.js` | RTSPS → fragmented MP4 relay, one upstream per printer shared by viewers | PR #9 |
| `threemf.js` (top level, beside `parser.js`) | Read a `.3mf`: sliced?, plates, plate gcode, thumbnail, `printer_model_id`, nozzle, filaments | new; reuses `parseZipCentralDirectory` (`connectors/snapmaker-u1-firmware.js`) + `zlib.inflateRawSync` |

Server additions: `/api/camera-stream` (PR #9); `.3mf` branches in `/api/map` and
`/api/local-thumbnail`; file-type compatibility guard. Browser: PR #9's MSE stream player with a
live-tile cap. `threemf.js` needs a Dockerfile `COPY` line (enforced by `test/docker.test.js`).

No new runtime dependency (Node built-ins only; express stays the only one).

## 5. Connection lifecycle

- One MQTT connection per printer, module-level map keyed by printer `id`, created lazily on the
  first `probe()` (U1 WebSocket connector pattern).
- Reconnect when IP, serial or access code change; close after 5 min without probes; all timers
  `unref()`'d.
- The first `probe()` for a printer waits (bounded, 5 s — the U1 WebSocket connect timeout) for the
  connection and the first full report, then returns real state. If that does not complete in
  time it returns `online:false` with the specific reason (certificate/serial mismatch, refused
  access code, unreachable, "no status yet"), and the server's normal 10 s offline cache applies.
  There is no separate "connecting" state: `statusColorText` renders any unrecognised state as
  "Idle", which would be false.
- `/api/test-connection` uses a throwaway connection (its printer object has no `id`).
- Freshness: `pushall` on connect, then merge `push_status` deltas only (PR #9 rules: `msg:0`
  replaces, id-keyed arrays merge per item, id-only tray = emptied); re-`pushall` after 60 s of
  silence and every 5 min (never more than every 10 s); offline after 150 s without a report.
- TLS: verify against the Bambu CA bundle and require CN = configured serial; SNI = serial. A
  mismatch refuses the connection with a clear message. Do NOT copy PR #9's TLS 1.2 pin (the P2S
  negotiated 1.3); verify on hardware.

## 6. Status mapping (`probe()`)

| SnapCon | Source | Note |
|---|---|---|
| `state` | `gcode_state`: IDLE→standby, PREPARE/RUNNING→printing, PAUSE→paused, FINISH→complete, FAILED→cancelled if `print_error` ∈ {0, 0x0300400C} else error; other→unknown | |
| prompt pause | PAUSE + known prompt code (0x0500803C) → paused with message "Waiting for confirmation on the printer: nozzle setting doesn't match the file" | |
| `errorCode`/`message` | `print_error` → `"0500-803C"`; own wording or lookup link; 0 is not an error | |
| `progress` | `mc_percent/100`, only while printing/paused | idle keeps a stale 100 |
| remaining | **unavailable** until the unit of `mc_remaining_time` is verified | |
| `hotend`, `bed` | `nozzle_temper`/`nozzle_target_temper`, `bed_temper`/`bed_target_temper`; `device.*` packed values only as fallback | |
| chamber | not reported | no confirmed field |
| `layer` | `layer_num`/`total_layer_num`, only while printing | idle showed a stale 750 |
| `filename` | `subtask_name` | |
| `speed` | `spd_mag` | |
| `fanPct` | omitted until verified | |
| `heads[]` | AMS unit 0 trays 0–3 + external (`vir_slot`); `{loaded, hex, material, sub, official, label, mappable}`; empty tray → empty slot, never a spool; `mappable:false` on Ext | labels A1–A4, Ext; Ext is display-only in the beta (§7) |
| `activeExt` | `ams.tray_now` (255 = none) | |
| model/firmware | `get_version` → `getFirmwareInfo` | |

HMS list is not surfaced in the beta (the idle printer carries permanent entries; showing them would
pin an attention badge).

**Developer Mode state** — in memory per printer, never persisted; values `unknown` (initial, after
a restart or reconnect), `on`, `off`:
- `off` is set ONLY by a `result:"failed", reason:"mqtt message verify failed"` reply to one of
  SnapCon's own `print.*` commands (matched by `sequence_id`). `on` is set by a SUCCESS reply to
  one of them.
- The `fun` bit 0x20000000 is a hint only: it never sets `off` and never disables anything. It is
  used to (a) show a pre-emptive "Developer Mode appears to be off" note while the state is
  `unknown`, and (b) clear a cached `off` back to `unknown` when the bit goes from set to clear —
  the transition observed on the P2S when Developer Mode was enabled.
- A cached `off` is also cleared to `unknown` when the MQTT connection is re-established, the
  printer's settings are saved, Test connection succeeds, or an operator presses "Check again" on
  the card's monitoring-only note.
- While `off`, `getCapabilities(p)` (synchronous, from cached state — the FlashForge
  dual-transport pattern) withholds control and the card shows the note with "Check again".
  `unknown` and `on` leave controls enabled; a refused command then sets `off` with the
  explanation. No command is ever sent just to test the mode — the operator's next real command is
  the test, which is harmless when refused (verified: nothing moves).

## 7. Commands

- Every command carries its own `sequence_id`; the connector waits (with timeout) for the reply with
  that id; `result` compared case-insensitively; replies for other ids are ignored.
- `verify failed` → "Printer control needs Developer Mode (Settings → Network on the printer)".
- Upload (`uploadFile`): FTPS `STOR` to the printer's root under the file's own name, progress via
  `job.sent/total`. A same-named file on the printer is replaced (verified; Bambu Studio does the
  same). Then `SIZE` must equal the local file size.
- Upload failure and cleanup — best-effort, and never hides the original error:
  - `STOR` refused before any data moved (first reply not 1xx): **no `DELE`** — a same-named file
    already on the printer was never touched and must not be deleted.
  - `STOR` began (1xx received) but the transfer failed, the final reply is not 226, or `SIZE`
    reports a different size: **one** best-effort `DELE <name>`; its outcome is logged, never
    thrown; `uploadFile` throws the original error.
  - `SIZE` itself fails after a 226: no start and no `DELE` (the file may well be complete);
    throw "could not confirm the upload".
  - `project_file` refused or unanswered after a verified upload: the file is **kept** on the
    printer — it is complete and valid, and a retry replaces it by name. This matches every
    existing connector: the print route never deletes an uploaded file when the start fails.
- Start (`startPrintFile`): `project_file` with `param: Metadata/plate_N.gcode`,
  `url: ftp:///<name>`, `use_ams: true`, `ams_mapping` = one AMS tray id (0–3) per file filament,
  in file order. The other flags are exactly the payload verified on the P2S (`bed_type:"auto"`,
  `bed_leveling:true`, `flow_cali:false`, `vibration_cali:true`, `layer_inspect:false`,
  `timelapse:false`). The beta declares `autoLevel`/`flowCalibration`/`timelapse` false, so
  SnapCon's print-option switches are not shown for Bambu until each flag's effect is verified.
- **External spool is not selectable for printing in the beta.** Its `ams_mapping`/`use_ams`
  encoding is unverified, so the connector never sends one: Ext is display-only, and a printer with
  no AMS cannot print from SnapCon yet (explained in the UI).
- Mapping (`applyHeadMapping(p, tools, map, prefs)`): stashed per printer (AD5X stash-then-fold,
  5-minute expiry), range-checked 0–3, Ext rejected. `startPrintFile` **refuses** when there is no
  valid stash for the file ("Choose AMS trays in the Send dialog") and never derives a mapping
  itself — no index-order fallback, no external spool. This covers the server skipping
  `applyHeadMapping` when `tools` is empty (server.js:1377), the `--load`/notify path, and a stash
  that expired before a later start from the "Loaded" badge.
- Cancel = `print.stop` (verified). Pause/resume = `print.pause`/`print.resume` (to verify).
  Bed temperature = `print.gcode_line` `M140 S<t>` (to verify). E-Stop and Eject disabled:
  `estop:false` uses the existing pattern; Eject gets the same treatment via a new
  `capabilities.eject:false` read next to `canEject` (app.js ~426), button disabled with a
  `title`, and the connector's `eject()` throws a clear "not supported" error as a backstop.

## 8. `.3mf` handling and compatibility

- `threemf.js` results cached by path + size + mtime.
- **Scope: Bambu `.3mf` only.** A `.3mf` is a *Bambu `.3mf`* when its
  `Metadata/project_settings.config` `printer_model` or `printer_settings_id` names "Bambu Lab"
  (present in sliced and unsliced projects — verified across five vendors). Every other `.3mf` —
  FlashForge AD5X included, which is set aside for this beta — gets exactly today's behaviour:
  no palette/thumbnail change, no "Not sliced" label. Only the extension-based type badge is shown
  for all files.
- Library: type badge **3MF / GCODE** for every file (by extension); "Not sliced" (warn colour)
  only for a Bambu `.3mf` with no `Metadata/plate_N.gcode`; name still extension-stripped, full
  name in `title` (called-out deviation from the strip-only convention).
- `/api/map` for a **sliced Bambu `.3mf`**: extract the plate's embedded gcode and run the EXISTING
  `parseGcodeMap` on it (same parser, same result shape — the embedded gcode carries the usual
  header comments), plus Bambu extras from `slice_info.config` (`printer_model_id`, per-filament
  `tray_info_idx`). `/api/local-thumbnail` for a Bambu `.3mf`: `Metadata/plate_N.png`. Unsliced
  Bambu `.3mf` and every non-Bambu `.3mf`: today's results, unchanged.
- Accepted file types: new optional capability `fileTypes`. Absent = today's full set
  (`gcode|gco|g|gx|3mf`), so no existing connector changes behaviour; Bambu declares `["3mf"]`.
  Server refuses a type mismatch on `/api/print`, `/api/printfile`, `/api/notify-load` (both
  paths) and bulk send; pools refuse Bambu printers. Send dialog disables incompatible printers
  with a reason. Cross-brand `.3mf` (e.g. a Bambu file to an AD5X) is left to the existing brand
  check below, unchanged.
- Brand compatibility — existing mechanism (`detectPrinterBrand` / `isCompatiblePrinter`,
  app.js:4657-4689): with the connector brand "Bambu Lab", a file whose `printer_model` /
  `printer_settings_id` names Bambu Lab matches, another brand is incompatible, undetectable is
  "can't tell".
- Model compatibility — Bambu only, **verified mappings only**: a table in the connector,
  `{ "Bambu Lab P2S": "N7" }`, keyed by the printer's `get_version` `product_name` and compared with
  the file's `slice_info` `printer_model_id`. Both known and in the table → no message on a match,
  warning "sliced for a different Bambu model" on a mismatch. Printer model not in the table, or no
  `printer_model_id` in the file → warning "SnapCon can't verify this file matches this printer
  model" — never reported as a mismatch. The certificate issuer (`N7-V2`) is NOT used: issuer →
  model code is one sample, not a rule. A model enters the table only after a live check.
- Other pre-send checks: unsliced → refused; nozzle diameter (`nozzle_diameter`) mismatch →
  warning; plate picker when >1 sliced plate.

## 9. UI (existing patterns only)

- **Settings row (connector "Bambu Lab"):** IP, Serial (trim + upper-case), Access code via
  `secretFieldHtml` (Configured / Replace / Clear); Port and API token hidden (existing
  per-connector visibility toggles). Hide by `display:none` on the wrapper — never remove the
  field from the DOM: `serializeRowForDiff`, `gatherPrinters` and Test connection each read a
  secret via `row.querySelector(".ptoken"|".pvcode").closest(".secret-field")`, which throws if the
  element is gone (step 1). Helper text: "Find these on the printer: Settings → Network. Printing from
  SnapCon needs LAN Only Mode and Developer Mode." Test connection reports model, firmware, AMS,
  Developer Mode on/off.
- **Fleet card:** trays in `afcLanesHtml`: the lane header (today hard-coded `T${i+1}`,
  app.js:4995) and the spool `title` (today `headLabel(i)`) use `head.label` when present and are
  otherwise unchanged, so no other connector is affected. Developer Mode off: controls disabled
  with `title`, plus one line "Monitoring only. Turn on Developer Mode on the printer to control
  prints." and a "Check again" button (§6). Non-P2S: "Untested model" status badge. Prompt pause:
  existing error panel + Resume/Cancel.
- **Send dialog:** per-filament picker listing only mappable trays ("A1 · PETG Basic, black"); Ext
  appears on the card but is not offered for printing. Matching is material-first for connectors
  that declare it: today's `defaultMapping` (app.js:4890) is colour-only and falls back to
  "filament N → slot N" for anything unmatched, so for these connectors pairs whose material
  differs (file palette `type` vs tray `material`, trimmed, case-insensitive) cost 1e9 and count as
  unmatched, and the index fallback is skipped — an unmatched filament stays unassigned. With
  `SUGGEST_MATCHING` off nothing is pre-filled for Bambu (today's index→index default would be a
  guess). Unassigned or material-mismatched filament: error helper text "No tray holds PETG — load
  it in the AMS" and Send disabled with `title`. Printer with no AMS: printing disabled with
  "Printing from the external spool isn't supported in this beta yet". Model/nozzle warnings as
  `.settings-help.warn`; plate picker.
- **Camera:** existing camera view; MSE live stream opened only for visible tiles (live-tile cap);
  without ffmpeg: canvas-captured manual snapshot, no notification image (WebRTC precedent).

## 10. Security

- Access code: `secretFieldHtml` control. `/api/config` sends `verificationCode: undefined` plus
  `hasVerificationCode`, mirroring `token`/`hasToken` (server.js:2801). Save semantics copy the
  token's (server.js:3010-3019): non-empty replaces, `""` (Clear) removes, absent keeps. Client:
  the printer row will then hold TWO secret fields, so row code that does
  `querySelector(".secret-field")` (e.g. the token read at app.js:11233) must target the specific
  field (the one containing `.ptoken` / `.pvcode`), and both are wired and reset after save.
  Test connection sends the saved printer's `id` plus `secretFieldValue()` for the code; the server
  uses the stored code only when the field was left untouched and the `id` belongs to a saved
  printer (today the route only reads form values, server.js:4789-4807). Also fixes the existing
  FlashForge exposure (`public/app.js:10500`).
- Never log or audit the access code; audit diff keeps treating printer config as secret.
- `/api/camera-stream`: `requireAuth` + `printerVisibleTo(req.user, p)`, same as `/api/snapshot`.
- TLS verification as in §5; access code sent only after the certificate check.

## 11. Tests

- `test/threemf.test.js`: synthetic `.3mf` (zip builder from `test/helpers/mockU1.js`): sliced,
  unsliced, multi-plate, missing thumbnail; Bambu identification from `project_settings.config`
  (Bambu Lab vs another vendor vs missing file).
- `test/connectors/bambu-lab.test.js`: normalisation from fixtures derived from the saved
  (already redacted) P2S reports — state mapping, cancelled vs error, prompt pause, empty trays,
  strings as numbers, stale idle layer/progress, Developer Mode detection; reply matching
  (SUCCESS/success, sequence ids, foreign replies ignored, `verify failed`); AMS auto-match and
  range checks.
- Fakes: PR #9 broker/camera; extended fake printer (STOR/SIZE/DELE, `project_file` ack/refuse,
  `verify failed`).
- Server: type guard (gcode→Bambu refused; existing connectors, AD5X included, still accept
  `.3mf`; a non-Bambu `.3mf` gets exactly today's `/api/map` and thumbnail results), pools refuse
  Bambu, access-code regression (`/api/config` never contains it; absent keeps,
  `""` clears; the token is still read from its own field), Test connection with an untouched code,
  camera-stream visibility, `docker.test.js` for `threemf.js`, `connectorCompatTest` required
  methods.
- Connector behaviour: upload cleanup (no `DELE` when `STOR` is refused up front; one `DELE` after a
  failed transfer or size mismatch; a failing `DELE` never replaces the original error; file kept
  when the start fails); start refused with no valid stash, with Ext, or with a tray outside 0–3;
  Developer Mode transitions (verify failed → off; SUCCESS → on; fun set→clear, reconnect, settings
  save, Test connection, "Check again" → unknown; the fun bit alone never disables); model check
  (P2S/N7 match; unknown model or missing id → "can't verify", never "mismatch").

## 12. Build order (one reviewable commit each; gcode printers unaffected throughout)

1. Access-code masking fix + regression test.
2. `threemf.js`, library badge, `/api/map` + thumbnail for `.3mf`, file-type compatibility guard.
3. Protocol clients (MQTT, FTPS with STOR/DELE, CA) + fakes.
4. Connector monitoring: `probe()`, trays with labels, Developer Mode detection, errors, Settings row.
5. Control: upload, start with AMS mapping + Send dialog, pause/resume/cancel, bed temp; E-Stop/Eject disabled.
6. Camera.
7. Live verification on the P2S + RELEASE_NOTES (README: recommendations only).

## 13. Live verification checklist (P2S, printer idle, user confirms bed clear)

- [ ] pause / resume
- [ ] answering a prompt pause (0x0500803C) — `resume` or something else
- [ ] external spool: the `ams_mapping` / `use_ams` values that select it (until verified, Ext is
      display-only and a printer without an AMS cannot print from SnapCon)
- [ ] AMS mapping actually honoured (print reaches filament load; file re-sliced for the printer's nozzle)
- [ ] `mc_remaining_time` unit; fan field meaning
- [ ] bed temperature via `M140` over `gcode_line`
- [ ] TLS 1.3 with CA verification (vs PR #9's 1.2 pin)
- [ ] camera stream has no B-frames (short PLAY)
- [ ] packed `device.*` temperatures vs flat fields while heating
- [ ] effect of the `bed_leveling` / `flow_cali` / `timelapse` flags (until verified, the matching
      print options stay hidden and the verified payload is sent)

Anything that fails stays disabled in the beta.

## 14. Deferred

Multi-AMS (generalise the hard-coded 4-head UI: app.js ~5191, 6769, 5816, 5862, 5700;
`parser.js:169`; `defaultMapping` performance for 17 slots), AMS HT, Queue Management/pools for
Bambu, printing from printer storage, SSDP discovery, FTPS sync (SyncEngine passes a base URL, not
the printer), HMS list on the Health page, error text beyond the handled codes, printing from the
external spool (pending its protocol check), SnapCon print-option switches for Bambu (pending
their checks), palette / thumbnail / "Not sliced" for non-Bambu `.3mf` (AD5X set aside).

## 15. Pre-development review (2026-09-15)

Checked against the current codebase; wording tightened, no scope added.

1. Model compatibility uses only verified mappings (`"Bambu Lab P2S"` → `N7`); unknown models give
   "can't verify", never a false mismatch; the certificate issuer is no longer used (§8).
2. External spool is display-only; the connector never sends an external-spool mapping; a start
   without a valid stashed AMS mapping is refused (§7, §9).
3. Developer Mode state lifecycle defined: only SnapCon's own `print.*` replies set on/off; the `fun`
   bit is a hint that can clear `off` but never set it; `off` also clears on reconnect, settings
   save, Test connection and "Check again" (§6).
4. Upload cleanup defined: no `DELE` when `STOR` was refused up front, one best-effort `DELE`
   after a failed/short transfer, keep the file when the start fails; the original error always
   wins (§7).
5. Contradictions with the code fixed: `.3mf` is already an AD5X format, so the `fileTypes` default
   keeps `3mf` and `/api/map` reuses `parseGcodeMap` on the embedded gcode (§8); the "connecting"
   probe result would render as "Idle", replaced by a bounded first-connect wait (§5); the lane
   header is `T${i+1}`, not `headLabel()` (§9); `defaultMapping` is colour-only with an index
   fallback, so Bambu gets material-first matching without the fallback (§9); print options arrive
   via `applyHeadMapping`'s `prefs`, which the server skips when nothing is mapped, so the start must
   refuse rather than guess (§7); masking the access code needs specific secret-field selectors and a
   Test-connection fallback by printer id (§10).
6. AD5X set aside (user, 2026-09-15): the new `.3mf` handling applies only to a *Bambu `.3mf`*,
   identified by `project_settings.config` naming Bambu Lab; every other `.3mf` keeps today's
   behaviour, so no AD5X verification is needed for the beta (§8).
