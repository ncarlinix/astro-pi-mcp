# AstroPilot AI — Project Status

Living tracker of what's done, in progress, and missing. Update as work lands.
_Last updated: 2026-07-27._

## At a glance
- **59 MCP tools** across roadmap Stages 1–20 (first implementation; depth varies).
- **93 unit tests** + **14 live integration tests** — build + ESLint/Prettier clean.
- **Live-validated against real PixInsight 1.9.4** (Rosette master): bridge round-trip,
  image understanding, ASTAP plate solve, and a full correct-order processing pipeline.
- Watcher: **rev 3** (source). Bridge: file-based, no native module, no signing.

## Setup dependencies (external)
| Dependency | Status | Notes |
|---|---|---|
| PixInsight 1.9.4+ | ✅ installed | arm64 |
| PJSR watcher running | ⚠️ **needs re-F9 to rev 3** | running instance is rev 2; reload `pjsr/astropilot-watcher.js` |
| ASTAP + D50 star DB | ✅ working | DB at `~/Documents/astro/d50_star_database`; set `ASTROPILOT_ASTAP_DB` |
| Gaia DR3/SP catalog (for SPCC) | ⏳ **downloading** | SPCC silently declines without it |
| BlurXTerminator / NoiseXTerminator / StarXTerminator | ✅ installed + licensed | verified running live |
| StarNet2 | ❌ not installed | SXT preferred anyway |

---

## Stage-by-stage status

### ✅ Done & live-validated
- **S1 Foundation** — TS/Node MCP server, Zod config, Pino logging (stderr-only), backend-plugin seam.
- **S2 Bridge** — file-bridge client (atomic writes, poll/timeout, malformed fail-fast, stale reap, liveness, version skew); PJSR foreground watcher (no signing). _Live: round-trip, recovery._
- **S3 Primitive tools** — open/save/close/list/active_image, run_process, get_process_parameters, run_process_icon, execute_js, wait_until_idle, cancel_job, image_statistics, take_screenshot, export_preview, plate_solve. _Live: all except cancel/wait (thin by design)._
- **S4 Image understanding** — get_noise, get_background_gradient, get_background_neutrality, get_star_metrics, get_clipping, get_metadata, `analyze_image`. _Live: correct classification of the Rosette master._
- **S5 Plate solving** — `plate_solve` via ASTAP (detect binary + DB, hint from header, WCS import, skip-if-already-solved). _Live: solved Rosette in ~4 s._

### 🟡 Implemented, not yet live-validated end-to-end
- **S5 Target classification** — `classify_target` (metadata + star density + optional SIMBAD); `resolve_target` (needs network). _Unit-tested; not run on real target._
- **S6/7/13 Knowledge** — list_workflows, get_workflow, get_processing_guidance, explain (reads `docs/`).
- **S8/15 Evaluation** — `evaluate_image` (scored critique + suggestions). _Ran live; scoring thresholds are first-draft, uncalibrated._
- **S9 Masks** — `make_mask` (luminance/range/star via StarMask).
- **S10 Palettes** — list_palettes, apply_palette (HOO/SHO/HOS + synthetic-SHO; Foraxx is a KB pointer, not fabricated).
- **S11 OSC** — list_osc_cameras, extract_duoband.
- **S12 Equipment profiles** — CRUD (persisted under `~/.astropilot`).
- **S14 Recipes** — CRUD + versioning + run_recipe.
- **S16 Multi-version** — render_comparison (inline side-by-side).
- **S17 Project mgmt / session** — get/full history, undo, redo, snapshot, restore (live ✓); save/list_project, log_project_step, generate_report.
- **S18 Preferences** — set/get_preference (global + project override).
- **S19 Plugins** — list_backends on the ProcessingBackend seam (no second backend yet).
- **S20 Planning** — moon_info, target_visibility (offline ephemeris math).

### 🔴 Not built / thin
- **S6 Workflow orchestration** — no `process_target` that *drives* a full workflow; the agent composes `run_process` guided by `docs/workflows`. (Deliberate: knowledge-driven, generic runner.)
- **S8 Vision feedback loop** — no automated iterate-until-quality loop; realized as agent using take_screenshot + evaluate_image + re-run.
- **S9 Advanced processing** — star/nebula split, recombination, halo/HDR are workflow steps, not dedicated tools.
- **S16 `generate_versions`** — no one-call multi-interpretation generator (compose palettes/recipes manually).
- **S19** — no actual second backend (Siril/GraXpert) implemented.
- **S20** — no capture/weather/mosaic planning beyond moon/visibility.

---

## Processing-pipeline validation (Rosette, OSC broadband)
Correct linear-first order run live on the plate-solved master:
- ✅ BXT Correct Only · ✅ GradientCorrection (gradient 2.5% → ~1%, **while linear**) ·
  ⚠️ **SPCC declined** (no Gaia catalog) · ✅ BXT sharpen · ✅ NXT (noise ~5× lower) · ✅ stretch.
- Key lesson confirmed: gradient correction **before** stretch keeps it ~1% (vs 22.8% when stretched first).

---

## Known issues / bugs
- [ ] **SPCC silently declines** without the Gaia DR3/SP catalog → color not calibrated (image stays green). _Waiting on catalog download._
- [ ] **`get_star_metrics` returned null FWHM** on the reopened `Image11` mid-pipeline (worked on the original master). No repro yet — investigate.
- [ ] **Metadata FITS strings truncated** to ~18 chars (`"ASI Camera (2) (AS"`) — FITS limit; add HIERARCH/long-string handling for full names.
- [ ] **`gain` keyword parse** grabbed an `EGAIN`-style value (2.06767) — reprioritize `GAIN` over `EGAIN`.
- [ ] **`evaluate_image` thresholds** are first-draft heuristics — calibrate against real images + the critic rubric.

## Next actions (immediate)
- [ ] Re-run watcher (F9) → rev 3 so the version matches the server.
- [ ] Finish Gaia DR3/SP catalog install → re-run pipeline → verify SPCC calibrates (green gone).
- [ ] Capture the winning pipeline as a saved **recipe** (`save_recipe` → `run_recipe`).
- [ ] Push to GitHub — commit `b25a00e` is ready on `main`; blocked on auth (`ncarlini-ps` has READ-only on `ncarlinix/astro-pi-mcp`). Options: auth as `ncarlinix`, add collaborator, or push manually.

## Deferred / future
- Second processing backend (Siril / GraXpert) via the plugin seam (S19).
- `process_target` workflow orchestration (S6) + automated vision loop (S8).
- Calibrate evaluation scoring; deepen palette/OSC coverage.
- CI (build + test on push) once the repo is pushable.

---
_Ephemeral working notes live in `.plan/` (gitignored). This file is the committed source of truth for status._
