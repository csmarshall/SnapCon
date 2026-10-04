# Bambu Lab local integration — research notes

Status: **research only, no connector implementation yet.** This documents how third-party
tools (PrintStream, Home Assistant's `ha-bambulab`, the OpenBambuAPI community docs, etc.)
talk to Bambu Lab printers over LAN, as groundwork for an eventual `connectors/bambu-lab.js`
in SnapCon. Nothing here has been verified against a live Bambu printer — per this repo's
CLAUDE.md Section 2 ("Printer data is evidence"), every field/topic/port below must be
confirmed against a real device's actual behavior before any of it is relied on in code.

All of this is **unofficial, community reverse-engineered protocol** (no public Bambu Lab
API docs exist for local/LAN control). Treat firmware updates as a standing risk to any of
these details changing without notice.

## 1. Prerequisite: LAN-only / developer mode

Every local protocol below requires the printer to have LAN-only mode (or "Developer Mode"
depending on firmware/model naming) enabled on-device, which exposes:

- **Serial number** (the device ID used in MQTT topics and TLS cert CN)
- **Access code** (the shared credential for MQTT/FTPS/camera — printer's touchscreen shows
  it under Settings → Network / WLAN)
- **IP address** on the local network

Without LAN mode enabled, the printer only talks to Bambu's cloud (`us.mqtt.bambulab.com`),
which is a different, cloud-account-gated protocol variant and out of scope for SnapCon's
local-first model — SnapCon should only target the LAN-only path, matching every other
connector in `connectors/`.

## 2. Discovery (SSDP)

Bambu printers broadcast their presence via SSDP-style UDP multicast, independent of MQTT:

- Printer sends from source port **1900** to destination port **1990** (some tooling instead
  documents **2021** — Bambu Studio/OrcaSlicer listen on `udp/2021`), roughly every 5 seconds.
- Broadcast payload includes model, device name, serial number, firmware version, signal
  strength, connection type.
- SSDP is broadcast/multicast-scoped — it does not cross VLANs/subnets without a relay, which
  is a common source of "printer not found" complaints in the Bambu community when the
  printer and the client are on different network segments.

This maps to the `discovery` connector capability SnapCon already models (`connectors/index.js`
capability flags — currently `true` for `klipper-moonraker`/`creality-klipper`/
`snapmaker-u1-klipper`, `false` for the FlashForge connectors). A Bambu connector's discovery
path would be UDP/SSDP-based rather than the mDNS/HTTP-probe approach the Klipper-family
connectors use — genuinely different mechanism, same capability slot.

## 3. Control & telemetry: MQTT

- **Broker**: the printer itself, `mqtts://{PRINTER_IP}:8883` (TLS required, MQTT 3.1.1).
- **Auth**: username `bblp`, password = the printer's access code.
- **TLS**: printer presents a cert issued by a Bambu-internal CA (not a public CA), with the
  certificate's Common Name set to the printer's **serial number**, not its IP. Correct
  handling requires either trusting Bambu's CA cert (community docs bundle this) or otherwise
  pinning it, *and* setting SNI to the serial number when connecting by IP — connecting by
  bare IP without SNI is a documented source of cert-validation failures. Skipping/disabling
  TLS verification entirely is explicitly discouraged in the source docs.
- **Topics**:
  - Subscribe: `device/{SERIAL}/report` — printer-initiated status pushes and command
    responses.
  - Publish: `device/{SERIAL}/request` — commands sent to the printer.
- **Envelope shape** (both directions), keyed by a top-level command family:
  ```json
  { "{family}": { "sequence_id": "0", "command": "{command}", "...": "params" } }
  ```
  Reports additionally carry `"result"` / `"reason"` on responses to specific commands.
- **`pushing.pushall`** — request a full status dump (temps, AMS, print state, fans, layer
  progress, etc.) on the `report` topic. Community docs explicitly warn **not to call this
  more often than every 5 minutes on the P1P**, citing lag — an important input if SnapCon's
  polling loop (which currently expects sub-minute freshness from Klipper-family connectors)
  ends up needing a materially different polling cadence for Bambu.
- Notable command families seen in the docs: `info.get_version` (per-module firmware/hardware
  versions: ota/rv1126/th/mc/xm), `print.gcode_line` (raw G-code injection), `print.print_speed`
  (silent/standard/sport/ludicrous presets), `print.ams_change_filament`, `system.ledctrl`
  (chamber/work light on/off/flashing).
- **Report fields of interest** for SnapCon's normalized probe shape: `gcode_state` (IDLE/
  PRINTING/etc.), `gcode_file`, `layer_num`/`total_layer_num`, `bed_temper`/
  `bed_target_temper`, `nozzle_temper`/`nozzle_target_temper`, `chamber_temper`,
  `big_fan1_speed`/`big_fan2_speed`/`cooling_fan_speed`, and a nested `ams.ams[]` array
  (per-AMS-unit humidity/temp/tray contents).
- **AMS-to-toolhead color mapping**: uses a fixed 5-element array with `-1` for unused slots,
  reverse-indexed (e.g. `[-1,-1,-1,X,Y]` for a 2-color job mapped to AMS slots X/Y) — this is
  conceptually adjacent to SnapCon's existing `toolheadNumber()`/`headLabel()` split
  (CLAUDE.md Section 5) but is Bambu's own numbering scheme, not interchangeable with either.

## 4. File transfer: FTPS

- **Host**: printer IP, **port 990**, **implicit TLS** (not the explicit/`AUTH TLS` flavor).
- **Auth**: same as MQTT — username `bblp`, password = access code.
- Used for uploading gcode/3mf files to print and (per general community knowledge, not
  confirmed in the source doc fetched) pulling timelapses/cache off the printer's local
  storage. Directory layout on the printer's FTPS server was **not** documented in the source
  consulted here — needs live discovery against a real printer (e.g. an `LIST` after connect)
  before any upload/download path is implemented.

## 5. Camera / live view

Protocol differs by printer family — this is a real fork, not a firmware-version detail:

- **X1 / X1C / P2S**: standard-ish **RTSPS** on **port 322**:
  `rtsps://bblp:{ACCESS_CODE}@{PRINTER_IP}:322/streaming/live/1`. TLS + `bblp`/access-code
  auth, same credential pattern as MQTT/FTPS.
- **H2 series (H2S/H2D)**: same RTSPS endpoint as X1, but **disabled by default** — must be
  toggled on-device (Settings → General → LAN Mode Liveview) before it will respond.
- **A1 / A1 mini / P1P / P1S**: **no RTSP.** Instead a proprietary TCP stream on **port 6000**,
  TLS-wrapped, same `bblp`/access-code credentials, carrying raw 1280×720 JPEG frames:
  - Initial 64-byte auth handshake: 4B payload-size (`0x40`), 4B type (`0x3000`), 4B flags
    (`0`), 4B padding, 32B null-padded ASCII username, 32B null-padded ASCII password.
  - Each subsequent frame: 16-byte header (4B payload size, 4B "itrack" = 0, 4B flags = 1, 4B
    padding) followed immediately by JPEG bytes; frames may arrive fragmented across TCP reads
    and must be reassembled/validated via the `FFD8`…`FFD9` JPEG start/end markers.

This is directly relevant to SnapCon's `camera` connector capability — a Bambu connector would
need **two different camera code paths** gated by printer model (RTSPS decode vs. the raw
port-6000 framed-JPEG protocol), not one. P1P specifically has no built-in camera hardware at
all in stock form (aftermarket-only), which is a capability-level fact, not a protocol detail,
and should gate the `camera` capability per-model rather than per-connector if a single
connector module ends up covering the whole Bambu line.

## 6. Reference implementations consulted

- **OpenBambuAPI** (`github.com/Doridian/OpenBambuAPI`) — community protocol documentation
  covering MQTT, FTPS, video/camera, TLS/cert handling, gcode format. Primary source for
  Sections 3–5 above (`mqtt.md`, `ftp.md`, `video.md`, `tls.md`).
- **PrintStream** (`github.com/PrintStreamApp/printstream`) — the project that prompted this
  research; closed-source implementation, confirmed (via its own README) to use MQTT/FTPS/
  camera protocols over LAN, matching the OpenBambuAPI description, but its actual code wasn't
  inspected (proprietary/licensed).
- **Home Assistant `ha-bambulab`** (`github.com/greghesp/ha-bambulab`) — a widely-used, actively
  maintained open-source integration; fetch of the repo landing page didn't surface enough
  detail to extract specifics here, but it's a concrete open-source LAN-mode client worth
  reading directly (not just its README) when this moves from research to implementation.
- General Bambu community reverse-engineering: SSDP discovery details (Section 2) came from
  community forum/blog posts and discovery-tool projects (e.g.
  `psychoticbeef/BambuLabOrcaSlicerDiscovery`), not an official source — lower confidence than
  the OpenBambuAPI-sourced MQTT/FTPS/camera material.

## 7. Open questions before any connector work starts

- Live-verify the actual `pushall` JSON shape against a real printer — field names/nesting in
  particular are the kind of thing that silently drifts across firmware versions.
- Confirm which fields are present on which models (A1 mini vs. X1C are very different
  hardware) before assuming a single normalized probe shape covers the whole Bambu line, the
  way `connectors/http-utils.js` currently does for the Klipper-family printers.
- Determine actual FTPS directory layout (gcode storage path, timelapse/cache paths) by
  connecting to a real printer.
- Decide whether SnapCon models Bambu as **one connector with per-model capability gating**
  (camera protocol, AMS presence, chamber temp) or **multiple connector files** the way
  FlashForge currently splits Adventurer vs. AD5X — this is exactly the kind of call
  CLAUDE.md Section 3 asks to make deliberately rather than defaulting to false parity.
- Confirm the P1P `pushall` 5-minute-interval warning is real and current, and figure out what
  polling cadence SnapCon's fleet-poll loop can actually offer a Bambu printer without
  breaking the existing multi-second refresh users expect from other brands.

Sources:
- [OpenBambuAPI — mqtt.md](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md)
- [OpenBambuAPI — ftp.md](https://github.com/Doridian/OpenBambuAPI/blob/main/ftp.md)
- [OpenBambuAPI — video.md](https://github.com/Doridian/OpenBambuAPI/blob/main/video.md)
- [OpenBambuAPI — tls.md](https://github.com/Doridian/OpenBambuAPI/blob/main/tls.md)
- [OpenBambuAPI — repo root](https://github.com/Doridian/OpenBambuAPI)
- [ha-bambulab (Home Assistant integration)](https://github.com/greghesp/ha-bambulab)
- [PrintStream](https://github.com/PrintStreamApp/printstream)
- [BambuLabOrcaSlicerDiscovery (SSDP)](https://github.com/psychoticbeef/BambuLabOrcaSlicerDiscovery)
