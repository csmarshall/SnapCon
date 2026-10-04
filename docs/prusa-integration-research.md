# Prusa (PrusaLink) local integration — research notes

Status: **research only, no connector implementation yet.** Companion to
`docs/bambu-lab-integration-research.md` — same purpose: groundwork for an eventual
`connectors/prusa-link.js`, prompted by `print-farm-manager`
(github.com/joeltelling/print-farm-manager) supporting Prusa alongside Bambu. Nothing here
has been verified against a live Prusa printer — per CLAUDE.md Section 2, every endpoint/field
below must be confirmed against real device behavior before being relied on in code.

Unlike Bambu, **Prusa publishes an official OpenAPI spec** for PrusaLink
(`prusa3d/Prusa-Link-Web`, `spec/openapi.yaml`) — this is a materially better starting point
than Bambu's community-reverse-engineered protocol: read that spec directly once implementation
starts, rather than re-deriving endpoint shapes from secondary sources the way the Bambu doc
had to.

**Reference-quality note**: of the three third-party PrusaLink implementations now cited in
this doc, `print-farm-manager`'s `server/drivers/prusa.js` is treated as the most trustworthy —
it's judged (by the person driving this research, having looked at its overall code quality
across brands) the most accurate of the plugins compared here. Where its findings conflict with
`Mirdain_printer_manager` or `3D-Printing-Farm-System`, prusa.js's behavior is the one to weight
most heavily, though all three still fall short of live-device verification.

## 1. What PrusaLink is

PrusaLink is Prusa's own local-network HTTP API/UI, built into firmware on newer printers
(no separate Raspberry Pi/OctoPrint needed on those models) and also shippable standalone on
a Pi for older ones. It's the direct local-control equivalent of Moonraker for Klipper
machines or Bambu's local MQTT/FTPS stack — this is the layer a SnapCon connector should
target, not Prusa's cloud service ("Prusa Connect").

**Hardware coverage** (per the `pyprusalink` library, itself built by the Home Assistant team):
Prusa-Firmware-Buddy printers — **Core One, MK4, MK4S, MK3.9, MK3.5, MINI, XL** — plus
standalone PrusaLink running on a Raspberry Pi for older/other models. `print-farm-manager`'s
README specifically calls out MK4S and XL as tested.

## 2. Transport & auth

Pure **HTTP/REST**, no MQTT/WebSocket involved (unlike Bambu) — this is architecturally closer
to SnapCon's existing Moonraker-family connectors than the Bambu work will be.

Two API generations live on the same host, distinguished by URL prefix and auth scheme —
**though which auth scheme actually applies to `/api/v1/*` is now an open contradiction
between sources, not a settled fact:**

- **Official OpenAPI spec / `pyprusalink`** (Home Assistant's library): `/api/v1/*` requires
  **HTTP Digest auth**, username `maker`, printer's API key as the digest password.
- **`Mirdain_printer_manager`**: agrees — implements Digest auth for v1, explicitly requiring
  a username *and* password from the user (not just a bare key).
- **`print-farm-manager`'s `prusa.js`** (the reference treated as most trustworthy here) and
  **`3D-Printing-Farm-System`'s `hardware-bridge.mjs`**: both instead send a plain
  **`X-Api-Key` header** against `/api/v1/status` and `/api/v1/files/usb/...` — no Digest
  challenge/response anywhere in either implementation.

Two working (or working-enough) implementations use a header key; two other sources (one of
them the official spec) say that's wrong for v1. Plausible explanations: firmware-version
differences in what `/api/v1/*` actually accepts, or the AI-summarized reads on either side of
this being imprecise. **Do not pick one without testing against a real printer** — this is
exactly the kind of thing CLAUDE.md Section 2 means by "confirm before building on it," and the
cost of guessing wrong here is an auth path that silently fails on some firmware versions.

- **`/api/*`** (legacy) — all sources agree: **API-key header auth**, `X-Api-Key: {key}`. Key
  is retrievable/regeneratable via `GET /api/settings` / `GET /api/settings/apikey`. Returns
  `403` on bad credentials (vs. `401` for the v1 digest scheme, per the spec/Mirdain reading).

No TLS/cert complexity here (unlike Bambu's BBL-CA/SNI requirement) — this is the same
trust model as the existing Klipper-family connectors (plain HTTP on the LAN), which is a real
simplification if/when a Prusa connector gets built.

## 3. Key endpoints (v1)

- `GET /api/version` — shared across both API generations: PrusaLink version, firmware
  version, API version string, capabilities.
- `GET /api/v1/info` — serial, model, location, capabilities.
- `GET /api/v1/status` — combined status: printer state, job, transfer, storage, and an
  optional embedded camera object, all in one response (single-call polling target — better
  fit for SnapCon's per-poll-cycle probe() pattern than needing multiple round-trips).
- `GET /api/v1/job` — job status; supports cancel/pause/resume/continue actions.
- `GET /api/v1/storage`, `GET /api/v1/transfer` — storage and in-progress-transfer state.
- `PUT /api/v1/files/{storage}/{path}` — upload, with `Print-After-Upload: ?1` and
  `Overwrite: ?1` headers — notably this folds "upload" and "start print" into one request
  when desired, unlike the separate-upload-then-separate-start-print flow SnapCon's other
  connectors use.
- Legacy `/api/files/{target}` and `/api/printer` (material info) still present for
  backward compatibility.
- Content negotiation via `Accept: application/json` (vs. plain text default) and
  `Accept-Language` on some endpoints.

**Confirmed by a real independent implementation** — `Mirdain_printer_manager`
(github.com/hbaig2021/Mirdain_printer_manager, `backend/app/adapters.py`,
`PrusaLinkAdapter`) has a working PrusaLink client in production-ish use, which fills in
several gaps the OpenAPI-spec-secondary-source triangulation above left open:

- **Job control is split across two different endpoints, not one.** Starting a print PUTs to
  `/api/v1/files/{storage_path}` (i.e. starting is a files-endpoint action, not a job-endpoint
  one); pause/resume go to `/api/v1/job/{job_id}/{action}`; cancel targets
  `/api/v1/job/{job_id}` directly. A connector needs the active `job_id` on hand before it can
  pause/resume/cancel — confirm where that comes from (`GET /api/v1/job` response, presumably)
  before assuming a fire-and-forget command shape like SnapCon's other connectors use.
- **Upload endpoint, concretely**: `PUT /api/v1/files/local/{safe_name}` — the `safe_name`
  naming in a third party's own adapter is itself a signal that filename sanitization matters
  here, consistent with CLAUDE.md's Section 8 input-boundary rules for any connector's own
  upload path.
- **A concrete state-vocabulary mapping**, i.e. exactly the kind of normalization
  `connectors/http-utils.js` already does for the Klipper family — worth using as a starting
  point rather than re-deriving from scratch:
  - `PRINTING` → printing
  - `PAUSED` → attention
  - `IDLE` / `READY` / `FINISHED` / `STOPPED` → ready
  - anything else → attention
  - Job outcome: `FINISHED` → completed, `STOPPED` → cancelled, `ERROR` → failed
- **A real-world API-variance quirk**: the active job's filename shows up in two different
  shapes depending on which response variant PrusaLink returns —
  `detailed_job.file.name` vs. `detailed_job.filename` — Mirdain's adapter checks both. Treat
  this as a concrete warning that PrusaLink's JSON shape isn't perfectly stable across
  endpoints/firmware, not just a hypothetical.

**Confirmed by `print-farm-manager`'s `server/drivers/prusa.js`** — treated as the most
trustworthy of the three third-party implementations gathered so far, and it diverges from
Mirdain in ways worth taking seriously rather than averaging away:

- **Upload target is `/api/v1/files/usb/{filename}`, not `local`.** Mirdain's adapter uploads
  to `.../files/local/{safe_name}`. Two real implementations disagree on the storage root —
  likely because it's genuinely configurable/model-dependent (internal flash vs. an inserted
  USB stick), not a mistake on either side. **A connector probably needs the storage target to
  be a per-printer setting, not a hardcoded constant** — this is a concrete design implication,
  not just a trivia point.
- **Pre-delete-then-upload pattern**: it `DELETE`s any existing file at the target path before
  `PUT`-ing the new one, specifically "to avoid stale file conflicts." 404-on-delete is treated
  as fine (nothing to delete); 409 is surfaced as a distinct `UPLOAD_CONFLICT` error meaning a
  transfer is likely still in progress. This is a real operational pattern worth adopting rather
  than assuming a plain overwrite-on-upload is safe.
- **`cancelJob()` is an intentional stub** — the code's own comment states *"PrusaLink v1 does
  not expose a reliable cancel endpoint."* This directly contradicts Mirdain's adapter, which
  implements cancel via `DELETE`-ish `/api/v1/job/{job_id}`. Given this source is the one being
  treated as most accurate here, **treat "can PrusaLink v1 reliably cancel a job" as unresolved
  and worth testing early** — if prusa.js's caution is correct, a Prusa connector may need a
  fallback (e.g. G-code injection, or accepting cancel as best-effort/unsupported) rather than
  assuming the job-endpoint DELETE Mirdain relies on always works.
- **Concrete timeouts**: 8s for status polls, 10s for the pre-upload delete, 5 minutes for the
  upload itself — real numbers to start from for a connector's own timeout handling per
  CLAUDE.md Section 6 ("printer network operations must fail predictably").
- State is normalized to `IDLE | PRINTING | FINISHED | PAUSED | ERROR | OFFLINE | READY |
  UNKNOWN`, read from `response.data.printer.state` — a flatter/simpler shape than Mirdain's
  reading of `/api/v1/status`, another point to reconcile once a real device is available.
- No camera support, consistent with Mirdain and the general "camera mechanism unconfirmed"
  gap noted below.

## 4. Camera

Represented as an optional object embedded directly in the `/api/v1/status` response rather
than a separate stream endpoint/port (unlike both Bambu's RTSPS/port-6000 split and the
Klipper-family connectors' separate webcam-stream URL pattern) — the exact snapshot-retrieval
mechanism (inline base64? a resolvable URL field? a separate `/api/v1/...camera...` path?)
wasn't visible in the sources consulted here and needs direct inspection of the OpenAPI spec
or a live printer.

## 5. How this differs from Bambu, at a glance

| | Bambu | Prusa (PrusaLink) |
|---|---|---|
| Transport | MQTT (control/telemetry) + FTPS (files) + RTSPS or proprietary TCP (camera) — three separate protocols/ports | Single HTTP/REST API, one host |
| Spec | Unofficial, community reverse-engineered | Official OpenAPI spec published by Prusa |
| Auth | Shared `bblp`/access-code credential across all three protocols | Digest auth (v1) or API-key header (legacy) |
| TLS | Required, with Bambu-internal CA + SNI-by-serial quirk | Not required (plain LAN HTTP) |
| Camera | Two incompatible protocols split by printer model | Embedded in status JSON (mechanism TBD) |
| Multi-material | AMS via MQTT `ams` object, 5-slot reverse-indexed mapping | Not researched yet — Prusa's MMU3 unit would need separate investigation before assuming parity |

Practically: **a Prusa connector is likely the easier of the two builds** — one HTTP surface,
official spec, no TLS/cert handling, no protocol fork by model. It's structurally close to
`connectors/klipper-moonraker.js` as a shape to imitate (single polled status endpoint, HTTP
upload, REST job actions), whereas Bambu genuinely needs three separate client protocols in
one connector module.

## 6. Open questions before any connector work starts

**Top priority — real conflicts between sources, not just gaps:**

- **Auth scheme for `/api/v1/*`**: Digest (spec, Mirdain) vs. plain `X-Api-Key` header
  (print-farm-manager, 3D-Printing-Farm-System). Test against a real printer before writing
  any connector code — guessing wrong means silent auth failures on some firmware.
- **Cancel reliability**: print-farm-manager (the trusted reference) treats v1 cancel as
  unreliable/unimplemented; Mirdain implements it via `DELETE /api/v1/job/{job_id}`. Confirm
  which is true, and have a fallback plan if it's the former.
- **Upload storage target**: `local` (Mirdain) vs. `usb` (print-farm-manager) — likely needs to
  be a per-printer configurable setting rather than a hardcoded path segment either way.

**Other open items:**

- Read `prusa3d/Prusa-Link-Web`'s `spec/openapi.yaml` directly (it's official and complete —
  better than triangulating from secondary docs the way this file currently does) to get exact
  field names/types for `/api/v1/status`, `/api/v1/job`, and error responses. Section 3 now has
  two real implementations' endpoint shapes for job control as a cross-check, but the OpenAPI
  spec is still the authoritative source to confirm against.
- Confirm the camera-snapshot mechanism concretely (inline data vs. URL vs. separate endpoint)
  — no source consulted so far (including the two newest ones) implements camera at all.
- Confirm whether MMU3 (Prusa's multi-material unit) is exposed via this API at all, and if so
  what shape — needed before deciding whether a Prusa connector can claim SnapCon's
  `filamentHeads`/`headMapping` capabilities or must report `false` the way several existing
  connectors already do for features their hardware doesn't support.
- Confirm exclude-object / plate / camera capability support per the v1 spec against SnapCon's
  existing capability flag set (`connectors/index.js`) before assuming any of them apply.
- Decide, once both this and the Bambu doc are done and more brands are gathered, whether
  each new brand gets its own connector file (current SnapCon convention — one file per brand,
  shared only via `http-utils.js`/`flashforge-utils.js` where the underlying protocol is
  actually shared) rather than a multi-brand abstraction — per CLAUDE.md Section 3, that's the
  established pattern and there's no indication PrusaLink and Bambu's MQTT/FTPS stack share
  enough to justify one.

Sources:
- [Prusa-Link-Web — openapi.yaml](https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml)
- [Prusa-Link-Web API reference (DeepWiki)](https://deepwiki.com/prusa3d/prusa-link-web/6-api-reference)
- [pyprusalink (Home Assistant)](https://github.com/home-assistant-libs/pyprusalink)
- [prusa-link-mqtt-bridge](https://github.com/FloSchl8/prusa-link-mqtt-bridge)
- [print-farm-manager](https://github.com/joeltelling/print-farm-manager) — `server/drivers/prusa.js`, treated as the most trustworthy of the third-party references here
- [Mirdain_printer_manager](https://github.com/hbaig2021/Mirdain_printer_manager) — `backend/app/adapters.py`, `PrusaLinkAdapter`
- [3D-Printing-Farm-System](https://github.com/iain0901/3D-Printing-Farm-System) — `api/hardware-bridge.mjs` (lower confidence — this project's own Moonraker bridge hardcodes progress to 50%/0% rather than reading a real value, a sign of an MVP-quality implementation; its PrusaLink auth reading is corroborating evidence for the `X-Api-Key`-on-v1 question above, not a strong standalone source)
