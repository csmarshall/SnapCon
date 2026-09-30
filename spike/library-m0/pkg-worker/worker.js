// spike/library-m0/pkg-worker/worker.js — runs inside the Worker. Opens a
// SQLite database with node:sqlite, writes rows in the shape of the Library's
// files table plus an FTS5 index, and reads them back. Self-contained on
// purpose: the eval mode passes this file's source as a string, so it must not
// require anything relative.
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
(() => {
  const t0 = Date.now();
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); }
  catch (e) { parentPort.postMessage({ ok: false, error: "node:sqlite unavailable: " + e.message }); return; }
  try {
    const db = new DatabaseSync(workerData.dbPath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, root_id TEXT NOT NULL, rel_path TEXT NOT NULL,
               name TEXT NOT NULL, size INTEGER NOT NULL, content_key TEXT NOT NULL, meta_json TEXT,
               UNIQUE (root_id, rel_path));
             CREATE INDEX files_ck ON files(content_key);
             CREATE VIRTUAL TABLE fts USING fts5(name, tokenize='unicode61 remove_diacritics 2', prefix='2 3');`);
    const ins = db.prepare("INSERT INTO files (root_id, rel_path, name, size, content_key, meta_json) VALUES (?,?,?,?,?,?)");
    const insF = db.prepare("INSERT INTO fts (rowid, name) VALUES (?,?)");
    const words = ["Beardie", "Ferret", "Gecko", "Dragon", "Axolotl", "Lupa", "Hippo", "Kitty", "Snail", "Rex"];
    const tIns = Date.now();
    db.exec("BEGIN");
    for (let i = 0; i < workerData.rows; i++) {
      const name = `${words[i % 10]} ${i} (${i % 24}h${i % 60}m).gcode`;
      const r = ins.run("gcode", `U1/Designer ${i % 50}/${name}`, name, 50e6 + i, "q:" + i.toString(16).padStart(16, "0"),
        JSON.stringify({ printerModel: "Snapmaker U1", layer: 0.2, i }));
      insF.run(r.lastInsertRowid, name);
    }
    db.exec("COMMIT");
    const insertMs = Date.now() - tIns;
    const tQ = Date.now();
    const hits = db.prepare("SELECT count(*) c FROM fts WHERE fts MATCH 'gec*'").get().c;
    const one = db.prepare("SELECT id FROM files WHERE root_id=? AND rel_path=?").get("gcode", `U1/Designer 0/Beardie 1000 (16h40m).gcode`);
    const queryMs = Date.now() - tQ;
    const count = db.prepare("SELECT count(*) c FROM files").get().c;
    db.close();
    parentPort.postMessage({ ok: true, sqliteVersion: null, rows: count, ftsHits: hits, foundOne: !!one,
      insertMs, queryMs, workerMs: Date.now() - t0 });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
})();
