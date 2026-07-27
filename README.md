# AstroPilot AI

**An AI copilot for PixInsight and astrophotography.**

AstroPilot is an [MCP](https://modelcontextprotocol.io) server that lets an AI assistant
(Claude Desktop / Claude Code) understand astronomical images and drive **PixInsight** to
process them — you state the *outcome* ("process this galaxy naturally"), the assistant
picks, configures, runs, and verifies the PixInsight processes.

It talks to PixInsight through a **file-based JSON bridge** watched by a small **PJSR
script** that runs *inside* your own PixInsight. There is **no native module and no code
signing** — a design constraint of this project, and a hard requirement where signed
modules aren't available.

> Status: **all 20 roadmap stages have a first implementation** — 59 MCP tools spanning
> the PixInsight bridge, image-understanding measurements, target classification, the
> workflow/critique knowledge base, palettes, OSC duoband extraction, masks, equipment
> profiles, recipes, projects/reports, preferences, and session planning. The pure-
> reasoning stages (decision-making, vision feedback, learning) are realised as
> evidence-assembly + knowledge-retrieval tools that the assistant reasons over at runtime.
> Depth varies by stage. `plate_solve` uses an external **ASTAP** solver (install ASTAP +
> a star database; see below) — this unblocks SPCC/SPFC/MGC color calibration.
> `resolve_target` needs network access.

### Plate solving (ASTAP)

`plate_solve` shells out to [ASTAP](https://www.hnsky.org/astap.htm) (PixInsight's own
ImageSolver isn't compatible with the bridge's V8 engine). It saves the view to a temp
FITS, solves with header hints, writes the WCS back, and re-opens the solved file so SPCC
can read the astrometric solution. To enable it:

1. Install ASTAP (macOS default: `/Applications/ASTAP.app/Contents/MacOS/astap`), or the
   `astap_cli` binary on your `PATH`. Override the location with `ASTROPILOT_ASTAP_PATH`.
2. Install a star database (e.g. **D50** for ≳1° fields, or **H17/H18** for narrow fields).
   Point AstroPilot at the database folder with **`ASTROPILOT_ASTAP_DB`** (the directory
   containing the `*.1476`/`*.290` files), e.g.:
   ```json
   "astropilot": {
     "command": "node",
     "args": ["/absolute/path/to/astro-pi-mcp/dist/index.js"],
     "env": { "ASTROPILOT_ASTAP_DB": "/Users/you/Documents/astro/d50_star_database" }
   }
   ```
   If `ASTROPILOT_ASTAP_DB` is unset, AstroPilot auto-scans standard locations
   (`~/Library/Application Support/astap`, `~/.astap`, `/usr/local/share/astap`,
   `/opt/astap`); otherwise ASTAP falls back to its own `astap.cfg`.

`plate_solve` first checks whether the view already carries a WCS and **skips solving** if
so; otherwise it saves the view to a temp FITS, solves with ASTAP (using the image's RA/Dec/
scale as hints), writes the WCS back, and re-opens the solved file. Until ASTAP is present it
returns a clear "not installed" message. *(Verified live: Rosette master solved in ~4 s.)*

### Tool surface (59)

- **Images (S3):** open_image, save_image, close_image, list_images, active_image
- **Processing (S3):** run_process, get_process_parameters, run_process_icon, execute_js, wait_until_idle, cancel_job
- **Analysis/output (S3):** image_statistics, take_screenshot, export_preview, plate_solve
- **Measurement (S4):** get_noise, get_background_gradient, get_background_neutrality, get_star_metrics, get_clipping, get_metadata, **analyze_image**
- **Targets (S5):** resolve_target, classify_target
- **Knowledge (S6/7/13):** list_workflows, get_workflow, get_processing_guidance, explain
- **Evaluation (S8/15):** evaluate_image
- **Masks (S9):** make_mask
- **Palettes (S10):** list_palettes, apply_palette
- **OSC (S11):** list_osc_cameras, extract_duoband
- **Equipment (S12):** save/list/get/delete_equipment_profile
- **Recipes (S14):** save/list/get/delete_recipe, run_recipe
- **Compare (S16):** render_comparison
- **Session (S17):** get_history, get_full_history, undo, redo, snapshot, restore
- **Projects (S17):** save_project, list_projects, log_project_step, generate_report
- **Preferences (S18):** set_preference, get_preferences
- **Backends (S19):** list_backends
- **Planning (S20):** moon_info, target_visibility

Persistent state (profiles, recipes, projects, preferences) lives under `~/.astropilot/`
(override with `ASTROPILOT_HOME`).

## Architecture

```
  Claude (Desktop / Code)
        │  MCP over stdio (JSON-RPC)
        ▼
  AstroPilot MCP server  (this repo, TypeScript → dist/)
        │  ~/.astropilot/bridge/  commands/<id>.json  →  results/<id>.json
        ▼
  astropilot-watcher.js  (PJSR foreground loop, runs inside PixInsight — no signing)
        ▼
  PixInsight 1.9.4+
```

The watcher holds PixInsight's main thread while polling but calls `processEvents()`
frequently, so the UI stays usable during a session. (A native C++ module would keep it
fully interactive, but that requires module signing, which this project deliberately
avoids.)

## Requirements

- Node.js ≥ 20
- PixInsight 1.9.4+ (V8 PJSR engine)

## Setup

```bash
npm install
npm run build
npm run setup-bridge   # creates ~/.astropilot/bridge/{commands,results,logs}
```

## Start the watcher inside PixInsight (no signing needed)

You do **not** compile or sign anything. Choose one:

1. **Script Editor (quickest):** In PixInsight open `pjsr/astropilot-watcher.js`
   (SCRIPT → Script Editor → open file) and run it (**F9**). Leave it running during
   your AstroPilot session.
2. **Menu item (persistent):** SCRIPT → Feature Scripts… → add the `pjsr/` directory.
   The watcher then appears under **SCRIPT → AstroPilot → Start Watcher**.

The watcher prints a banner and begins polling `~/.astropilot/bridge`. To stop it, use
its abort (Ctrl/Cmd+F11) or create the file `~/.astropilot/bridge/shutdown`.

## Configure your MCP host

Add to your Claude Desktop / Claude Code MCP config:

```json
{
  "mcpServers": {
    "astropilot": {
      "command": "node",
      "args": ["/absolute/path/to/astro-pi-mcp/dist/index.js"]
    }
  }
}
```

## Development

```bash
npm test          # unit tests (no PixInsight needed)
npm run test:live # integration tests — requires PixInsight + watcher running
npm run lint
npm run format
```

## Credits

The bridge protocol, PJSR watcher loop, and processing-workflow knowledge base are ported
and adapted from the open-source [`pixinsight-mcp`](https://github.com/pardovot/pixinsight-mcp)
project (MIT). AstroPilot drops that project's native-module route (which needs signing)
in favour of a pure-PJSR watcher, and builds a broader astrophotography-intelligence layer
on top.

## License

MIT
