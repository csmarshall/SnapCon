# ADR-0014: Cameras use three transports: throttled server-side snapshots, a server-side live relay for credentialed RTSP, and browser-direct WebRTC

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-25 snapshot throttle with Camera View (`e008a64`, 0.2.0); 2026-08-25 WebRTC (`0bce30e`); 2026-09-16 RTSP relay (`30a7862`)
- **Area:** Cameras

## Context
Camera View re-requests every printer's frame on every fleet tick. Hitting the camera hardware that often is expensive: the U1 needs an RPC plus a wait, and FlashForge needs a fresh MJPEG connection. Some cameras have no still-image URL at all: Creality SPARKX i7 is WebRTC-only, and Bambu serves credentialed RTSPS that no browser can open.

## Decision
1. **Snapshots** go through `/api/snapshot`. A per-printer server cache whose TTL equals the user-visible `cameraViewRefreshInterval`, with in-flight de-duplication, makes the real request rate follow the setting "regardless of how often the client happens to ask". `?fresh=1` (explicit user action) bypasses it. The fleet poll is not slowed for this. Optional client-side staggering spreads a large fleet's requests. Camera quirks (U1 start/stop cooldown) live in the connector, not the server.
2. **Live relay** (`/api/camera-stream`) is for cameras only the server can reach. One upstream session per printer is fanned out to all viewers as fragmented MP4 for Media Source Extensions. It opens on the first viewer and closes shortly after the last. Late joiners are replayed the current GOP, and slow viewers are dropped rather than buffered. Still frames need an optional `ffmpeg`.
3. **WebRTC** is browser-to-printer, used only when no snapshot camera is found. Peer connections are gated on tile visibility. It does not work over Remote Access (the UI says "local network only"), and these printers get no notification images.

## Alternatives considered
- WebCodecs for the relay: rejected because plain-http LAN pages are not a secure context (`h264-fmp4.js`).
- Server-side WebRTC capture for notifications: not done ("a WebRTC camera can only be read by a browser", RELEASE_NOTES 0.7.0).

## Consequences
- Positive: bounded load on camera hardware; ten tabs still mean one upstream connection; no transcoding CPU.
- Negative: three code paths with different reachability (WebRTC is LAN-only) and different notification support.
- The snapshot cache is keyed by printer array index (see ADR-0006).

## Evidence
- `server.js:2855-2927` (`getSnapshot`, `getSnapshotThrottled` comment), `server.js:2917-2929` (live relay comment).
- `connectors/bambu-camera.js:1-19`; `connectors/h264-fmp4.js:5-10`; `connectors/snapmaker-u1-klipper.js:469-475` (cooldown).
- RELEASE_NOTES 0.2.0 "Camera View", 0.7.0 "Live Camera for WebRTC-Only Printers", 0.7.1.
- Commit `0bce30e`.

## Confidence
Stated.
