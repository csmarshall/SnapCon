// library/routes.js — the Library's HTTP routes. Thin: authentication comes
// from server.js's requireAuth, authorisation from Library capabilities
// (library/permissions.js), everything else from LibraryService.
"use strict";

function registerLibraryRoutes(app, { library, requireAuth, actorFromReq }) {
  // Capability check; the Library being unavailable is a 503, not a 403.
  const need = cap => (req, res, next) => {
    if (!library.available) return res.status(503).json({ error: "The Library is unavailable: " + (library.status().reason || "unknown"), code: "library_unavailable" });
    if (!library.can(req.user, cap)) return res.status(403).json({ error: "You don't have permission to do this.", code: "forbidden" });
    next();
  };
  const send = (res, fn) => Promise.resolve().then(fn).then(
    out => res.json(out),
    e => (e && e.status ? res.status(e.status).json({ error: e.message, code: e.code }) : res.status(500).json({ error: e.message, code: "internal" })),
  );

  // Available to anyone signed in, so the UI can say why the Library is off.
  // Recovery details and backup files only for those who manage backups.
  app.get("/api/library/status", requireAuth, (req, res) => {
    const s = library.status();
    const admin = library.available && library.can(req.user, "library.backup");
    res.json(admin ? s : { available: s.available, reason: s.available ? null : s.reason, schemaVersion: s.schemaVersion });
  });

  // A location's folder is only shown to those who manage locations: it can be
  // an internal UNC path.
  app.get("/api/library/roots", requireAuth, need("library.view"), (req, res) => {
    const withPaths = library.can(req.user, "library.sources.manage");
    res.json({ roots: library.listRoots().map(r => (withPaths ? r : { ...r, path: undefined })) });
  });
  app.post("/api/library/roots", requireAuth, need("library.sources.manage"), (req, res) =>
    send(res, () => library.addRoot(req.body || {}, actorFromReq(req))));
  app.patch("/api/library/roots/:id", requireAuth, need("library.sources.manage"), (req, res) =>
    send(res, () => library.updateRoot(req.params.id, req.body || {}, actorFromReq(req))));
  app.delete("/api/library/roots/:id", requireAuth, need("library.sources.manage"), (req, res) =>
    send(res, () => library.removeRoot(req.params.id, actorFromReq(req))));
  app.post("/api/library/roots/:id/rescan", requireAuth, need("library.sources.manage"), (req, res) =>
    send(res, () => library.rescan(req.params.id)));
  app.post("/api/library/backup", requireAuth, need("library.backup"), (req, res) =>
    send(res, () => library.backupNow("manual")));
}

module.exports = { registerLibraryRoutes };
