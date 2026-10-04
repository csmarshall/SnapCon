# Brief: wire up Settings > Firmware > Deploy for the Snapmaker U1

Paste this to Claude Code in the SnapCon repo. It describes a wiring job, not a
new subsystem — most of the work already exists.

---

## Task

Make the **Deploy** button in Settings > Firmware actually flash firmware to a
Snapmaker U1 over the LAN. Today it does nothing: `public/app.js` binds
`#fwDeploy` to a handler that sets `settings.firmware.deploy_not_implemented`
and stops.

The printer-side protocol is solved and implemented. `connectors/snapmaker-u1-firmware.js`
already exists, is tested against a mock printer, and was verified end to end
against real hardware on 2026-08-26 (1.5.2.13 → 1.6.0.267 over the network,
no USB, no cloud). **Do not reimplement or "improve" the protocol.** Read that
file's header comment first; it explains every non-obvious decision and the
reasoning is not re-derivable from the Snapmaker source.

## Read before writing anything

1. `connectors/snapmaker-u1-firmware.js` — the whole file, header included.
2. `CLAUDE.md` sections: *Destructive actions*, *Action scope*, *Settings*,
   *Printer network operations*, *Prefer existing patterns*, *Scope discipline*.
3. `server.js` around line 502 — `GET /api/firmware-files`, and the comment
   above it, which explicitly says extension filtering is *Deploy's* job:
   "which files a given connector accepts is a question for Deploy, which has
   the connector in hand and must revalidate whatever it is given anyway."
4. `test/firmwareFiles.test.js` — the containment contract you must not break.
5. `public/app.js` around line 8156 — `SELECTED_FIRMWARE` and the picker.

## What already exists (do not rebuild)

- **Firmware folder config**: `CFG.firmwareFolder`, editable in Settings.
- **File picker**: `GET /api/firmware-files`, admin-only, speaks only in paths
  relative to the firmware folder, jailed by `pathSafety.resolveWithinFolder()`,
  skips symlinks.
- **Frontend state**: `SELECTED_FIRMWARE = { name, path }` where `path` is
  relative to the firmware folder. `#fwSelect` populates it, `#fwStatus` is the
  status line, `#fwGet` loads current firmware info.
- **The connector module**: upload with free-space precheck, MD5 verify,
  flash, progress watch, cleanup, and `updateFromFile()` orchestrating all of it.

## What to build

### 1. `POST /api/firmware-deploy` in `server.js`

- `requireAdmin`. This is more destructive than anything currently behind
  `requireRegular`.
- Body: `{ printer, path }` where `path` is **relative** to the firmware
  folder, exactly like the picker returns. Reject absolute paths outright.
- Resolve with `resolveWithinFolder()` against `path.resolve(BASE_DIR, CFG.firmwareFolder)`
  — the same jail as the listing route, for the same reason. Reject symlinks with
  `lstat` as that route does.
- Refuse if the printer's connector lacks the new `firmwareDeploy` capability
  (see 3), mirroring how `/api/exclude` refuses when `c.excludeObject` is absent.
- Refuse if the printer is printing. Flashing mid-print destroys the job.
- Call `updateFromFile()` from the connector module.
- Audit with `category: "admin"`, an event name like `firmware-deploy`,
  `...actorFromReq(req)`, `printerId`, `printerName`, and a detail carrying the
  file name and the before/after versions. This is the single most consequential
  action in the product; the audit entry matters more than the response body.
- Errors: `502` with `{ error: e.message }`, matching the sibling routes.

### 2. Frontend in `public/app.js`

Replace the `#fwDeploy` stub. Follow the *Destructive actions* rules:

- Confirmation must name what happens, not "Are you sure?". Something like
  `Flash U1 Purple with 1.6.0.267?` — printer name and firmware version, not a
  generic warning.
- Danger role on the button. It must not resemble the adjacent safe controls.
- Tell the user before they commit that the printer will go offline for several
  minutes and must not lose power.
- While it runs, `#fwStatus` should reflect the real phase. `updateFromFile()`
  takes an `onStep` callback emitting `device`, `upload`, `uploaded`, `verify`,
  `verified`, `flash`, `progress`. A single spinner for a multi-minute
  upload-then-verify-then-flash sequence is not good enough; the user needs to
  know whether it is still uploading or already writing.
- **A dropped connection at the flash stage is success, not failure.**
  `updateFromFile()` returns `outcome: "disconnected"` and `after: null` when
  the printer went offline to write the image. Report that as "flashing, the
  printer will return in a few minutes", never as an error. Getting this
  backwards will make correct behavior look broken and tempt someone into
  power-cycling mid-flash.

### 3. Capability flag

Add `firmwareDeploy: true` to `exports.capabilities` in
`connectors/snapmaker-u1-klipper.js`. The `-ws` connector re-exports that object,
so it inherits it. **Do not set it on any other connector** — this protocol is
U1-specific and unverified anywhere else. Check whether
`connector-compat-test.js` needs the new flag registered.

Per the project's positioning rule: this is a U1 capability. Frame any gap on
other brands as a hardware or API limit, not a backlog item.

### 4. i18n

Every user-visible string needs a key in **both** `locales-default/en.json` and
`locales-default/es.json`. Replace `settings.firmware.deploy_not_implemented`
rather than leaving it orphaned. Bump `_meta.version` in both. Raw keys must
never reach the UI.

### 5. Tests

`npm test` is `node --test "test/**/*.test.js"`. Add `test/firmwareDeploy.test.js`
following the pattern `test/firmwareFiles.test.js` established — `server.js`
cannot be required because it starts a listener, so test the path-containment
rule directly and assert the route's wiring against its source text. At minimum:

- A relative path escaping the firmware folder is rejected.
- An absolute path from the browser is rejected.
- The route is admin-only.
- The connector module's `startLocalUpgrade` rejects a non-absolute printer path.

## Hard constraints

These come from the hardware investigation. Violating them produces code that
looks correct and fails on real printers.

- **Never report success from an RPC reply.** unisrv answers
  `{"state":"success"}` to `system.upgrade` even for a file that does not exist.
  The real outcome arrives later on `system/notification`. The module already
  handles this; do not "simplify" it away.
- **Never skip verification.** A truncated upload that passes a size check is
  the realistic way this bricks a printer. `updateFromFile()` aborts before
  flashing on mismatch. Keep it. The default mode is `"crc"`, which makes the
  PRINTER compute the checksum (zip with `store_only`, read the CRC-32 out of
  the archive's central directory over a Range request) and moves about a
  kilobyte instead of the whole image. `"md5"` downloads and hashes everything;
  `"sample"` compares a few Range-fetched windows and is the automatic fallback
  when the zip endpoint is unavailable. Measured behavior: `crc` and `md5` both
  catch a single flipped byte, `sample` does not — it catches truncation and
  torn writes only. Do not make `sample` the default.
- **Do not route firmware calls through the repeater.** `repeater.py`'s
  `system.*` handler hangs forever on shipped firmware. The module deliberately
  talks to the MQTT bus via `server.mqtt.publish` / `server.mqtt.subscribe`.
- **Do not use HTTP for `system.*`.** Those endpoints are registered with the
  HTTP transport excluded; `GET /system/get_device_info` genuinely 404s. There
  is no curl-able firmware endpoint. Do not document one.
- **Keep the timeouts explicit.** Moonraker's MQTT publish and subscribe
  handlers wait forever without a `timeout` param.

## Where the image goes on the printer

The module uploads to the `gcodes` root (`/userdata/gcodes`). That is a
deliberate choice, not a default nobody thought about:

- Snapmaker has **no firmware directory**. The touchscreen's Local Update reads
  from the USB mount (`/mnt/udisk`, surfaced under gcodes as `.udisk`), and the
  u1-klipper README uses `/tmp` for MCU images. Neither is somewhere Moonraker
  can upload to.
- `gcodes` and `config` are the only writable roots. `config` is
  `/oem/printer_data/config` — the OEM partition, with its own separate space
  accounting. A 250 MB image does not belong there.
- **A `.bin` in `gcodes` is invisible to the print file manager.**
  `/server/files/list?root=gcodes` filters to `VALID_GCODE_EXTS`
  (`.gcode .g .gco .ufp`), and metadata scanning skips non-gcode extensions
  entirely. So the upload pollutes nothing and costs no metascan.

The flip side of that invisibility: an image orphaned by an interrupted update
is invisible to the user too, silently holding a quarter gigabyte. Two
consequences for the implementation:

- Cleanup must be reliable. `updateFromFile()` deletes on verify failure, on
  reported flash failure, and after the printer returns.
- Use `listImages()` to sweep for orphans. It reads
  `/server/files/directory`, which unlike the file list does *not* filter by
  extension. Consider surfacing a stray image in Settings > Firmware with a
  delete affordance; nothing else in SnapCon will ever show it.

`uploadFirmware()` takes a `subdir` option if you decide a `.firmware/`
subfolder is tidier. Untested on hardware — the flashed-for-real path put the
image at the root of `gcodes`, so change it only with a printer in front of you.

Free-space math is already conservative: Moonraker subtracts a fixed 1400 MB
`RESERVED_USER_SPACE` before reporting free space, so what `getFreeBytes()`
returns is user space that really is available.

## Security note to carry into the code

`/access/info` on a U1 returns `trusted: true` for any client on a private LAN.
No key, no token, no pairing. Anything on the network can upload a file to a U1
and tell it to flash that file as firmware. That is why the route is
`requireAdmin` and jailed to a configured folder: SnapCon should not be the
thing that makes this easy to do by accident. Do not add an option to point
Deploy at an arbitrary path or a remote URL.

## Out of scope

- Downloading firmware from Snapmaker. `system.upgrade_check_remote` and
  `system.upgrade_download_firmware` both require the cloud and fail with
  `cloud not connected` on a LAN-only printer. The admin supplies the file.
- Fleet-wide or multi-printer deploy. One printer at a time. If you later add
  multi-select, the *Action scope* rule applies: the button must name the count.
- MCU-level flashing (`systemUpgrade.sh upgrade mcu0 ...`). Different operation,
  different risk, not this task.
- Touching `snapmaker-u1-klipper-ws.js`'s status path or its WebSocket. The
  firmware module opens its own connections on purpose.

## Acceptance

- Deploy flashes a real U1 and the version reported by `#fwGet` changes.
- A path outside the firmware folder is rejected by the route, with a test.
- A non-admin cannot reach the route.
- A mid-flash disconnect is reported as progress, not an error.
- `npm test` passes.
- No new runtime dependency in `package.json`. Node 22 provides `WebSocket`,
  `fetch`, `FormData` and `fs.openAsBlob`; the module uses only those.
- Add a `RELEASE_NOTES.md` entry.

## One known nit, your call whether to fix here

`cameraRpc()` in `snapmaker-u1-klipper.js` builds its WebSocket URL from
`.hostname`, dropping any configured port, and resolves on the first message
rather than matching a request id — so it reports success even when nothing
answered. Harmless for fire-and-forget camera calls. The firmware module uses
`.host` and matches ids, and documents the divergence. Fixing `cameraRpc` is a
separate change with its own risk; do not bundle it into this one.
