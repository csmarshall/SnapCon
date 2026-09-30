# Library M0 spike

Throwaway measurement code for milestone **M0** of the Model Library
(`docs/library-design.md` §15). None of it is wired into the app, and nothing
here is required by `server.js`. It exists to replace design estimates with
measured numbers before M1.

| Script | Measures | Writes |
|---|---|---|
| `pkg-worker/` | `worker_threads` + `node:sqlite` inside a `pkg` build (risk R3) | a test DB next to the exe |
| `synthetic-db.js [files] [outDir]` | size and query cost of the canonical schema at 10k / 50k / 100k files, the share of Claims and Evidence, and rebuild survival | DB files in `outDir` (default: a temp dir) |
| `smb-enum.js <root>…` | enumeration (opendir + stat) at concurrency 1 and 8, quick-fingerprint and head/tail read cost | nothing (read-only) |
| `gcode-offsets.js <root>` | how far into a real G-code the extractor must read | nothing (read-only) |
| `zipRangeReader.js` | prototype of the M3 range-read zip reader (zip64, unicode names, data descriptors, CRC) | — |
| `zip-check.js <file.3mf>…` | that reader against real 3MFs, compared with `threemf.js` | nothing (read-only) |
| `schema.sql` | the canonical §5 schema, plus the one index M0 found missing (`files_container`) | — |

Build the packaged worker test with the same flags as `npm run build`:

```bash
cd spike/library-m0/pkg-worker
../../../node_modules/.bin/pkg . --targets node22-win-x64 --out-path <dir> --no-bytecode --public
<dir>/snapcon-library-m0-pkg-worker.exe 20000
```

The reader's tests live in `test/library-spike/` so `npm test` runs them.
