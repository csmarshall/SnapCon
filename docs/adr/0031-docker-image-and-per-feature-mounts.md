# ADR-0031: Docker is a secondary target: a small node:22-alpine image running the same server, host networking for discovery, and one bind mount per persisted feature

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-07 (`4e293c3`); mount set expanded with each feature (users/remote-access after the "H-3" finding, audit-data/sync-data/data 0.5.0–0.7.0, locales 0.7.0, library-data 0.8.0 `515309c`)
- **Area:** Packaging / deployment

## Context
Always-on hosts (Raspberry Pi, NAS, homelab) want a container rather than a desktop binary. Recreating a container must not lose state, and network discovery needs the LAN.

## Decision
- `FROM node:22-alpine`, production dependencies only (express), with `devDependencies` (pkg) deleted at build time. An explicit `COPY` list covers every top-level module and directory `server.js` requires, enforced by `test/docker.test.js` (ADR-0030).
- `network_mode: host` on Linux so subnet discovery works. On Docker Desktop, use `ports` and add printers by IP.
- Every persisted feature gets its own mount: `config.json`, `users.json` (pre-created as a file), `gcode/`, `remote-access-data/`, `audit-data/`, `sync-data/`, `data/`, `locales/`, `library-data/`. SQLite and atomic-rename stores are mounted as directories because WAL sidecars and temp-then-rename need the same mount. Library locations are mounted read-only.
- `/.dockerenv` detection (`IS_DOCKER`) enables a "Restart App" button, relying on `restart: unless-stopped`.

## Alternatives considered
Single-file mounts for SQLite DBs: rejected because WAL `-wal`/`-shm` files would be lost on recreate.

## Consequences
- Positive: same code as the binaries; recreates keep users, tunnel identity, audit, queue, locales and the Library.
- Negative: every new persisted feature needs a compose change and documentation. A missing mount silently loses data on recreate. A missing `users.json` with `usersEnabled:true` locks everyone out. No published image yet (compose builds from source; `ghcr.io/ezeitoun/snapcon` is mentioned as future).

## Evidence
- `Dockerfile` (comments on the COPY list and locales); `docker-compose.yml` (per-mount comments).
- `server.js:74-81` (`IS_DOCKER`, line 81); `test/docker.test.js:1-12` (C-1, H-3).

## Confidence
Stated.
