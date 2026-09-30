// library/LibraryService.js — the only module server.js talks to for the
// Model Library (docs/library-design.md). M1 scope: the database, its
// backups, Library permissions, and Library locations with their live status.
// Indexing starts in M2.
"use strict";
const path = require("path");
const crypto = require("crypto");
const { createLibraryStore } = require("./LibraryStore");
const { createAuthorizer } = require("./permissions");
const { createWorkerHost } = require("./WorkerHost");
const { normalizeLocation, comparisonKey, overlaps, checkReachable } = require("./locations");

const GCODE_ROOT = "gcode";
const NAME_MAX = 60;
const SCAN_MIN = 5, SCAN_MAX = 1440, SCAN_DEFAULT = 30;
const OFFLINE_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000];   // then the location's own interval (§10)
const TICK_MS = 15 * 1000;
const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
const BACKUP_CHECK_MS = 60 * 60 * 1000;

class LibraryError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createLibraryService({
  baseDir, getGcodeFolder, audit = () => {}, log = console, now = Date.now,
  platform = process.platform, checkTimeoutMs = 10000, workerOptions = {},
  checkFn = checkReachable,   // injectable for tests
}) {
  const store = createLibraryStore({ baseDir, now, log }).open();
  const authz = store.available ? createAuthorizer(store.db) : null;
  let worker = null;
  let tickTimer = null, backupTimer = null;
  const probe = new Map();   // rootId -> { failures, nextAt, inFlight, realPath }
  let probeChain = Promise.resolve();

  const requireAvailable = () => {
    if (!store.available) throw new LibraryError(503, "library_unavailable", "The Library is unavailable: " + store.reason);
  };
  const stateOf = id => { if (!probe.has(id)) probe.set(id, { failures: 0, nextAt: 0, inFlight: false, realPath: null }); return probe.get(id); };

  function view(r) {
    const s = probe.get(r.id);
    return {
      id: r.id, name: r.name, path: r.path, grouping: r.grouping, enabled: !!r.enabled,
      scanEveryMin: r.scan_every_min, status: r.status, lastOkAt: r.last_ok_at, lastScanAt: r.last_scan_at,
      lastError: r.last_error, isGcodeFolder: r.id === GCODE_ROOT, checking: !!(s && s.inFlight),
    };
  }

  // One reachability check at a time, across all locations. On Windows a
  // first contact with an unreachable host holds one of libuv's four shared
  // filesystem threads for ~21 s whatever timeout we set (measured in M1).
  // Serialising means the Library can tie up at most one of them.
  function checkRoot(id) {
    const st = stateOf(id);
    const current = store.available && store.roots.get(id);
    if (st.inFlight) {
      // A check of the same folder is already coming; a check of a folder the
      // location no longer points at is not good enough — queue a fresh one.
      if (!current || st.checkingPath === current.path) return st.inFlight;
      return st.inFlight.then(() => checkRoot(id));
    }
    if (current) st.checkingPath = current.path;
    const run = probeChain.then(async () => {
      const r = store.available && store.roots.get(id);
      if (!r) return null;
      const res = await checkFn(r.path, { timeoutMs: checkTimeoutMs });
      const now_ = store.roots.get(id);
      if (!now_) return null;   // removed meanwhile
      // The G-code folder can move while a check of its old path is running;
      // that answer is about somewhere else and must not be recorded.
      if (now_.path !== r.path) { st.nextAt = 0; return view(now_); }
      if (res.status === "ok") {
        st.failures = 0; st.realPath = res.realPath || r.path;
        st.nextAt = now() + r.scan_every_min * 60 * 1000;
        // A G-code folder that overlaps another location stays in error.
        const clash = overlapping(r.path, st.realPath, id);
        if (clash) store.roots.setStatus(id, { status: "error", error: `overlaps the location "${clash.name}"` });
        else store.roots.setStatus(id, { status: "ok", lastOkAt: now() });
      } else {
        st.failures = res.status === "offline" ? st.failures + 1 : 0;
        const backoff = res.status === "offline" ? OFFLINE_BACKOFF_MS[st.failures - 1] : undefined;
        st.nextAt = now() + (backoff || r.scan_every_min * 60 * 1000);
        store.roots.setStatus(id, { status: res.status, error: res.error || null });
      }
      return view(store.roots.get(id));
    });
    st.inFlight = run.finally(() => { st.inFlight = false; });
    probeChain = run.catch(e => log.error("[library] location check failed: " + e.message));
    return st.inFlight;
  }

  // Another location this path would overlap, compared by the path as given
  // and by where it really points (symlinks, junctions). null if none.
  function overlapping(p, real, exceptId) {
    for (const r of store.roots.list()) {
      if (r.id === exceptId) continue;
      const other = [r.path, stateOf(r.id).realPath].filter(Boolean);
      for (const a of [p, real].filter(Boolean)) for (const b of other) if (overlaps(a, b, platform)) return r;
    }
    return null;
  }

  function validName(name, fallback) {
    const n = String(name == null ? "" : name).trim() || fallback;
    if (!n) throw new LibraryError(400, "name_required", "Give the location a name.");
    if (n.length > NAME_MAX) throw new LibraryError(400, "name_too_long", `A location name can be at most ${NAME_MAX} characters.`);
    return n;
  }
  function validInterval(v) {
    if (v === undefined || v === null || v === "") return SCAN_DEFAULT;
    const n = Number(v);
    if (!Number.isInteger(n) || n < SCAN_MIN || n > SCAN_MAX) throw new LibraryError(400, "bad_interval", `The check interval must be ${SCAN_MIN}–${SCAN_MAX} minutes.`);
    return n;
  }

  // ---- public API ----

  async function addRoot(input, actor = {}) {
    requireAvailable();
    const abs = normalizeLocation(input && input.path, { baseDir, platform });
    if (!abs) throw new LibraryError(400, "path_required", "Enter the folder's path.");
    const grouping = (input && input.grouping) || "folders";
    if (!["folders", "files"].includes(grouping)) throw new LibraryError(400, "bad_grouping", "Unknown grouping mode.");
    const name = validName(input && input.name, path.basename(abs) || abs);
    const scanEveryMin = validInterval(input && input.scanEveryMin);
    const lexical = overlapping(abs, null, null);
    if (lexical) throw new LibraryError(409, "overlap", `This folder overlaps the location "${lexical.name}". A folder can belong to only one location.`);
    const res = await checkFn(abs, { timeoutMs: checkTimeoutMs });
    if (res.status !== "ok") {
      throw new LibraryError(400, res.status === "offline" ? "unreachable" : "not_a_folder",
        res.status === "offline" ? `SnapCon can't reach this folder right now (${res.error}).` : `This path can't be used: ${res.error}.`);
    }
    const real = overlapping(abs, res.realPath, null);
    if (real) throw new LibraryError(409, "overlap", `This folder is the same place as, or overlaps, the location "${real.name}". A folder can belong to only one location.`);
    const id = "loc_" + crypto.randomBytes(6).toString("hex");
    store.roots.insert({ id, name, path: abs, grouping, enabled: true, scan_every_min: scanEveryMin, created_at: now(), created_by: actor.userId || null });
    store.roots.setStatus(id, { status: "ok", lastOkAt: now() });
    Object.assign(stateOf(id), { realPath: res.realPath || abs, failures: 0, nextAt: now() + scanEveryMin * 60 * 1000 });
    audit("location-added", actor, { id, name, path: abs, grouping });
    return view(store.roots.get(id));
  }

  function updateRoot(id, patch, actor = {}) {
    requireAvailable();
    const r = store.roots.get(id);
    if (!r) throw new LibraryError(404, "not_found", "No such location.");
    const f = {};
    if (patch.name !== undefined) f.name = validName(patch.name, null);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new LibraryError(400, "bad_enabled", "enabled must be true or false.");
      f.enabled = patch.enabled;
    }
    if (patch.scanEveryMin !== undefined) f.scan_every_min = validInterval(patch.scanEveryMin);
    if (patch.grouping !== undefined) {
      // D8: the G-code folder groups individual files; its folders are organisational.
      if (id === GCODE_ROOT) throw new LibraryError(400, "gcode_grouping_fixed", "The G-code folder always groups individual files.");
      if (!["folders", "files"].includes(patch.grouping)) throw new LibraryError(400, "bad_grouping", "Unknown grouping mode.");
      f.grouping = patch.grouping;
    }
    if (patch.path !== undefined) throw new LibraryError(400, "path_fixed", "A location's folder can't be changed. Remove it and add the new folder instead.");
    store.roots.update(id, f);
    if (f.enabled === true) stateOf(id).nextAt = 0;
    audit("location-updated", actor, { id, name: r.name, changes: Object.keys(f) });
    return view(store.roots.get(id));
  }

  function removeRoot(id, actor = {}) {
    requireAvailable();
    if (id === GCODE_ROOT) throw new LibraryError(400, "gcode_fixed", "The G-code folder is set in General settings and can't be removed here.");
    const r = store.roots.get(id);
    if (!r) throw new LibraryError(404, "not_found", "No such location.");
    store.roots.remove(id);
    probe.delete(id);
    audit("location-removed", actor, { id, name: r.name, path: r.path });
    return { ok: true };
  }

  async function rescan(id) {
    requireAvailable();
    if (!store.roots.get(id)) throw new LibraryError(404, "not_found", "No such location.");
    // M1: a Rescan re-checks reachability. M2 makes it index the location.
    return checkRoot(id);
  }

  // The G-code folder is always a location, mirroring Settings → General.
  function syncGcodeRoot() {
    if (!store.available) return;
    const abs = normalizeLocation(getGcodeFolder(), { baseDir, platform });
    const r = store.roots.get(GCODE_ROOT);
    if (!r) {
      store.roots.insert({ id: GCODE_ROOT, name: "G-code folder", path: abs, grouping: "files", enabled: true, scan_every_min: SCAN_DEFAULT, created_at: now() });
    } else if (comparisonKey(r.path, platform) !== comparisonKey(abs, platform)) {
      store.roots.update(GCODE_ROOT, { path: abs });
      store.roots.setStatus(GCODE_ROOT, { status: "pending" });
      Object.assign(stateOf(GCODE_ROOT), { realPath: null, failures: 0 });
    } else return;
    stateOf(GCODE_ROOT).nextAt = 0;
    if (tickTimer) checkRoot(GCODE_ROOT);
  }

  async function backupNow(reason = "manual") {
    requireAvailable();
    if (!worker) throw new LibraryError(503, "worker_down", "The Library worker is not running.");
    try {
      const res = await worker.request("backup", { dbPath: store.dbPath, backupsDir: store.backupsDir, reason });
      log.log(`[library] backup ${res.file} (${Math.round(res.bytes / 1024)} KB, ${res.ms} ms)`);
      return res;
    } catch (e) {
      log.error("[library] backup failed: " + e.message);
      throw new LibraryError(500, e.code === "LIBRARY_DB_CORRUPT" ? "db_corrupt" : "backup_failed", "Backup failed: " + e.message);
    }
  }

  function backupDue() {
    const newest = store.listBackups().find(b => b.reason !== "pre-migration");
    if (!newest) return true;
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(newest.stamp);
    const at = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
    return now() - at >= BACKUP_EVERY_MS;
  }

  function tick() {
    if (!store.available) return;
    for (const r of store.roots.list()) {
      if (!r.enabled) continue;
      const st = stateOf(r.id);
      if (!st.inFlight && now() >= st.nextAt) checkRoot(r.id).catch(() => {});
    }
  }

  function start() {
    if (!store.available) return;
    worker = createWorkerHost({ log, ...workerOptions });
    syncGcodeRoot();
    tick();
    tickTimer = setInterval(tick, TICK_MS); tickTimer.unref();
    const maybeBackup = () => { if (store.available && backupDue()) backupNow("nightly").catch(() => {}); };
    const first = setTimeout(maybeBackup, 60 * 1000); first.unref();
    backupTimer = setInterval(maybeBackup, BACKUP_CHECK_MS); backupTimer.unref();
  }

  async function stop() {
    clearInterval(tickTimer); clearInterval(backupTimer); tickTimer = backupTimer = null;
    if (worker) await worker.stop().catch(() => {});
    store.close();
  }

  function status() {
    const backups = store.available ? store.listBackups() : [];
    return {
      available: store.available, reason: store.reason, schemaVersion: store.schemaVersion(),
      recovery: store.recovery,
      worker: worker ? worker.mode : null,
      backups: { count: backups.filter(b => b.reason !== "pre-migration").length, newest: backups.find(b => b.reason !== "pre-migration") || null },
    };
  }

  return {
    get available() { return store.available; },
    status, start, stop,
    can: (user, cap) => !!authz && authz.can(user, cap),
    listRoots: () => (store.available ? store.roots.list().map(view) : []),
    addRoot, updateRoot, removeRoot, rescan, syncGcodeRoot, backupNow,
    rebuildDerived: () => { requireAvailable(); return store.rebuildDerived(); },
    _store: store, _checkRoot: checkRoot, _tick: tick,
  };
}

module.exports = { createLibraryService, LibraryError, GCODE_ROOT };
