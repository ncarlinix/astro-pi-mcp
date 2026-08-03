# AstroPilot knowledge base

Reference material — **data, not code** — that later AstroPilot stages will consume. Ported
from the open-source `pixinsight-mcp` project (MIT). The tool surface stays generic
(`run_process` + `get_process_parameters`); these docs tell the assistant *how* to process
each kind of data. Nothing here is wired into the server yet.

## Contents → roadmap stage (see `prompt.md`)

| Asset | Feeds stage |
|---|---|
| `workflows/osc-hoo.md`, `osc-rgb.md`, `mono-rgb.md`, `mono-lrgb.md`, `mono-halrgb.md`, `mono-sho.md`, `mosaic.md` | **Stage 6** Workflow Intelligence — per-acquisition-category processing playbooks |
| `workflows/_common.md` | **Stage 6/7** shared operation set + pre/post-combine placement rules |
| `workflows/README.md` | The decomposition model (shared ops + combination point) behind the playbooks |
| `PROCESSING_GUIDE.md` | **Stage 7** AI decision making (DBE vs ABE, BXT/NXT strength, SPCC vs PCC, star handling) |
| `CRITIC_RUBRIC.md` | **Stage 15** Image Evaluation — what to critique and how to score |
| `pjsr-reference.md` | Hard-won PJSR API facts (used when extending `astropilot-watcher.js`) |
| `AUTONOMY.md` | **Stage 8** Vision feedback loop / measure→configure→verify methodology |
| `skills/process-master/` | **Stage 6** routes a goal to the right playbook, drives measure→configure→verify |
| `skills/image-critic/` | **Stage 15** critique skill |
| `skills/process-retro/`, `kb-gate/`, `pixinsight-pipeline/` | Stage 13/14 support (learning, recipes, gating) |

## Guiding methodology (keep across all stages)

- **Measure → configure → verify.** Measure the actual image before configuring a process;
  re-measure after (byte-identical stats = no-op = stop).
- **Never fabricate numeric settings.** Prefer tuning ranges driven by measurement; flag
  unsourced numbers.
- **Generic runner only.** Never add per-process MCP tools; everything is
  `new X; set params; executeOn(view)` via `run_process`.
- **Scientific vs artistic.** Clearly distinguish measured/real data from artistic
  interpretation (e.g. synthetic SHO is labelled, never claimed scientifically accurate).
