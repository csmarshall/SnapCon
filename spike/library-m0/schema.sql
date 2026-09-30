-- ================================ AUTHORED ================================

CREATE TABLE roots (
  id TEXT PRIMARY KEY,                       -- 'gcode' = implicit root mirroring CFG.gcodeFolder
  name TEXT NOT NULL, path TEXT NOT NULL,
  grouping TEXT NOT NULL DEFAULT 'folders' CHECK (grouping IN ('folders','files')),
  enabled INTEGER NOT NULL DEFAULT 1,
  scan_every_min INTEGER NOT NULL DEFAULT 30,
  full_hash TEXT NOT NULL DEFAULT 'idle' CHECK (full_hash IN ('off','idle')),
  created_at INTEGER NOT NULL, created_by TEXT,
  -- runtime status, written by the indexer:
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','scanning','ok','offline','error')),
  last_scan_at INTEGER, last_ok_at INTEGER, last_error TEXT);

CREATE TABLE models (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('auto','user')),        -- who created the row
  name TEXT NOT NULL,
  name_source TEXT NOT NULL DEFAULT 'auto' CHECK (name_source IN ('auto','user')),
  anchor_root TEXT, anchor_path TEXT,        -- folders-mode anchor (a location, not a row id)
  design_model_id TEXT,
  designer TEXT, source_url TEXT, license TEXT, notes TEXT,
  cover_content_key TEXT, cover_plate INTEGER,
  cover_source TEXT NOT NULL DEFAULT 'auto' CHECK (cover_source IN ('auto','user')),
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
CREATE INDEX models_design ON models(design_model_id);

CREATE TABLE model_anchors (                 -- last-known membership, used to re-find Models after a rebuild
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  content_key TEXT NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (model_id, content_key));
CREATE INDEX model_anchors_key ON model_anchors(content_key);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('file','variant','model','print')),
  subject_key TEXT NOT NULL,                 -- content key | content key#plate | model uuid | print id
  relation TEXT NOT NULL CHECK (relation IN
    ('member_of','distinct_from','source_of','sliced_from','targets_printer','printed_as','hidden')),
  polarity TEXT NOT NULL DEFAULT 'affirm' CHECK (polarity IN ('affirm','reject')),
  object_type TEXT,                          -- model|file|variant|project|printer_family|NULL (attribute)
  object_key TEXT,
  value_json TEXT,                           -- e.g. {"printer_family":"snapmaker-u1"}, {"plate":2}
  subject_hint TEXT,                         -- last known "root:rel_path", for display and Re-link
  reason TEXT,
  from_claim_key TEXT,                       -- the Claim this confirmed or rejected
  evidence_snapshot_json TEXT,               -- that Claim's Evidence at decision time
  created_by TEXT, created_at INTEGER NOT NULL,
  superseded_by INTEGER REFERENCES decisions(id));   -- undo = supersede; history kept
CREATE INDEX decisions_subject ON decisions(subject_type, subject_key, relation);
CREATE INDEX decisions_object  ON decisions(object_type, object_key);

CREATE TABLE prints (
  id INTEGER PRIMARY KEY,
  content_key TEXT,                          -- linked File; NULL = unlinked
  plate_no INTEGER,
  model_uuid_at_link TEXT,                   -- snapshot fallback; the current Model is resolved via content_key
  printer_id TEXT NOT NULL, printer_name TEXT, remote_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('library','send','queue','printer_storage','external','backfill')),
  link_method TEXT NOT NULL CHECK (link_method IN ('snapcon_variant','queue_sha256','content_fp','filename','none')),
  link_confidence TEXT NOT NULL CHECK (link_confidence IN ('exact','high','medium','low','none')),
  link_evidence_json TEXT, link_rule_version INTEGER,
  link_decision_id INTEGER REFERENCES decisions(id),
  user_id TEXT, user_label TEXT,
  started_at INTEGER, ended_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'printing'
    CHECK (outcome IN ('printing','completed','failed','cancelled','unknown')),
  elapsed_sec INTEGER, filament_g REAL, cost_est REAL,
  audit_ref INTEGER);                        -- audit_log row id (observed or backfilled events)
CREATE INDEX prints_key  ON prints(content_key, started_at);
CREATE INDEX prints_open ON prints(printer_id, remote_name, outcome);

CREATE TABLE review_items (                  -- shown as "Needs attention"
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                        -- §8
  subject_key TEXT NOT NULL UNIQUE,          -- stable: kind + uuids / content keys / locations
  claim_key TEXT,                            -- the raising Claim (stable key, not a row id)
  model_uuid TEXT, other_model_uuid TEXT,
  content_key TEXT, other_content_key TEXT,
  location TEXT, other_location TEXT,        -- 'root:rel_path' where a location matters
  print_id INTEGER REFERENCES prints(id) ON DELETE SET NULL,
  confidence TEXT, summary TEXT,
  evidence_json TEXT,                        -- Evidence snapshot when raised or last updated
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed','auto_closed')),
  resolution_decision_id INTEGER REFERENCES decisions(id),
  resolution_note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  resolved_by TEXT, resolved_at INTEGER);
CREATE INDEX review_open ON review_items(status, kind);

CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT);
CREATE TABLE model_tags (
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_by TEXT, added_at INTEGER, PRIMARY KEY (model_id, tag_id));
CREATE TABLE collections (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  cover_model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  owner_user_id TEXT,                        -- NULL = shared; private collections later
  created_by TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE collection_models (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  position INTEGER, added_by TEXT, PRIMARY KEY (collection_id, model_id));

CREATE TABLE permission_grants (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('role','group','user')),
  subject_id TEXT NOT NULL, capability TEXT NOT NULL, allow INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (subject_type, subject_id, capability));

-- ================================ DERIVED (rebuildable) ================================

CREATE TABLE scan_runs (
  id INTEGER PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  started_at INTEGER, finished_at INTEGER,
  seen INTEGER, added INTEGER, changed INTEGER, moved INTEGER, missing INTEGER, errors INTEGER,
  outcome TEXT);

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  entry_path TEXT NOT NULL DEFAULT '',       -- '' = real file; else an entry inside the container
  container_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL, ext TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('source','project','sliced','image','document','archive','other')),
  size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  quick_fp TEXT NOT NULL, sha256 TEXT, md5 TEXT,
  content_key TEXT NOT NULL,                 -- sha256 if known, else 'q:'||quick_fp
  meta_version INTEGER NOT NULL DEFAULT 0, meta_json TEXT,
  thumb_key TEXT,
  state TEXT NOT NULL DEFAULT 'present' CHECK (state IN ('present','missing','unreadable')),
  hidden INTEGER NOT NULL DEFAULT 0,         -- cache of a 'hidden' Decision
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, missing_since INTEGER,
  model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,     -- resolution cache (§4.1)
  model_claim_key TEXT, model_decision_id INTEGER REFERENCES decisions(id),
  UNIQUE (root_id, rel_path, entry_path));
CREATE INDEX files_ck  ON files(content_key);  CREATE INDEX files_fp    ON files(quick_fp);
CREATE INDEX files_md5 ON files(md5);          CREATE INDEX files_model ON files(model_id);
CREATE INDEX files_container ON files(container_id);   -- M0: without it, deleting files scans the table per row

CREATE TABLE content_aliases (alias TEXT PRIMARY KEY, content_key TEXT NOT NULL);   -- 'q:…' → sha256

CREATE TABLE file_objects (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name_norm TEXT NOT NULL, raw_name TEXT, copies INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL CHECK (origin IN
    ('exclude_object','printing_object','m486','slice_info','model_settings','source_file','mesh_basename')),
  generic INTEGER NOT NULL DEFAULT 0, excerpt TEXT,
  PRIMARY KEY (file_id, name_norm, origin));
CREATE INDEX file_objects_name ON file_objects(name_norm);

CREATE TABLE file_titles (                   -- title normalisation, kept for Explain/Diagnostics (§6.3)
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  original TEXT NOT NULL, normalized TEXT NOT NULL,
  transformations_json TEXT NOT NULL,        -- [{"rule":"copy_count","removed":"4x"}, …]
  token_count INTEGER NOT NULL, generic_score REAL NOT NULL DEFAULT 0,
  rule_version INTEGER NOT NULL);
CREATE INDEX file_titles_norm ON file_titles(normalized);

CREATE TABLE folder_classes (                -- folder classification, with provenance (§6.4)
  root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('format','printer_family_like','designer','unknown')),
  method TEXT NOT NULL, evidence_json TEXT NOT NULL, rule_version INTEGER NOT NULL,
  PRIMARY KEY (root_id, rel_path));

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  flavour TEXT NOT NULL CHECK (flavour IN ('bambu','orca','snapmaker_orca','creality','prusa','other')),
  producer TEXT, producer_version TEXT, title TEXT, designer TEXT, license TEXT, origin TEXT,
  design_model_id TEXT, design_profile_id TEXT, profile_title TEXT,
  printer_model TEXT, printer_model_id TEXT, printer_settings_id TEXT, print_settings_id TEXT,
  filament_settings_json TEXT, layer_height REAL, nozzle REAL,
  plate_count INTEGER, sliced_plate_count INTEGER, config_hash TEXT);
CREATE INDEX projects_design ON projects(design_model_id);

CREATE TABLE plates (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plate_no INTEGER NOT NULL, name TEXT, sliced INTEGER NOT NULL,
  objects_json TEXT, thumb_key TEXT, gcode_md5 TEXT,
  UNIQUE (project_id, plate_no));
CREATE INDEX plates_md5 ON plates(gcode_md5);

CREATE TABLE variants (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  plate_no INTEGER,                          -- NULL = plain G-code
  printer_family TEXT,                       -- resolution cache (§4.1)
  printer_claim_key TEXT, printer_decision_id INTEGER REFERENCES decisions(id),
  printer_model TEXT, printer_model_id TEXT, printer_settings_id TEXT, print_settings_id TEXT,
  compatible_printers TEXT, filament_settings_json TEXT, filaments_json TEXT,
  layer_height REAL, nozzle REAL, bed_json TEXT,
  slicer TEXT, slicer_version TEXT,
  config_block INTEGER NOT NULL DEFAULT 0, config_hash TEXT,
  est_seconds INTEGER, weight_g REAL, copies INTEGER, color_count INTEGER,
  UNIQUE (file_id, plate_no));
CREATE INDEX variants_family ON variants(printer_family);

CREATE TABLE claims (
  id INTEGER PRIMARY KEY,
  claim_key TEXT NOT NULL UNIQUE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('file','variant','model','print','location')),
  subject_key TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN
    ('member_of','same_model_as','source_of','sliced_from','targets_printer',
     'printed_as','duplicate_of','moved_from','converted_from')),
  object_type TEXT NOT NULL CHECK (object_type IN
    ('model','file','variant','project','printer_family','location')),
  object_key TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('exact','high','medium','low')),
  state TEXT NOT NULL CHECK (state IN ('applied','suggested','recorded','overridden','superseded')),
  automatic INTEGER NOT NULL DEFAULT 1,
  groups TEXT NOT NULL,                      -- e.g. 'internal-content,filename'
  evidence_json TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX claims_subject ON claims(subject_type, subject_key, relation);
CREATE INDEX claims_object  ON claims(object_type, object_key);
CREATE INDEX claims_state   ON claims(state, confidence);

CREATE TABLE model_stats (                   -- recomputed from prints + resolution
  model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  print_count INTEGER NOT NULL DEFAULT 0,
  print_count_confirmed INTEGER NOT NULL DEFAULT 0,    -- exact|high
  print_count_filename INTEGER NOT NULL DEFAULT 0,     -- medium, "matched by filename"
  last_printed_at INTEGER);

CREATE TABLE thumbs (
  key TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('embedded','original','client','render')),
  mime TEXT NOT NULL, bytes INTEGER NOT NULL, w INTEGER, h INTEGER,
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);

CREATE VIRTUAL TABLE model_fts USING fts5(name, designer, tags, collections, file_names,
  object_names, project_titles, notes, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
