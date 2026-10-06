# ADR-0032: U1 network firmware deployment is a separate module outside the connector interface, admin-only, sourced only from a configured folder, and serialised across the fleet

- **Status:** Accepted (retroactive)
- **Date:** 2026-08-25 (`4c78eba`); fleet queue and UI 2026-09-10 (`55c03a6`, `3bbf81d`); shipped 0.7.0
- **Area:** Printer integration (Snapmaker U1) / safety

## Context
A U1 accepts firmware from anything on its LAN with no password. Flashing is rare, destructive and takes several minutes, and a half-written image can leave a printer unbootable. Moonraker's repeater `system.*` RPCs never return on shipped firmware, and `unisrv` replies are acknowledgements, not results.

## Decision
- `connectors/snapmaker-u1-firmware.js` speaks to `unisrv` directly over the printer's internal MQTT bus via Moonraker's `/server/mqtt/publish|subscribe`. It uploads the image to `/userdata/gcodes` and calls `system.upgrade` with that path. It is required only by the one route that uses it, and only for connectors that advertise `firmwareDeploy`. "No connector exports change."
- Success is never reported from an RPC reply. The real outcome is `notify_system_upgrade`, and the printer going offline afterwards is expected.
- `POST /api/firmware-deploy` is admin-only, takes folder-relative paths only (jailed, symlinks refused), holds a per-printer lock, and re-checks printer state on arrival, at job start, and in an awaited `beforeFlash` hook just before the irreversible write. The uploaded copy is read back and compared before flashing.
- Several printers run one at a time (each moves about 0.25 GB). Stop applies between printers, never mid-write. A print is never dispatched to a printer mid-deploy (`3bbf81d`), and faulted printers are blocked.
- There is deliberately no option to flash from an arbitrary path or URL, and no cloud download.

## Alternatives considered
- Moonraker's repeater RPCs and HTTP: "dead ends" (module header).
- Adding firmware to the connector interface: rejected ("nothing here belongs to the status/control surface").

## Consequences
- Positive: network flashing without USB or cloud, with multiple safety gates.
- Negative: U1-only; the file-name check catches naming mistakes but is not proof of compatibility (stated in the release notes).

## Evidence
- `connectors/snapmaker-u1-firmware.js:1-50`; `server.js:24-28, 749, 1098`.
- Commit `4c78eba` body; RELEASE_NOTES 0.7.0 "Update Snapmaker U1 Firmware Over the Network".

## Confidence
Stated.
