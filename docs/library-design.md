# Model Library — implementation specification (v3.2, canonical)

**Status:** APPROVED. OK to Dev given 2026-09-30. M0 and M1 done (§21, §22); waiting for the owner's
approval before M2. The owner approves each milestone before the next begins.

**History:**
- v1–v3: 2026-09-28.
- v3.1: 2026-09-30. The canonical cleanup: one confidence policy (§4), one schema (§5), an
  audited authored/derived boundary (§4.6), the u1hub / 3MF Explorer ideas placed on the roadmap
  (§6.3, §6.4, §16), and a consistency audit (§19).
- v3.2: 2026-09-30. The M0 findings P1–P5 are accepted and folded into the sections they affect:
  - §5: the `files_container` index, the derived `model_families` table, and the
    `models_grid` index;
  - §6.2: an adaptive G-code read window;
  - §4.6 / §14: rebuild by drop-and-recreate, and keyset paging;
  - §15: an explicit worker entry in `pkg.scripts`, and packaged-build checks for other
    platforms.

  The measurements are in §21.

This document is the single implementation reference. Where any earlier draft or conversation
disagrees with it, this document wins.

Claims about SnapCon were checked against current source. Claims about the library were measured
on `\\192.168.2.18\SnapCon\Files` (58 G-code, 2 3MF, 5.8 GB).

### Canonical terminology

| Term | Meaning |
|---|---|
| **Model** | The thing a person thinks of ("Beardie"). Authored; owns tags, collections, notes, cover. |
| **File** | One real file on disk, or one entry inside a container (3MF picture). Has a *role*. |
| **Project** | A 3MF file's project-level data (sliced or not). One per 3MF. |
| **Plate** | One plate of a Project. |
| **Variant** | Anything printable: a plain G-code file, or one sliced Plate. |
| **Print** | One print attempt, linked to a File (and so a Variant and Model) by content key. |
| **Claim** | Something automation believes: `subject —relation→ object`, with Evidence, confidence, state. Derived. |
| **Decision** | Something a person decided. Same shape as a Claim. Authoritative. Authored. |
| **Evidence** | One observed fact supporting a Claim (§4.3). |
| **Review Item** | A question SnapCon asks the user. Shown in the UI under *Needs attention*. |

**Relations (the complete set):**
- `member_of`: File → Model.
- `same_model_as`: Model ↔ Model, merge suggestions. **Claims only**, intentionally retained,
  because a merge suggestion is naturally model-level. An accepted merge is written as
  `member_of` Decisions.
- `distinct_from`: Model ↔ Model, a rejected merge. **Decision only**.
- `source_of`: source mesh File → derived File (project or sliced).
- `sliced_from`: Variant → Project.
- `targets_printer`: Variant → printer family.
- `printed_as`: Print → File (+ plate).
- `duplicate_of`: location ↔ location.
- `moved_from`: File → previous location.
- `converted_from`: Project → Project (future).

Decisions may also carry the **attribute** `hidden` (File or Model).

---

## 1. Decisions recorded (owner)

| # | Decision |
|---|---|
| D1 | Regular and Admin users edit tags, collections, covers and grouping. View users are read-only. Permissions are refinable later without changing the data architecture (§11). |
| D2 | No physical deletion, rename or move of files in Phase 1. The only "destructive" action is **Hide from Library**. Admin-only deletion may come later (quarantine model, §16). |
| D3 | No new dependency unless necessary. Result: none needed (§10). |
| D4 | Automation follows the canonical confidence policy (§4.4). Decisions are `authoritative` and always win. Merge / split / move / approve / reject must be easy (§7). |
| D5 | A printable slice on an approved library location prints directly, with every existing compatibility, permission and safety check (§12). |
| D6 | Aggregate print counts are shown to everyone. Individual history is filtered to printers the user may see. |
| D7 | Import 90 days of past prints where reasonably confident. A filename match is never equal to a content or Variant match (§9). |
| D8 | The G-code folder uses **files** grouping. Its folders are organisational, never "one folder = one Model". |
| D9 | Phase 1 is split into 1a/1b. 3MF understanding (Bambu, Orca, Snapmaker Orca, Creality-family, where practical) is in 1a. Prusa 3MF is in 1b. No 3D viewer in Phase 1. |
| D10 | Filename-matched historical prints **count in the headline, visibly distinguished**: "17 prints · 13 confirmed · 4 matched by filename". Full provenance is kept internally. |
| D11 | Regular users may submit browser-generated covers under `library.edit.cover`. |
| D12 | The **full** Phase 1a milestone plan is selected (~40 working days). The Review Items UI in 1a is a basic list; the full page, large-photo shrinking and Prusa 3MF are in 1b. **1a still creates and stores every Review Item** with its Evidence. |
| D13 | 1a is usable end to end (§15): locations, cards, search/filter, Model page (Files, Projects, Plates, Variants, covers, printer family), basic history and counts, Print, Queue, merge / split / move / approve / reject, basic Needs attention, rescan, offline status. |
| D14 | Claims, Evidence and provenance are foundational (§4). Decisions survive moves, renames and full rebuilds wherever technically possible (§4.5, §4.6). |
| D15 | Send printer compatibility is a **separate prerequisite** (TODO §16). Its centralised printer-identity resolver is reused by the Library. **The Library contains no printer-detection logic of its own.** |
| D16 | **M4 Library Diagnostics is the hard checkpoint.** M5 does not start until the owner signs off the M4 review. Grouping-rule problems found there are fixed in M4. |
| D17 | u1hub / 3MF Explorer ideas are adopted **without expanding Phase 1a** (§18). **No geometry column is added in 1a.** Rejected u1hub behaviours are listed in §18. |
| D18 | Future "Convert for another printer / Prepare for U1" must not be blocked by the schema. It is not built now (§16.3). |
| D19 | M0 findings P1–P5 are accepted as measured implementation requirements (§21). `model_families` is a query and display optimisation only, never the source of printer identity. |

---

## 2. Research summary

**Meshory** (closed desktop app):
- File-first; ignores G-code by design. Grouping came late: archive "rollups" and folder covers.
- Tags follow a moved file only on a one-to-one fingerprint match.
- An offline source keeps its index.

**Manyfold** (open source):
- Library → Model → File with folder = model; common subfolders roll up into the parent.
- A Relationship table (`supported_version_of`, `alternative_format_of`).
- A Problems list with fix actions.
- No move detection.

**Converters** (studied only; bl2u1 and 3mf-to-u1 are GPL, OrcaSlicer is AGPL; no code copied):
- Conversion operates on the **Project** 3MF.
- "Printer-specific" means printer, process and filament profile ids, bed area/height/exclusions,
  nozzle, and machine G-code.
- Known tool flaws to avoid:
  - discarding the user's settings;
  - not re-centring objects;
  - leaving stale `plate_N.gcode`;
  - overwriting.

**OrcaSlicer format facts:**
- **Project 3MF:** object names, parts, plates and `source_file` (the original mesh basename) are
  in the small `model_settings.config`. Meshes are in `3D/Objects/*.model` and are never needed
  for metadata.
- **Sliced `.gcode.3mf`:** no `<object>` / `source_file`. Object names are in
  `slice_info.config`, and each plate has `plate_N.gcode.md5`.
- **Prusa 3MF:** INI config, inline meshes (can be huge), no plates.
- **G-code** never contains the project filename. Its config block is optional
  (`gcode_skip_config_block`).
- **Zip:**
  - sizes come from the central directory;
  - data descriptors are used;
  - zip64 is possible outside the GUI;
  - only STORE/DEFLATE;
  - the unicode-path extra field is used.

**u1hub and 3MF Explorer** (both MIT):
- **u1hub's Models tab** is a per-file 3MF browser:
  - one root and a JSON index;
  - "model" is a folder name;
  - path-keyed attributes;
  - disk rename and hard delete;
  - U1-only apart from Convert to U1.
- **3MF Explorer** is a separate localhost app:
  - SQLite, several roots;
  - content-hash-keyed tags and overrides;
  - byte and geometry duplicate detection;
  - quarantine instead of delete.
- Adopted ideas and rejected behaviours are listed in §18.

**Evidence from the real library:**
- Every G-code states its printer and profile: `printer_model`, `printer_settings_id`,
  `print_settings_id`, `filament_settings_id`, `layer_height`, `nozzle_diameter`, slicer and
  version.
- **Folders lie:** `K1C/HollowLog` is sliced for an Ender-3 V3 Plus.
- **`printer_model` can be generic:** `5M PRO/skelly` says "Generic Klipper Printer", while its
  settings id names the 5M Pro.
- MakerWorld 3MFs carry `DesignModelId` (Model identity) and `DesignProfileId` (Project
  identity).
- 3MF pictures are 12–270 KB WebP.
- `EXCLUDE_OBJECT_DEFINE` names carry the source STL filename, identical across slicers. Grouping
  on object names alone falsely merged 7 Models under `Assembly`.

---

## 3. Entity model

**Model → Files (role: `source` / `project` / `sliced` / `image` / `document` / `archive` /
`other`) → Project (one per 3MF) → Plates → Variants → Prints**, plus lineage Claims between
Files.

- A **Project** is a thin row, one per 3MF, sliced or not. A sliced 3MF gets a Project **and**
  one Variant per sliced Plate. An unsliced 3MF is a Project with no Variants.
- There is **no SourceAsset table**. A source is a File with `role='source'`. Being the source of
  something is a `source_of` Claim.

```
Model "Flexi Dragon"
 ├─ File Dragon.stl          role=source
 ├─ File Orca project.3mf    role=project → Project(orca, U1, 2 unsliced plates)
 │      Dragon.stl —source_of→ Orca project.3mf          [source_file_meta · high · applied]
 ├─ File U1-0.20-PLA.gcode   role=sliced  → Variant(U1 · 0.20 mm · PLA)
 │      Dragon.stl —source_of→ U1-0.20-PLA.gcode         [source_object_name · medium · suggested]
 │      Variant —sliced_from→ Orca project               [object_names · medium · suggested]
 ├─ File plate.gcode.3mf     role=sliced  → Project(sliced) + Plate 1 → Variant
 └─ Prints —printed_as→ File                             [snapcon_variant · exact | filename · medium]

Future: Project —converted_from→ Project                 [snapcon · exact, with a conversion manifest]
```

---

## 4. Claims, Evidence and provenance (canonical)

### 4.1 Claims and Decisions

```
resolve(subject, relation) =
    latest non-superseded DECISION (affirm or reject)   → authoritative
  else strongest Claim in state 'applied'  (§4.4)
  else unresolved (Claims remain 'suggested' / 'recorded')
```

- A **reject** Decision blocks every Claim with the same subject, relation and object, now and
  after any rescan. Its state becomes `overridden`.
- Resolved results are cached on derived rows (`files.model_id`, `variants.printer_family`), each
  with the `claim_key` or `decision_id` that produced it.

### 4.2 What every Claim records

| Field | Meaning |
|---|---|
| `method` | The rule that produced the Claim (e.g. `object_names+title`, `source_file_meta`) |
| `evidence` | The Evidence list (§4.3), each item carrying its source and independence group |
| `groups` | The independence groups present |
| `confidence` | `exact` / `high` / `medium` / `low` (Decisions are implicitly `authoritative`) |
| `state` | `applied` / `suggested` / `recorded` / `overridden` / `superseded` |
| `rule_version` | The version of the rule set that produced it |
| `claim_key` | `sha1(subject_type‖subject_key‖relation‖object_type‖object_key)`: the stable reference authored rows use instead of a row id |

### 4.3 Evidence

```json
{ "signal": "source_object_name",
  "value": "MMM_Beardie_Body_v08R.stl",
  "source": "gcode:EXCLUDE_OBJECT_DEFINE",
  "excerpt": "EXCLUDE_OBJECT_DEFINE NAME=MMM_Beardie_Body_v08R.stl_id_1_copy_0",
  "group": "internal-content",
  "strength": "strong",
  "matches": "content:q:3f9a…",
  "compare": null }
```

- **`group`** is the independence group: `identity`, `internal-content`, `filename`,
  `location`, `session` or `history`.
- **`strength`** is `identity` / `strong` / `medium` / `weak` / `none`. Generic object names and
  generic titles are recorded at `none` or `weak`.
- **Filename comparisons** carry `compare: { original_a, original_b, normalized_a, normalized_b,
  transformations_a[], transformations_b[], method, score, result }` (§6.3).
- **Caps:** excerpts ≤ 200 characters; ≤ 12 items per Claim.

### 4.4 Canonical confidence policy
1. A **Decision** is `authoritative` and always wins. Automation never overrides, removes or
   re-homes it.
2. **`exact`** identity Evidence (byte identity, or SnapCon's own record of an action) may
   auto-apply.
3. A genuinely strong **identity** signal may auto-apply **only where that relation's row below
   explicitly allows it**.
4. Otherwise auto-apply needs **corroboration from at least two different independence groups**,
   each at `medium` strength or stronger. `weak` Evidence explains but never corroborates. **Two
   signals from the same group never count as independent confirmation.**
5. A single `strong` or `medium` signal alone gives `medium` confidence: a **suggestion** and a
   Review Item. Nothing changes.
6. `low` or ambiguous Evidence is **recorded only**. It is visible in Explain and Diagnostics
   and never changes the library.
7. **Generic object names never count** as corroboration: `assembly`, `object`, `body`, `part`,
   bare numbers, and any name that appears in files with unrelated titles. Generic or common
   titles are down-weighted (§6.3).
8. Automation may **raise** confidence when stronger Evidence appears (a suggestion becomes
   applied, and its Review Item auto-closes with the reason). It may lower its **own** Claims.
   It never touches a Decision.

**Relation policy, including every exception:**

| Relation | Subject → Object keys | Auto-apply allowed on | Suggestion (`medium`) | Recorded (`low`) | Explicit exceptions |
|---|---|---|---|---|---|
| `member_of` | File content key → Model uuid | exact: plate md5 = file md5 (joins the Project's Model). identity: MakerWorld `design_model_id`, or `source_file` meta naming a File already in the Model. structural: folders-mode model folder. Otherwise 2 groups corroborating | One signal (equal non-generic object set only; title only) | Weak or generic only | Folders-mode membership is structural. Nested model folders are ambiguous. |
| `same_model_as` (Claims only) | Model uuid ↔ Model uuid | Never auto-merges an existing, decided Model. Undecided automatic Models merge under the `member_of` rules | Any single signal | Weak | An accepted merge writes `member_of` Decisions. A rejection writes `distinct_from`. |
| `source_of` | source File key → derived File key | identity: `source_file` meta equals exactly **one** mesh basename in the same Model or root (a project). exact name + second group (a sliced File) | Non-generic object name = mesh basename, alone | Generic names | `source_file` is slicer-written, so identity-grade when unique. 2+ candidates are ambiguous. |
| `sliced_from` | Variant (file key#plate) → Project file key | exact: plate md5. high: object names + same `design_profile_id`. future: slicer-watch, one candidate (§16.2) | Object names alone | — | |
| `targets_printer` | Variant → printer family key | identity: Bambu `printer_model_id`. high: non-generic `printer_model` consistent with settings id / compatible printers (resolver) | Generic `printer_model` + settings-id match ("likely"); internal fields disagree | No internal evidence | **Folder names are never Evidence for this relation** (§6.4). Resolver only (D15). |
| `printed_as` | Print id → File key (+ plate) | exact: `snapcon_variant`. exact: queue `sha256` = file `sha256`. high: `content_fp` | **A unique filename is `medium`, applied as *unconfirmed*** (counted, labelled "matched by filename") | Ambiguous filename → *Unlinked print* | Only exact/high are "confirmed". |
| `duplicate_of` | location ↔ location (`root:rel_path`) | exact: equal `sha256`. high: equal `quick_fp` | — | — | Keyed by **location**, because identical files share a content key. Applying **only records** the duplicate and raises *Possible duplicate*. It never hides, merges or deletes. |
| `moved_from` | File key → previous `root:rel_path` | exact: a unique 1:1 `quick_fp` within one scan | — | Ambiguous → missing + new | |
| `converted_from` (future) | Project key → Project key | exact: `snapcon`, with a conversion manifest (§16.3) | — | — | |

### 4.5 Decisions that survive rebuilds
Deleting every derived table and rescanning re-derives the Claims, then re-applies the Decisions.
Authored rows refer only to **stable keys**:

| Decision | Stored as | Key |
|---|---|---|
| Confirmed grouping | `member_of` affirm | file content key → Model uuid |
| Confirmed separation | `member_of` reject | file content key → Model uuid |
| Rejected merge | `distinct_from` affirm | Model uuid ↔ Model uuid |
| Printer chosen by hand | `targets_printer` affirm, `value_json.printer_family` | file content key (+ plate) |
| Confirmed / rejected lineage | `source_of` / `sliced_from` affirm or reject | both content keys (+ plates) |
| Print link confirmed / changed | `printed_as` affirm | print id → content key |
| Hidden File | attribute `hidden` | file content key |
| Hidden Model, name, notes, cover | columns on `models` (`hidden`, `name` with `name_source='user'`, `notes`, `cover_content_key` with `cover_source='user'`) | Model uuid (the row itself) |
| Review Item resolution / dismissal | `review_items.status` + `resolution_decision_id` | `subject_key` built from uuids and content keys |

- The **content key** is `sha256` when known, else `q:` + `quick_fp`.
- When the full hash arrives later, authored rows keyed on the quick key are **re-keyed in
  place**. `content_aliases` resolves either form meanwhile.

**Honest limitation:**
- A file that is **both moved and modified while unavailable** has a new location and new
  content, so nothing stable links it to its Decisions.
- SnapCon **does not guess**. The Decision is kept, and after a completed scan of that root a
  *Decision no longer matches* Review Item is raised, with Re-link / Discard.

### 4.6 Authored / derived boundary (audited)

| Authored — survives any rebuild | Derived — dropped and rebuilt freely |
|---|---|
| `roots` (configuration columns) | `roots` runtime status columns, `scan_runs` |
| `models`, `model_anchors` | `files`, `content_aliases`, `file_objects`, `file_titles`, `folder_classes` |
| `decisions` | `projects`, `plates`, `variants` |
| `review_items` | `claims` |
| `tags`, `model_tags`, `collections`, `collection_models` | `model_stats`, `model_families` |
| `prints` | `thumbs`, `model_fts` |
| `permission_grants` | |

**Rules:**
1. **Authored → derived:** never by row id, and **no foreign keys**. Only content keys, plate
   numbers, locations, `claim_key`, Model uuids and print ids.
2. **Authored → authored:** integer ids are allowed (same lifetime). Export/import re-maps them
   through uuids.
3. **Derived → authored:** ids are allowed (`files.model_id`, `files.model_decision_id`,
   `variants.printer_decision_id`, `model_stats.model_id`). Derived rows are rebuilt after
   authored ones.
4. **Automatic Models are authored rows**, so tags and notes on them survive. `model_anchors`
   keeps each Model's last-known member content keys. After a rebuild:
   - an automatic cluster is matched to the existing Model with the **largest unique overlap**
     (at least half of the cluster);
   - no match creates a new Model;
   - a conflict raises *Ambiguous grouping*;
   - a Model left with no present Files raises *Empty model*.

   **Nothing authored is deleted automatically.**
5. **Counters** live in derived `model_stats`, recomputed from `prints` + resolution.
   **`model_families`** (P3) caches which printer families each Model has Variants for, for the
   grid's printer filter and facets.
   - It is a query and display optimisation only, **never** the source of printer identity. That
     stays with the shared resolver (D15) and `targets_printer` Claims and Decisions.
   - It is recomputed from `variants.printer_family`, itself a resolution cache (§4.1).
   - Dropping it loses nothing.
6. **Removing a root** (admin) cascades only its derived rows. Its Decisions, Prints and Models
   are kept. The files show as missing and the Decisions remain for Re-link.
7. **Rebuilding the derived index** (P4) drops and recreates every derived table inside one
   transaction, instead of deleting rows.
   - M0 measured a `DELETE` cascade at 12 s for 100k files, and quadratic without the
     `files_container` index.
   - Foreign-key enforcement is switched off for the drop only. That is safe because no
     authored table references a derived one (rule 1).
   - The authored tables and the runtime status columns of `roots` are not touched.
   - A test proves every authored row survives.

---

## 5. SQLite schema (canonical; `library-data/library.db`, WAL, `PRAGMA foreign_keys=ON`)

```sql
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
CREATE INDEX models_grid   ON models(hidden, updated_at, id);   -- P3: keyset paging of the grid

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
-- P1 (M0): required, not optional. Without it, deleting files scans the whole table once per row
-- (the self-referencing container_id foreign key), and a 10k-file rebuild never finished.
CREATE INDEX files_container ON files(container_id);

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

-- P3 (M0): the grid's printer filter and facet counts read this, not variants. M0 measured
-- 363 ms for facet counts over variants at 100k files. A query cache only: recomputed from
-- variants.printer_family, never the source of printer identity (§4.6 rule 5).
CREATE TABLE model_families (
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  printer_family TEXT NOT NULL,
  variant_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model_id, printer_family));
CREATE INDEX model_families_family ON model_families(printer_family, model_id);

CREATE TABLE thumbs (
  key TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('embedded','original','client','render')),
  mime TEXT NOT NULL, bytes INTEGER NOT NULL, w INTEGER, h INTEGER,
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);

CREATE VIRTUAL TABLE model_fts USING fts5(name, designer, tags, collections, file_names,
  object_names, project_titles, notes, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
```

**Size (measured in M0):** 39.7 MB at 10k files, 198 MB at 50k, 398 MB at 100k. Claims are 36% of
that and Evidence 18% (§21).

---

## 6. Indexing and extraction

### 6.1 Pipeline
One worker thread, one root at a time:
1. reachability check;
2. enumerate and stat;
3. `quick_fp` for new or changed files (full hash later, at idle);
4. `moved_from` Claims;
5. extraction;
6. title normalisation (`file_titles`) and folder classification (`folder_classes`);
7. Claim evaluation for changed subjects;
8. resolution and anchor matching;
9. Review Items;
10. `model_stats`, `model_families` and FTS.

Rules that apply throughout:
- **Offline** changes no rows. A **missing** file gets a 30-day grace period, and Decisions
  survive a purge.
- **Throttling:** a bandwidth budget, concurrency 1, and **a pause while SnapCon uploads to a
  printer**.
- Unchanged files cost one stat.

### 6.2 Extraction
- **G-code**, read through an **adaptive window** (P2):
  - **Initial window: the first 512 KB and the last 256 KB.**
  - **Why:** in M0, across all 58 real G-code files, the furthest thumbnail and
    `EXCLUDE_OBJECT_DEFINE` data ended 135 KB into the file, and the config block started at most
    32 KB from its end. Over the NAS this window cost 15–74 ms per file, against 228–274 ms for
    the former 3 MB + 3 MB.
  - **Adaptive:**
    - If the head window ends inside the thumbnail or object-definition section, or ends before
      the print body starts (no `; EXECUTABLE_BLOCK_START` / first move seen), the head is grown
      (×4 each time) up to 3 MB.
    - If the tail window holds no config block (no `; CONFIG_BLOCK_START` and no
      `; printer_model =`), the tail is grown the same way up to 3 MB.
    - Past 3 MB, extraction falls back to the parser's existing streamed parse, as `/api/map`
      does today.
    - The window actually used is recorded in `meta_json`, so Diagnostics can show files that
      needed more than the initial window.

  Nothing assumes that future G-code matches the 58-file sample. Fields read from the window:
  - thumbnails and `generated by`;
  - object names from `EXCLUDE_OBJECT_DEFINE` / `; printing object` / `M486`, with copy counts
    and excerpts;
  - config-block profile identity (a missing block gives nulls and `config_block=0`);
  - palette, time and weight from `parser.js`.
- **3MF (1a)** — Bambu / Orca / Snapmaker Orca / Creality-family where practical; Prusa in 1b:
  - Central-directory **range reads** (as in u1hub): STORE/DEFLATE, zip64, unicode names, entry
    caps.
  - `3dmodel.model` metadata only when small; otherwise a head-only read.
  - `model_settings.config` (objects, `source_file`, plates), `project_settings.config`
    (profile), `slice_info.config` (sliced plates, printer id, prediction, weight, filaments,
    object names).
  - `plate_N.gcode.md5` and thumbnails (the small plate PNG first, then plate, then
    `thumbnail_3mf`).
  - `Auxiliaries/*` pictures and documents become entry Files (`container_id`, `entry_path`).
  - Anything unrecognised is `flavour='other'`. **Unreadable is a Review Item, never a crash.**
- **`threemf.js`:** `read()` stays byte-identical for the Bambu connector; new functions sit
  beside it.
- **Printer family:** only from internal Evidence through the centralised resolver (D15), under
  the `targets_printer` policy (§4.4).

### 6.3 Filename and title normalisation (M4, M7)
**Two separate uses, never mixed:**
1. **Candidate discovery.** Aggressive normalisation is allowed. Its only job is to find pairs
   worth comparing.
2. **Evidence.** A comparison becomes an Evidence item (group `filename`) whose strength is set
   by the conservative rules below. **Normalisation never manufactures strong Evidence.**
   Stripping terms does not make two Files the same Model.

**Stored:**
- per File (`file_titles`): original, normalised value, each transformation (the rule and what it
  removed), token count, generic score, rule version;
- per comparison (`compare` in the Evidence): both originals, both normalised values, both
  transformation lists, the method, the score and the result.

**Transformations** (candidate discovery):
- copy counts (`4x`, `x24`, `24x`);
- `plate N`;
- Orca material/time tails (`_PLA_3h55m`) and trailing time, weight, colour or temperature
  parentheticals;
- filament words;
- known designer and collection names;
- known format-folder tokens.

**Evidence strength:**

| Comparison | Strength |
|---|---|
| Exact normalised title, ≥ 2 meaningful tokens, not generic | `medium` |
| Whole-word containment | `weak` |
| Other similarity | `weak` or none |
| One-word titles | Exact only; otherwise `none` |
| Names under 4 characters | Never fuzzy-matched |
| Generic or common titles (`stand`, `holder`, `test`, `benchy`, `calibration`, …) | At most `weak`, by `generic_score` |

- **Ties never share credit.** Ambiguity becomes a Review Item.
- **Prints:** a unique filename match is `medium`, visibly "matched by filename". An ambiguous one
  is `low` → *Unlinked print*. Reports state **"matched N of M"**.
- **Copies** come from G-code object metadata (`_copy_M` counts). A filename count is weak
  corroboration only.

### 6.4 Folder classification (M2, M4)
- Each folder level is classified as `format` / `printer_family_like` / `designer` / `unknown`,
  with method, Evidence and rule version (`folder_classes`).
- **How:**
  - a format-token pattern;
  - a match against printer-family names **supplied by the resolver** (no separate list);
  - "subfolders appear as designers elsewhere".
- **Uses:** navigation, candidate discovery, Diagnostics, and weak `location` Evidence for
  grouping (a designer folder).
- **Never:** **a folder is never Evidence for `targets_printer`.** A printer-looking folder may
  only:
  - help navigation;
  - help candidate discovery;
  - raise *Folder disagrees with file*;
  - appear in Diagnostics.

---

## 7. Grouping and manual control

- **Root modes:** `folders` (a downloaded pack; the model folder is structural; common subfolders
  roll up into the parent; nested model folders are ambiguous) and `files` (the G-code folder,
  D8).
- Automatic grouping follows §4.4 exactly. Diagnostics shows, for every non-applied Claim, **the
  requirement that was missing**, e.g. "only one independence group" or "generic object name".
- **Checked against the real library:**
  - Beardie (object names + title) groups across AD5X/I7.
  - The `Assembly` files form an ambiguous cluster, not a merge.
  - Butterfly Dragon 3 vs 4 colours and Lupa vs "Lupa, 3 Colors" become suggestions.

**Manual tools (M6).** Each writes a Decision. Undo supersedes it, and the history is kept.

| Action | Where | Decision |
|---|---|---|
| Merge Models | Select cards → "Merge 3 models" (pick surviving name/cover); Model ⋯ → Merge with… | `member_of` affirm for every File of the absorbed Models → surviving uuid |
| Split | Model → Files → select → "Split 2 files into a new model" | new Model (`origin='user'`); `member_of` affirm → new; `member_of` reject → old |
| Move File/Variant | Row ⋯ → "Move to model…" | `member_of` affirm → target; `member_of` reject → source |
| Approve suggestion | Review Item / Diagnostics (M6) | `member_of` affirm (per File), from the Claim |
| Reject suggestion | Review Item / Diagnostics (M6) | `distinct_from` (Models) or `member_of` reject (File) |
| Set printer | Variant ⋯ | `targets_printer` affirm, `value_json.printer_family` |
| Confirm / reject lineage | Model page or Review Item | `source_of` / `sliced_from` affirm or reject |
| Hide File / unhide | File ⋯ | `hidden` / supersede |
| Hide Model, rename, notes, cover | Model page | `models` columns (`hidden`, `name` + `name_source='user'`, `notes`, `cover_*` + `cover_source='user'`) |

A Model with any grouping Decision is pinned: automation may add newly matching Files, but never
remove or re-home a decided one.

---

## 8. Review Items ("Needs attention")

1a **creates and stores every kind**, with an Evidence snapshot:
- M4 shows them in Diagnostics.
- M5 adds a basic Library list with Explain and the primary actions, plus a header count.
- 1b adds the full page.

| Kind | Raised when | Actions → what is written |
|---|---|---|
| `suggested_match` | `member_of` / `same_model_as` at `medium` | Merge → `member_of` affirm · Not the same → `distinct_from` / `member_of` reject |
| `ambiguous_grouping` | A File matches 2+ Models equally; a generic-name cluster; nested model folders; an anchor conflict | Choose → `member_of` affirm · Keep separate → `distinct_from` |
| `possible_duplicate` | `duplicate_of` applied | Keep all → dismiss · Hide copy → `hidden` · Show locations → none |
| `source_may_match` | `source_of` at `medium` | Link → `source_of` affirm · Not related → `source_of` reject |
| `unknown_printer` | `targets_printer` below `high` | Set printer → `targets_printer` affirm · Dismiss |
| `folder_disagrees` | A printer-like folder contradicts the File's resolved printer | Dismiss (informational) |
| `missing_file` | Root reachable, file gone | Rescan → none · Remove now → purge the derived row (Decisions kept) · Dismiss |
| `source_offline` | Root unreachable | Recheck (admin) → none |
| `no_cover` | No image or embedded thumbnail | Choose cover → `models.cover_*` · Dismiss |
| `file_changed` | Content changed **and** the File has Prints, Decisions or queued jobs | Accept new version → Decisions re-keyed to the new content key · Details |
| `unreadable_file` | Corrupt or over-limit container, parse error | Rescan · Dismiss |
| `unlinked_print` | Ambiguous or unknown filename | Link → `printed_as` affirm · Dismiss |
| `decision_unmatched` | A Decision's key is not found after a completed scan | Re-link → Decision re-keyed · Discard → Decision superseded |
| `empty_model` | A Model with no present Files | Hide → `models.hidden` · Merge into… → `member_of` affirm · Keep → dismiss |

Items are keyed by `subject_key`, so resolutions and dismissals persist through rescans and
rebuilds. They auto-close, with the reason, when the condition clears.

---

## 9. Print history
- **Links** (`printed_as`, stored on `prints`):
  - `snapcon_variant` = `exact`;
  - queue `sha256` = file `sha256` → `exact`;
  - `content_fp` = `high`;
  - a unique `filename` = `medium`, applied as unconfirmed;
  - ambiguous = `low` → `unlinked_print`.
- **Outcome hooks** sit next to the existing `notifyTick` audit calls.
- **Backfill (D7):** 90 days of audit `print-*` events.
  - At most `filename` / `medium`.
  - Upgraded to `queue_sha256` where a queue item recorded the hash.
  - Evidence: `audit_ref` + the comparison. The report states "matched N of M".
- **Display (D10):** "17 prints · 13 confirmed · 4 matched by filename"; filename rows are marked.
  Counts come from `model_stats`.
- **Visibility (D6):** counts are global; rows are filtered by `printerVisibleTo`.

---

## 10. Covers and thumbnails (no dependency)
- **Embedded PNGs** (G-code, 3MF plates, `thumbnail_3mf`) are copied byte-for-byte.
- **Images ≤ 300 KB** are served as-is.
- **Large images:**
  - 1a: the embedded thumbnail or a placeholder.
  - 1b: the browser downscales via `OffscreenCanvas` (JPEG ~480 px) and POSTs it under
    `library.edit.cover` (D11), validated for magic bytes, ≤ 200 KB and ≤ 512 px.
- **Cover order:**
  1. user choice (`cover_source='user'`);
  2. an image in the Model;
  3. 3MF plate / `thumbnail_3mf`;
  4. the largest G-code thumbnail;
  5. a render (Phase 2);
  6. a placeholder and `no_cover`.
- **Cache:** content-keyed (`thumbs`), long cache + ETag, evicted least-recently-used above a cap
  (default 1 GB).

---

## 11. Permissions

Code checks capabilities (`libraryCan(user, cap)`). `permission_grants` is seeded with role rows
only.

| Capability | view | regular | admin |
|---|---|---|---|
| `library.view`, `library.download` | ✓ | ✓ | ✓ |
| `library.edit.metadata` · `library.edit.collections` · `library.edit.cover` · `library.edit.grouping` · `library.review` · `library.hide` | | ✓ | ✓ |
| `library.sources.manage` · `library.backup` · `library.diagnostics` · `library.files.delete` (future) | | | ✓ |

- Printing stays on the existing `requireRegular` + `printerVisibleTo` + maintenance +
  busy/active-file/dedup/brand checks.
- Library edits are written to the audit log (category `library`).
- With users off, everything is implicitly admin.

---

## 12. Printing from any approved location
- File references are `(rootId, relPath)`. They resolve only through `resolveWithinFolder` +
  realpath containment, for enabled, reachable roots.
- `/api/print`, `/api/map`, `/api/local-thumbnail` and queue items gain an **optional** `root`.
  When it is absent the root is `gcode`, so existing callers and stored items are unchanged.
  Queue items store `file.root`, and dispatch re-verifies from it.
- **Safety paths are unchanged:** `uploadDisposition`, `assertNotActiveJobFile`, `decideUpload`,
  brand and Bambu checks (via the resolver, D15), maintenance mode, group visibility. The same
  Send and Queue modals are used, plus a source line.
- An offline root disables Print/Queue with an explanatory `title`.

---

## 13. UI

### 13.1 Library Diagnostics (M4 hard checkpoint; `library.diagnostics`; `/library/diagnostics`)
Plain and functional. It validates grouping on the real library before M5, and may be kept as
Admin → Library Diagnostics.

- **Summary:** Files, Models, auto-grouped, suggestions, ambiguous, unknown printer, unreadable;
  rule version; last scan.
- **Models tab:** Model → Files → Projects → Plates → Variants. Each link shows:
  - relation, method, confidence and state;
  - every Evidence item (value, excerpt, source, group);
  - **filename transformations** (original → normalised, with the rules applied);
  - **printer identity and why** (`targets_printer` Evidence);
  - for non-applied Claims, **the missing requirement**.
- **Suggestions tab:** both sides, the Evidence, and what's missing for auto-apply.
- **Ambiguous tab:** generic-name clusters (`Assembly` **listed, not merged**), multi-Model
  matches, nested folders, anchor conflicts.
- **Folders tab:** the classification of each level, with method and Evidence.
- **Other Review Items tab:** everything else in §8, and "matched N of M" for prints.
- **Filters and export:** by root, confidence, method, state, kind and path text. **JSON
  export** so grouping runs can be compared.
- **Read-only at M4.** Approve/reject is added in M6.

```
Beardie                                    5 files · 0 projects · 5 variants
  AD5X/MatMireMakes/Beardie (5h41m).gcode    member_of · high · applied · object_names+title
     ✓ object names  MMM_Beardie_Body_v08R.stl + MMM_Beardie_Head_preSupported_v08R.stl  [internal-content]
     ✓ title         "Beardie (5h41m)" → "beardie"  (removed: time "(5h41m)")  = "beardie"  [filename]
     · designer dir  MatMireMakes  [location, weak]
     targets_printer → flashforge-ad5x · high · printer_model "Flashforge AD5X" agrees with settings id
Ambiguous — generic object name "Assembly" (NOT merged)
  U1/Cinderwin 3D/Alicorn Dragon (19h24m).gcode
  U1/Cinderwin 3D/Cherry Blossom (1d1h).gcode   …
```

### 13.2 Library (M5 onwards)
Full-page view at `/library`, `/library/m/<uuid>` and `/library/attention`, in the existing theme
and components. The File Browser is unchanged.

- **Grid:**
  - search;
  - filters: Printer, Material, Type, Tag (1b), Collection (1b), Printed, Source, Show hidden;
  - cards: cover, name, "N variants" or "N files", "17 prints · 13 confirmed", and a fleet-fit
    strip;
  - multi-select: "Merge 2 models", "Hide 2 models";
  - a Needs-attention link, an offline bar with Recheck, and an indexing pill.
- **Model page:**
  - gallery;
  - facts: designer, licence, "Fits", prints;
  - Variants: printer ("likely" / "unknown" where applicable), profile, colours, time
    (`fmtDuration`), weight, copies, source, last printed, **Print / Queue**;
  - Projects and Plates;
  - Files by role, with ⋯ Move / Split / Hide / **Why is this here?** (Explain);
  - history (filtered, filename matches marked).
- **Conventions:**
  - scoped button labels;
  - confirmations that name what is affected;
  - disabled actions carry a `title`;
  - checkboxes use `.checkbox-input`;
  - the filename convention.

---

## 14. Offline, backup, search
- **Offline:** no rows change, the missing timer does not run, a named bar with Recheck appears,
  and Print/Download are disabled with a `title`.
- **Backup:**
  - Nightly `VACUUM INTO` (keep 7), plus a snapshot before each migration (1a).
  - JSON export/import of **authored** tables keyed by uuid and content key (1b).
  - A corrupt DB is quarantined and the newest backup restored, never recreated silently.
  - A missing DB is a first run.
- **Rebuild:** "Rebuild index" drops and recreates the derived tables in one transaction (§4.6
  rule 7, P4), then rescans. It never touches authored tables.
- **Search:** FTS5 over names, designers, tags, collections, file and object names, project
  titles and notes. SQL filters with facets and server-side paging. "Fits my idle printers" is
  applied client-side.
  - **Paging is keyset**: `WHERE (updated_at, id) < (?, ?) ORDER BY updated_at DESC, id DESC` on
    `models_grid`, never `OFFSET`. M0 measured 92 ms at a deep offset at 100k files.
  - **The printer filter and printer facets read `model_families`** as a set (`m.id IN (…)`),
    never a correlated `EXISTS` over `variants`. M0 measured that form at 15.7 s at 10k files
    (P3).

---

## 15. Phase 1a — milestones (final)

**Prerequisites (before M2):**
- Commit 0.7.3.
- **TODO §16**: the centralised printer-identity resolver and a model-level Send check
  (2–3 days).

| M | Delivers | Owner test / checkpoint | Days | Main risks | Depends on |
|---|---|---|---|---|---|
| **M0 Spike** | `worker_threads` + `node:sqlite` in a pkg build; synthetic 100k DB with Claims; SMB enumeration rate; zip64 3MF through the range-read reader | Numbers report | 2 | pkg worker → fallback decided here | — |
| **M1 Foundation** | `library/` subsystem, canonical schema, migrations, nightly backup, derived-index rebuild (drop/recreate), capabilities, roots CRUD (overlap/realpath checks), runtime location status, Settings → Library, Docker/compose, and the worker foundation with its entry **listed in `pkg.scripts`** (P5) | Add locations; see offline; Rescan | 4 | Docker test | M0 |
| **M2 Indexer + G-code** | Worker indexer (fingerprints, `moved_from`, missing/offline, throttle + pause during uploads), G-code extraction (profile identity, object Evidence), `targets_printer` Claims via the resolver, **folder classification**, thumbnails | **Checkpoint 1: read-only indexing of the real library** | 5 | SMB load vs uploads; parse speed | M1, §16 |
| **M3 3MF** | Range-read zip reader; Bambu/Orca/Snapmaker Orca/Creality-family extraction; Projects, Plates, Variants, entry Files, `source_of` / `sliced_from` Claims | **Checkpoint 2: 3MF extraction on real files** | 4 | Flavour variety; Bambu connector regression | M2 |
| **M4 Claims, grouping, Diagnostics** | Canonical policy engine, **title normalisation with stored transformations**, Decisions + resolution + anchor matching, Review Item creation, **rebuild-survival test**, Diagnostics + JSON export | **Checkpoint 3 (HARD): owner reviews grouping, Evidence, transformations, printer identity, suggestions and ambiguous clusters. M5 is blocked until sign-off.** | 6 | False merges; tuning time | M2, M3 |
| **M5 Library UI** | Grid, search/filters, Model page, offline bar, basic Needs-attention list, Explain popover | **Checkpoint 4: the real Library experience** | 6 | UI size | **M4 sign-off** |
| **M6 Grouping tools** | Merge, split, move, hide, approve/reject, set printer, lineage confirm/reject, cover, rename, undo; approve/reject in Diagnostics | Fixes survive rescan and rebuild | 4 | Decision edge cases | M5 |
| **M7 Print, queue, history** | Root-aware routes and queue, safety regression tests, `printed_as` links, outcome hooks, 90-day backfill ("matched N of M"), counts, history | **Checkpoint 5: controlled printer tests, idle printers only** | 6 | Safety paths; backfill ambiguity | M5 |
| **M8 Hardening** | Full real-library pass, performance, Spanish strings, release notes, full suite; **packaged worker + `node:sqlite` verified on macOS (x64, arm64) and Linux x64** (P5; Windows proven in M0) | Everything on real data | 3 | Real-data surprises | M6, M7 |

**Total: ~40 working days (≈ 8 weeks)**, plus 2–3 days for §16. The u1hub ideas add no milestone
time (§18).

**Phase 1b (~2.5 weeks):**
- the full Needs-attention page;
- browser photo downscaling;
- Prusa 3MF;
- tags, collections, notes;
- JSON export/import;
- the full Explain view.

**Phase 2 (~3 weeks):**
- mesh thumbnails;
- 3D viewer;
- ZIP containers;
- presupported pairing;
- Open in slicer + slicer-watch (§16.2);
- geometry Evidence (§16.1);
- admin deletion (quarantine model);
- Moonraker reconciliation.

**Phase 3:** conversion (§16.3).

---

## 16. Future work (adopted in principle; nothing implemented in Phase 1a)

### 16.1 Geometry Evidence — Phase 2
- **Concept** (from 3MF Explorer): a mesh identity independent of vertex order, to recognise the
  same geometry across renames, re-exports and reslices.
- **Not in the 1a schema.** The algorithm is not final, and a migration is expected when it is
  designed.
- **Policy:** geometry identity is a **strong single signal**, a *suggestion*. It does not by
  itself prove the same Model, because of:
  - generic primitives;
  - calibration objects;
  - reused components;
  - licensed copies;
  - mirrored or derived models;
  - common geometry in different products.

  Geometry plus independent Evidence may reach `high`.
- **For the Phase 2 design to consider:** exact/near-exact vs transformed vs mirrored vs
  component/contained geometry. Not designed now.

### 16.2 Slicer-watch lineage — Phase 2
- **Flow:** SnapCon opens Project X in a slicer → watches the expected output location(s) → a
  newly generated G-code may produce a `sliced_from` Claim.
- **Confidence:** `high` (not `exact`) with strong session context and **exactly one** valid
  candidate. Multiple plausible candidates → a Review Item. **Never "the first changed file".**
- **Evidence:**
  - launch/session id;
  - source Project content key;
  - slicer and version;
  - launch time and watch window;
  - watched location(s);
  - candidates observed and their count;
  - the filename comparison (§6.3);
  - the selected candidate;
  - rule version (group `session`).
- **Research note:** can Orca / Snapmaker Orca supply a *deterministic* source-project identity
  (post-processing environment, the existing `--load` hook, or another mechanism)? If so, the
  relation could become `exact`. Unverified.

### 16.3 Conversion — Phase 3 design note
- **Never blindly copy machine-dependent settings between printers.**
- **Potentially portable when validated:**
  - walls/perimeters;
  - infill;
  - supports;
  - brim;
  - seam;
  - ironing;
  - prime tower where compatible;
  - other safe geometry or process-intent settings.
- **Destination/profile-controlled unless explicitly mapped:**
  - speed and acceleration;
  - temperature and flow;
  - pressure advance;
  - retraction;
  - cooling;
  - machine start/end G-code;
  - post-processing;
  - bed geometry;
  - purge/tool-change behaviour;
  - firmware-specific commands.
- **Never guess** material or profile mappings. **Never overwrite** the original Project.
  Re-centre and revalidate geometry against the destination bed where necessary.
- **Output:** a **new** File + Project and an `exact` `converted_from` Claim.
- **Conversion manifest** (reserved concept; the Evidence for `converted_from`, making
  conversions explainable and reproducible):
  - source Project content key/hash;
  - destination printer/profile and profile version;
  - converter/rule version;
  - settings preserved, replaced, and intentionally dropped;
  - material mappings;
  - geometry transformations / re-centring;
  - warnings;
  - output content key/hash.

  **Storage is decided in Phase 3.** The manifest can live in the Claim's Evidence, or in a
  sidecar table added by a migration then.

---

## 17. Technical risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Wrong grouping (proven) | Canonical policy, independence groups, generic-name/title handling, suggestions, sticky Decisions, **M4 hard checkpoint** |
| R2 | Indexer vs uploads on one SMB share | Bandwidth budget, concurrency 1, pause during transfers |
| R3 | `worker_threads` under pkg | M0; in-process fallback |
| R4 | Root-aware paths touch send/queue safety | Optional parameter defaulting to today's behaviour; regression tests per guard |
| R5 | Filename-only history | `printed_as` provenance, "matched by filename", "matched N of M", ambiguity → Review Item |
| R6 | 3MF variety and size | Central-directory range reads, head-only XML, caps, `unreadable_file`, fixtures per flavour |
| R7 | `threemf.js` changes break the Bambu connector | `read()` unchanged; connector tests stay green |
| R8 | Symlink escape on NAS roots | Realpath containment; overlapping roots refused |
| R9 | History leaking other groups' printers | `printerVisibleTo`; counts aggregate only |
| R10 | Evidence bloat | Caps; measured in M0 |
| R11 | Moved-and-modified-offline files lose their Decisions | Documented limit; `decision_unmatched`; never guessed |
| R12 | Brand-level Send compatibility | Separate prerequisite §16; one shared resolver (D15) |
| R13 | GPL/AGPL code | Studied only; u1hub/3MF Explorer are MIT, and ideas are reimplemented with a credit |
| R14 | Anchor re-matching after a rebuild attaches a cluster to the wrong automatic Model | Largest unique overlap ≥ half; conflicts → `ambiguous_grouping`; covered by the rebuild-survival test |

---

## 18. Sources, adopted ideas and rejected behaviours

**Sources:**
- Meshory
- Manyfold
- OrcaSlicer (format facts)
- bl2u1, 3mf-to-u1, Panda2Prusa, parse3MF, gcode-to-bambu-preset (studied)
- u1hub and 3MF Explorer (MIT)

**Adopted (u1hub / 3MF Explorer) and where each lives:**

| Idea | Where |
|---|---|
| Filename normalisation, made conservative (candidate discovery ≠ Evidence) | §6.3 — M4 (grouping), M7 (print history) |
| Folder classification with provenance; never printer Evidence | §6.4 — M2 (classify), M4 (use) |
| Range-read zip parsing; small-plate-first thumbnails | §6.2 — M3 |
| Geometry Evidence | §16.1 — Phase 2 |
| Slicer-watch lineage | §16.2 — Phase 2 |
| Conservative conversion rules + conversion manifest | §16.3 — Phase 3 note |

**Rejected (not adopted):**
- destructive Rename / Move / Delete as normal Library behaviour;
- attributes keyed only by file path;
- sharing credit between ambiguous filename matches;
- first-file-changed slicer matching;
- a single shared password as the security model.

---

## 19. Consistency audit (performed 2026-09-30)

1. **Schema fields referenced exist.** Every field named in §4–§15 exists in §5.
   - `files.hidden`, `models.hidden`, `models.cover_*`, `variants.printer_family`,
     `file_titles.*`, `folder_classes.*` and `model_stats.*` are all checked.
   - `origin`, `name_source` and `cover_source` values are constrained to the ones the text uses.
2. **Relations.** UI, grouping and Review Items use only the set in "Canonical terminology".
   - `claims.relation` and `decisions.relation` are CHECK-constrained to it.
   - `same_model_as` is Claims-only and `distinct_from` Decisions-only, both deliberately.
3. **Review actions.** Every action in §8 maps to a Decision relation/polarity, a `models` column,
   a dismissal, or "no write".
4. **Milestones** M0–M8 use the final terms (Claims, Decisions, Review Items, `source_of`,
   `printed_as`, `folder_classes`, `file_titles`).
5. **Derived vs authored** (§4.6) matches the rebuild behaviour.
   - `roots` is authored (config) with runtime status columns.
   - Counters moved to derived `model_stats`.
6. **Rebuild cannot destroy authored data.**
   - No authored table has a foreign key into a derived table.
   - Authored → derived references are text keys only (`content_key`, `claim_key`, location,
     `subject_key`).
7. **Foreign keys match the promise.**
   - Derived tables cascade only among themselves, or from `roots` (removing a root drops only
     derived rows).
   - Authored rows reference authored rows only.
8. **One `CREATE TABLE` per table** (24 tables + 1 FTS table, including `model_families` from P3). The §5 block was executed as-is
   in `node:sqlite` with `foreign_keys=ON` (see §19.11).
9. **No duplicate columns.**
10. **No obsolete v2 structures.**
    - Removed:
      - `file_pins`, `merge_suggestions`, `grouping_locked`;
      - `*_method` / `*_confidence` pairs (other than `prints.link_*`);
      - `sliced_from_source`, `not_member_of`, `lineage_reject`;
      - `files.geometry_fp`;
      - the derived row ids in authored tables (`review_items.claim_id/file_id`,
        `prints.variant_id/file_id/model_id`, `decisions.from_claim_id`).
11. **Executed check (2026-09-30).** The §5 SQL block was run verbatim in Node 22.23
    `node:sqlite` with `PRAGMA foreign_keys=ON`:
    - All 24 tables were created, including the FTS table.
    - `pragma foreign_key_list` found **0 authored → derived foreign keys**.
    - A rebuild simulation (seed authored + derived rows, delete every derived row) left every
      authored row intact: roots, models, decisions, prints, review_items.
    - An obsolete relation (`not_member_of`) is rejected by the CHECK constraint.

---

## 20. Open items
- **None blocking.** Implementation waits for the owner's explicit **OK to Dev**.

---

## 21. M0 spike results (2026-09-30, commit 4311c47)

Measured on the owner's Windows machine and NAS (`\192.168.2.18\SnapCon`). The spike code is in
`spike/library-m0/`. §1–§20 above are unchanged. The changes proposed below await the owner's
approval before M1.

**R3 — worker_threads + node:sqlite under pkg: RESOLVED (win-x64).**
- A pkg build with the same flags as `npm run build` starts a Worker from the snapshot
  (`C:\snapshot\…\worker.js`). `node:sqlite` works inside the worker (Node 22.23.1, SQLite 3.51.3),
  and the DB is written next to the exe.
- 20k inserts + FTS: 360–400 ms.
- Longest main-thread stall while the worker ran: 17–23 ms, which is Windows timer granularity.
- The eval fallback works too. pkg found `worker.js` even without a `pkg.scripts` entry, but only
  through its path-literal heuristic.
- macOS/Linux builds were not executed here, since they cannot run on this machine.

**Synthetic DB** (canonical schema; ~1.8 Claims per file, Evidence ~360 bytes per Claim):

| Files | DB size | Without Evidence | Without Claims | Claims share | Evidence share |
|---|---|---|---|---|---|
| 10k | 39.7 MB | 32.7 | 25.5 | 14.2 MB (36%) | 7.0 MB (18%) |
| 50k | 198.2 MB | 163.0 | 127.0 | 71.2 MB (36%) | 35.2 MB (18%) |
| 100k | 397.7 MB | 326.7 | 254.4 | 143.3 MB (36%) | 70.9 MB (18%) |

Within the §5 estimate (250–450 MB at 100k), at the upper end. Largest tables at 100k: claims
143 MB, files 99, file_objects 57, variants 23, model_anchors 23, FTS 20.

**Query timings** (median, 100k files):
- Model page (Files + Claims, Variants + Claims, Prints): 0.28 ms.
- FTS search: 2–7 ms.
- Grid page 1: 15 ms.
- Needs-attention page: 0.9 ms.
- Diagnostics (Claims for 60 Models): 3.5 ms.
- Anchor match: 0.1 ms.
- Incremental scan: 27 µs per path lookup.
- Slow:
  - printer facet counts: **363 ms**;
  - grid at a deep offset: 92 ms;
  - grid filtered by printer: 79 ms.

**Defects found and fixed in the spike:**
- **Missing index `files(container_id)`.** The self-referencing foreign key made deleting files
  scan the whole table once per row, so the rebuild never finished at 10k. With the index, deleting
  every derived row takes 0.55 s at 10k and 12 s at 100k. Authored rows are intact in all runs.
- **A correlated `EXISTS` for "grid filtered by printer" took 15.7 s at 10k files.** Written as
  `m.id IN (…)` it takes 7 ms. The Diagnostics query likewise dropped from 67 ms to 1.4 ms when
  keyed on the Claim's object instead of its subject.

**Network share enumeration** (read-only; the largest real tree on the share has 238 files, so
these are per-file rates, not a 100k-file run):
- Stat: 2.1–6.6 ms per file at concurrency 1; 0.8–2.1 ms at concurrency 8.
- Extrapolated for 100k files: about 3.5–11 min at concurrency 1, 1.3–3.5 min at concurrency 8.
- Quick fingerprint (3 × 64 KB): 2–40 ms, with occasional outliers around 220 ms.
- **The §6.2 G-code reads (3 MB head + 3 MB tail) cost 230–450 ms per file** (~20 MB/s).
  - Across all 58 real G-code files, the extractor needs at most the **first 135 KB** (thumbnails
    + `EXCLUDE_OBJECT_DEFINE`) and the **last 32 KB** (config block).
  - A 512 KB + 256 KB window costs **15–74 ms** against 228–274 ms for 3 + 3 MB.

**ZIP64 / 3MF:**
- The range-read reader passes:
  - libarchive-written fixtures (deflate, zip64, zip64-stored, data descriptors, a UTF-8 name);
  - a hand-built zip64 fixture with saturated 32-bit fields, 0x0001 extras and a 0x7075 unicode
    name, extracted byte-identically by both bsdtar and .NET `Expand-Archive`;
  - both real 3MFs: every entry CRC-verified, entry lists identical to `threemf.js`.
- Metadata extraction read **134 KB of a 3.0 MB 3MF (4.3%) in 7 ms**, and 110 KB of 1.7 MB in 21 ms.
- **The current `threemf.js` rejects a zip64 3MF with saturated fields** ("zip64 archives are not
  supported"), while reading libarchive's non-saturated zip64 fine. This confirms the M3 hardening
  item.

**Where the spike differs from the design assumptions:**
1. §6.2's 3 MB + 3 MB G-code read window is ~20× more than real files need, and dominates a first
   index over SMB.
2. §5 lacked the `files(container_id)` index. It is an omission, not a conflict.
3. Facet counts over `variants` are too slow to run on every filter change at 100k.
4. Rebuild by `DELETE` cascade is slow at 100k (12 s). Acceptable for a rare operation, but
   dropping and recreating the derived tables is simpler and faster.
5. The DB lands at the top of the §5 size estimate. Claims are 36% of it and Evidence 18%, as
   designed.

**Accepted (owner, 2026-09-30), now part of the specification above:**
- **P1.** `files_container` index — §5. A measured requirement, not an optimisation.
- **P2.** Adaptive G-code read window: 512 KB head and 256 KB tail initially, grown when the
  markers are not found — §6.2.
- **P3.** Derived `model_families` table, the `models_grid` index, and keyset paging — §5,
  §14. A query optimisation only; printer identity stays with the resolver and
  Claims/Decisions (§4.6 rule 5).
- **P4.** Rebuild by drop-and-recreate of the derived tables — §4.6 rule 7, §14.
- **P5.** Worker entry listed in `pkg.scripts` — §15 M1. macOS/Linux packaged worker +
  `node:sqlite` verification — §15 M8. Neither blocks Windows M1 development.

---

## 22. M1 results (2026-09-30)

**Commits:** 97e3480 (subsystem), 515309c (server + Docker), e0392c2 (Settings > Library),
ee8c635 (backup failures). Nothing from M2 or later was implemented.

**Implemented vs. specification:**
- The schema is §5, statement for statement. `library/schema.js` is generated from it, and
  `test/library/schema.test.js` fails if they differ.
- `roots.status` never takes the value `scanning` in M1, and `last_scan_at` stays null: there is
  no indexing yet. In M1, **Rescan re-checks reachability**; M2 makes it index.
- A location's folder cannot be edited. Remove it and add the new one; decisions are keyed by
  content, so they survive that.

**Measured and decided during M1:**
- **Windows holds the first contact with an unreachable host for ~21 s**, and a JS timeout does
  not release the libuv thread it occupies.
  - libuv has four such threads, shared by the whole process, worker threads included.
  - Five unreachable probes at once stalled every file operation in SnapCon for 21 s (a local
    `readFile` took 20.9 s).
  - A repeat probe of a host already known to be down fails in 3 ms.
  - **Decision:** reachability checks are serialised process-wide (one in flight), so the Library
    can occupy at most one of the four threads. Measured live: while an unreachable add ran,
    `/api/fleet` answered in 363 ms and the NAS file list in 6 ms.
- **The worker gives no filesystem isolation** (the thread pool is shared).
  - Reachability checks therefore stay async on the main thread.
  - The worker's M1 job is backups: `VACUUM INTO` is synchronous in `node:sqlite`.
  - M2's worker-side enumeration of network locations must stay at concurrency 1 (§6.1) for the
    same reason.
- **A plain open reads only the header and schema.** A full `quick_check` costs 3.75 s at 100k
  files. It runs once, on the next start, after a backup was refused for failing it; a damaged
  database is then quarantined and the newest good backup restored.
- **Rebuild by drop-and-recreate (P4): 456 ms at 100k files**, against 12 s for the M0 `DELETE`
  cascade. Authored rows intact, no foreign-key violations.
- **Packaged Windows build** of the real app:
  - the worker runs as a thread;
  - `library-data/` is created next to the executable;
  - a backup ran through the worker in 30 ms;
  - the database persisted across a restart.

  A dynamic `require` in the fallback path, which pkg could not bundle, was replaced with a static
  one.
- **UNC behaviour (live, on the owner's NAS):**

  | Case | Result |
  |---|---|
  | Real share | `ok` in 9–11 ms |
  | Missing folder on a live share | `error`, "folder not found", 3 ms |
  | Missing share | `offline`, ~5 ms |
  | Unreachable host | `offline` at the 10 s timeout |
  | Parent share containing the G-code folder | refused, overlap |
  | Same folder with different case or a trailing slash | refused, overlap |

**Known limits, not fixed in M1:**
- A mapped drive letter (for example `Z:`) and the UNC path it maps are not recognised as the
  same folder: `realpath` does not resolve drive mappings. UNC paths are recommended. A Windows
  service may not see drive mappings at all.
- Docker behaviour is verified statically only (Dockerfile `COPY`, compose mount,
  `docker.test.js`). No Docker engine was available on this machine.

## 23. Prerequisite: network-filesystem resilience (2026-10-02, before M2)

**Requirement (owner):** a dead or slow NAS may make NAS-backed features unavailable, but it must
never make the SnapCon server itself unavailable or freeze unrelated local, API or UI work.

**Finding.** The problem was not the Library's; it was the G-code folder's, everywhere in
`server.js`. Measured on Windows, Node 22.23.1, packaged app, G-code folder on an unreachable share:
- about 50 synchronous fs calls on the G-code folder ran on the main thread; each one that touched
  the dead share froze the whole server for ~21 s, at any thread-pool size;
- the file browser's 15 s `/api/files` poll alone produced 40 of 160 samples over 1 s, max 21 s;
- async calls are no cure: libuv's four threads are process-wide, so four hung calls starve every
  file operation; a larger pool only moves the cliff, and `UV_THREADPOOL_SIZE` cannot be set from
  JS. The relaunch approach was rejected.

**Design (`netfs/`).** Shared by the G-code folder, the sync folders, the firmware folder and the
Library — one availability concept, not competing ones.
- Synchronous fs runs inside dedicated **worker threads**, in lanes: interactive 2, background 1,
  probe 1. A hung SMB call blocks one worker of one lane — never the main thread, never libuv's
  pool. A background scan cannot take interactive capacity.
- **Timeouts** start when a worker takes the job. Waiting for a worker is bounded separately and
  never counts against the storage.
- **Availability breaker**, per registered root or UNC share: `online`, `offline`, `checking`,
  with last success, last failure and the last error. A network error code or a timeout marks it
  offline. While offline, operations fail at once with `NAS_UNREACHABLE` (HTTP 503
  `gcode_folder_unreachable`), and jobs already queued for it fail immediately. One probe at a
  time on the probe lane re-checks it; any success marks it online. No permanent stale-offline
  state.
- **The breaker is an optimisation, never proof that a file exists.** Every route still checks
  every file on every use: containment, lstat/symlink rules, the forced pre-dispatch hash, and
  exclusive-create on upload are unchanged.

**What changed in behaviour.**
- G-code-folder routes answer 503 with a clear message while the share is down, instead of
  hanging.
- Queue dispatch claims nothing while the folder is known to be down. An outage discovered by
  the forced identity check puts the item back at the front, unverified
  (`QueueEngine.onDispatchDeferred`), instead of a false "file missing".
- A local read that fails mid-upload tears the request down, so a printer never receives a
  short file that looks complete.
- Sync runs to a network destination go one at a time and stop when the destination goes down.
- Startup creates network folders asynchronously.

**Measured after (same packaged build, same unreachable share):**
- 196 samples over 100 s: max 85 ms, none over 1 s (before: max 21 s, 40 of 160 over 1 s).
- Once the outage is known, `/api/files`, `/api/map`, thumbnails and search answer 503 in about
  2 ms. The single request that discovers the outage waits up to the 10 s operation timeout.

**Consequences for M2 (supersedes the related lines in §22):**
- Library reachability checks now run through netfs (probe lane), not async on the main thread.
- M2's enumeration and reads of network locations go through netfs's **background** lane, one
  operation at a time. It shares the breaker: an offline location stops the scan, and nothing is
  purged.

**Remaining bounded exposure, deliberately not converted:**
- The sync download's write stream and the U1 firmware deploy's image reads use `fs.promises`.
  Each is one at a time, so at most one libuv thread can hang.
- A mapped drive letter is recognised as network storage only when it is a registered root; the
  G-code folder always is.
