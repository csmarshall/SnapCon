# ADR-0010: Snapmaker U1 status is acquired by HTTP polling of Moonraker

- **Status:** Superseded by [ADR-0011](0011-u1-websocket-connector-delegating-to-http-original.md)
- **Date:** 2026-07-07 (`4e293c3`)
- **Area:** Printer integration (Snapmaker U1)

## Context
SnapCon's first job was a U1 fleet dashboard. Moonraker offers both HTTP `printer/objects/query` and a WebSocket `printer.objects.subscribe`.

## Decision
Each fleet poll issues a fresh HTTP `GET /printer/objects/query?…` per printer (print stats, heaters, extruders 0-3, toolhead, exclude_object, etc.) with a short timeout, and normalises the result. This logic later became the `snapmaker-u1-klipper` connector's `probe()`.

## Alternatives considered
None recorded.

## Consequences
- Positive: stateless, simple, robust to printer restarts.
- Negative: one full query per printer per tick; status is only as fresh as the poll; a Klipper shutdown underneath could leave stale values looking current (later addressed with staleness detection in ADR-0011).

## Evidence
- `4e293c3:server.js:458` (`/printer/objects/query?print_task_config&print_stats&…`).
- `connectors/snapmaker-u1-klipper.js` (retained as the delegate under ADR-0011).

## Confidence
Inferred. Polling is the evident initial implementation; no recorded rationale says it was chosen over WebSocket.
