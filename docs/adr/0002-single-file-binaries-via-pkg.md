# ADR-0002: Ship as single-file desktop executables built with pkg, with a BASE_DIR / ASSET_DIR split

- **Status:** Accepted (retroactive)
- **Date:** 2026-07-07 (`4e293c3`)
- **Area:** Packaging / distribution

## Context
The target user runs a print farm, not a Node toolchain. The README's "Download (no Node.js needed)" section is the primary install path; Docker (ADR-0031) and "run from source" are secondary.

## Decision
- Build per-OS single executables with `@yao-pkg/pkg` (`package.json` `build` script and `pkg` block: targets `node22-win-x64`, `node22-macos-x64`, `node22-macos-arm64`, `node22-linux-x64`; `--no-bytecode --public`).
- Bundle read-only assets (`public/**`, `parser.js`, `locales-default/**`) into the snapshot; list worker entry points explicitly in `pkg.scripts` (`library/indexer-worker.js`, `netfs/netfs-worker.js`) rather than relying on pkg's path-literal heuristic.
- At runtime, `IS_PKG` selects `BASE_DIR = dirname(process.execPath)` for every writable file (config.json, users.json, gcode/, *-data/, locales/), while `ASSET_DIR = __dirname` points into the snapshot.
- Releases are built by GitHub Actions on each OS's **native** runner (no cross-compiling); Intel-mac is a separate best-effort job that must not block the release.

## Alternatives considered
- Cross-compiling all four targets from one machine (the original `npm run build`). 0.4.6 release notes record "build-process fixes so macOS binaries built on Windows actually launch"; the CI workflow avoids this by building natively.
- Native addons (e.g. keytar, better-sqlite3) were avoided specifically because of this packaging model (ADR-0004, ADR-0007).

## Consequences
- Positive: zero-install for end users; the same server code runs in Docker and in the binary.
- Negative: every new writable path must be placed under `BASE_DIR`, never next to source; every new worker file must be added to `pkg.scripts`.
- Negative: constrains dependency choices for the life of the project (no native addons).
- Negative: version strings cannot be read from `package.json` uniformly in both modes, so they are literals pinned by a test (ADR-0030).

## Evidence
- `package.json` `scripts.build`, `pkg.assets`, `pkg.scripts`.
- `server.js:65-72` (IS_PKG / BASE_DIR / ASSET_DIR comment).
- `.github/workflows/release.yml` header (native runners, Intel-mac best-effort).
- `library/WorkerHost.js:9-11` and `docs/library-design.md` §21 P5 (explicit `pkg.scripts` entry); §22 "A dynamic require in the fallback path, which pkg could not bundle, was replaced with a static one".
- `test/versionConsistency.test.js` header.

## Confidence
Stated.
