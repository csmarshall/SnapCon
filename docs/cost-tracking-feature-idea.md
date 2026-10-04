# Per-job cost/margin tracking — future feature idea

Status: **idea capture only, not scoped or approved.** No implementation planned; this is a
research note for future analysis, prompted by looking at how `Print-OS`
(github.com/simongonzalezdc/Print-OS) computes per-job cost/margin.

## Where this came from

While comparing SnapCon against other print-farm tools (PrintStream, print-farm-manager,
Print-OS — see `docs/bambu-lab-integration-research.md` and
`docs/prusa-integration-research.md` for the connector-focused research from the same
comparison pass), Print-OS's "cost-per-part economics" feature stood out as a genuinely
different capability SnapCon doesn't have: a way to turn a completed print into a cost and
profit/margin figure, not just a status/duration/filament-usage record.

Print-OS itself is a business-operations tool (FastAPI + Streamlit + Next.js, job
routing/cost/CAD workspace), not a fleet-monitoring app like SnapCon — it does have printer
connectors (`caedo-api/caedoapi/integrations/{moonraker,octoprint}.py`, behind a
`PrinterIntegration` base class: `get_status`/`submit_job`/`cancel_job`/`pause_job`/
`resume_job`), but the interesting part for SnapCon is the costing logic, not the connectors.

## What Print-OS actually does (verified from source, not the README)

`caedo-api/caedoapi/domain/costing.py`, `calculate_costs()` — a **per-job calculator**, not
historical analytics. (Its `costs_repo.py` looked like it might hold job-level cost history;
checked directly — it only stores the settings/rate overrides below in a key-value table, no
aggregate or trend queries exist anywhere in the codebase.)

**Inputs:** `grams` (material used), `minutes` (print duration), `material` type, `sell_price`,
plus a settings dict of rate overrides.

**Formula, with defaults (`COSTING_DEFAULTS`):**
- Material: `grams × (usd_per_kg / 1000)` — defaults to $20/kg if the material isn't in the
  configured table
- Electricity: `(minutes/60) × power_usage_kW × kwh_rate` — defaults 0.15 kW, $0.12/kWh
- Labor: `(setup_minutes/60) × labor_rate` — 5-minute setup default when a labor rate is set
- Depreciation: `(minutes/60) × depreciation_usd_per_hour` — default $0.10/hr
- Fixed: packaging ($1.50 default) + platform fee (`sell_price × 13%` default)

**Output:** itemized cost breakdown, `total_cost`, `profit = sell_price − total_cost`,
`margin %`, and warning flags when a job is unprofitable or under a 20% margin threshold.

## Why this maps reasonably well onto SnapCon

SnapCon already tracks the real, printer-reported inputs this needs per job — `filamentUsed`
and elapsed duration/`completedAt` are already captured and surfaced in Logs (`server.js`,
`public/app.js` around the job-detail rendering noted in the earlier research chat). What's
missing is purely the **business-input layer**: nothing here requires new printer telemetry,
only new user-supplied settings plus a derived-value display.

A plausible shape, **not designed yet**:

- Per-material $/kg table + a handful of global rate settings (electricity $/kWh, machine
  depreciation $/hr, optional labor rate, packaging, platform fee) — likely a Settings-tab
  addition following the existing dirty-state-footer convention (CLAUDE.md Section 5).
- A cost/margin figure computed from real per-job data (actual filament grams, actual elapsed
  time) rather than presented as an estimate baked into printer telemetry — this needs to
  respect CLAUDE.md Section 2 ("Printer data is evidence"): the filament/duration inputs are
  real, the cost math is a **derived estimate** built from user-entered rates, and the UI must
  make that distinction visible rather than blending it in as if it were printer-reported data.
- Display: most naturally per-job in Logs/print history where filament/duration already render;
  a fleet-wide cost rollup would be a separate, larger addition — worth noting Print-OS itself
  doesn't have aggregate reporting despite the README's "business reporting" framing, so there's
  no existing implementation to crib from for that part.

## Open questions for when/if this gets scoped

- Is this wanted at all, and for whom — hobbyist single-user farms probably don't care about
  margin %, so this may only make sense once/if SnapCon has a commercial-print-farm audience.
  Confirm before designing.
- Where do per-material $/kg values live — a new config section, or reuse whatever spool/
  inventory data already exists?
- Per CLAUDE.md Section 4/5: any UI for this reuses existing settings-table/helper-text/dirty-
  state patterns — no new visual language.
- Should failed/cancelled prints factor into cost (wasted material/time) — Print-OS's model
  doesn't address this either; it's a gap in the source it'd be copying.
- This is unrelated to the Bambu/Prusa connector work in flight — keep it a separate, later
  discussion per CLAUDE.md's scope-discipline rule rather than folding it into that effort.

Source: `simongonzalezdc/Print-OS`, `caedo-api/caedoapi/domain/costing.py` and
`caedo-api/caedoapi/repositories/costs_repo.py` (fetched and read directly, not inferred from
the README).
