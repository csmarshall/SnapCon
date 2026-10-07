# CLAUDE.md — working on this fork

This is Charles Marshall's fork (`csmarshall/SnapCon`) of SnapCon (MIT, https://github.com/ezeitoun/SnapCon), a local-first fleet manager built mainly for Snapmaker U1 printers. Node 22 + Express, vanilla JS front end, no build step except `pkg`.

**Fork-only file. Leave it, and `docs/adr/`, out of anything offered upstream.**

## What we are building

A household setup where several people slice in Orca on their own computers, push through SnapCon to one U1, and nobody juggles files or remembers settings. The core is a **replay library**: every push is archived automatically, can be re-sent, its slicer settings can be read and compared, and a new print can be recorded as a tweak of an old one.

Flow: `Orca (each person) → post-processing hook → SnapCon /api/notify-load → printer`, with SnapCon archiving each push on the way through.

**Current state lives in GitHub issues, not here** (`gh issue list --repo csmarshall/SnapCon`). The intended order at the time of writing:

1. #13 test against a simulated U1 (u1sim + Snapmaker's real Moonraker) and smoke-test the push path
2. #2 per-user push identity (spec on branch `feat/push-identity`, `docs/superpowers/specs/2026-10-06-push-identity-design.md`)
3. #11 keep the archive out of the Files tab and search
4. #3 Replay view
5. #12 timelapse pulled back and linked to its print
6. #4 editable 3MF for remixing, plus `basedOn` lineage

Also open: #8 (update check points at upstream releases), #5 (sub-path reverse proxy, parked, plan in the issue), PR #10 (`docs/adr/`: 33 retroactive ADRs and the maintainer heuristics).

## How work is done here

- **Issue first** for every change. Prefixed asks from Charles (`feature:`, `bug:`, `chore:`…) are filed as issues immediately.
- **Branch in a worktree outside the main checkout**: `~/work/claude/snapcon-worktrees/<n>-slug`.
- **PR into `main` with `Closes #n`.** The GitHub Actions `test` check (Node 22, `npm ci && npm test`) is the gate; a local "tests pass" is not.
- **Review before merge**: a reviewer subagent on the diff (`pr-review-toolkit` agents; `silent-failure-hunter` for anything with error handling), then Charles. **Squash-merge.**
- **Commit and PR titles follow upstream's style**: a plain-English subject in British spelling, no `feat:`/`docs:` prefixes, with `(#n)` at the end.
- **Test-first** (red, green, refactor). Every new test must be seen to fail first, and every check is tried against a known-bad version of the code before it is trusted.
- **Design specs** go in `docs/superpowers/specs/` and include a **Current design** section with GitHub permalinks pinned to the base commit SHA. Verify every link by printing the line it points to.
- **Upstream**: never send code first. No outside PR has ever been merged upstream; offer an issue with a short design and send code only if the maintainer wants it. Read `docs/adr/maintainer-heuristics.md` before designing anything you might offer upstream.

## Conventions (see also `.claude/skills/snapcon-conventions` and `snapcon-ui`)

- Look at how a neighbouring feature is built first. `audit/`, `sync/`, `queue/`, `library/` each own a directory and a small service object that `server.js` calls. Don't refactor the `server.js` monolith.
- Anything that can touch a network share goes through `netfs` (`stat`, `exists`, `readFile`, `writeFileExclusive`, `mkdir`, `rename`, `unlink`, `walk`…). User-supplied paths are jailed with `pathSafety.js`.
- Never overwrite user files; never delete user data. Optional features never block or fail a print.
- Routes stay greppable on one line with their guard (`requireAuth`, `requireRegular`, `requireAdmin`, or `need("<capability>")` for the Library). Roles: `admin`, `regular`, `view`.
- Audit: `auditLog.log({ category, event, ...actor, printerId, printerName, detail })`; actor from `actorFromReq(req)`.
- A new top-level module needs a Dockerfile `COPY` line (`test/docker.test.js` enforces it).
- UI: text from files or other users goes through `textContent` or `esc()`, never raw `innerHTML`; colours from the `[data-theme]` tokens; every string through `t()` with keys in both `locales-default/en.json` and `es.json`.
- Express is the only runtime dependency. Keep it that way.

## The replay archive (already on `main`)

`archivePush.js`, called from the raw-bytes branch of `/api/notify-load` through `archiveInBackground` (never awaited). Layout `<replayFolder>/<user>/<YYYY-MM-DD>/<file>`. A name is claimed by an exclusive create of an empty placeholder, the bytes go to a hidden `.<name>.<8hex>.partial`, then a rename (retried on `EPERM`/`EBUSY`/`EACCES`) over its own placeholder, so nothing is ever overwritten. Candidate names are plain, then `-<sha8>`, then `-<sha256>`; identical bytes are stored once. A case-insensitive per-folder queue allows at most 8 waiting pushes. `sweepPartials` clears interrupted leftovers at startup. Results are audited as `file-archived` / `file-archive-failed`.

## Running tests

- In CI: automatic on every PR.
- On rosa, in a container pinned to the same Node as CI and the image. Run it as your user, so `node_modules` isn't root-owned (only `docker` is passwordless under sudo on rosa; `rm` isn't):

  ```
  sudo -n docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$PWD":/app -w /app node:22 sh -c 'npm ci && npm test'
  ```

- On toad, about 18 remote-access/cloudflared and Bambu tests fail in the sandbox only (they need child processes and network access). CI is the authority.

## Deploying on rosa (planned, not done yet)

- Compose file: `/opt/sw/docker-compose/snapcon/`. App config and state (`config.json`, `users.json`, `audit-data/`, `sync-data/`, `data/`, `remote-access-data/`, `locales/`, `library-data/`): `/opt/sw/snapcon/`.
- **User data goes in its own datastore root, never mixed with app config**: it has a different retention and backup policy. Inside it, `gcode/` and `archive/` as separate directories; point `replayFolder` at the archive's own mount, not inside `gcode/`.
- **Timelapses and camera sync** get a configurable location. If none is set, they go in a separate directory inside the user-data datastore.
- Temp push files and anything regenerable can go on `/cache` (fast NVMe, not backed up).
- `/opt` is backed up by restic and has space. Whether the datastore is a separate ZFS dataset is decided at deploy time; Charles runs anything that needs `sudo` beyond `docker`.

## Not yet verified

Nothing has run against the real U1, a real Orca push, or a real network share. Two open questions in the push-identity spec need a real or simulated push: whether hooked Orca G-code carries the script path in `post_process`, and whether the remote hook really gets a 401 with logins on. Say plainly when something is unverified.
