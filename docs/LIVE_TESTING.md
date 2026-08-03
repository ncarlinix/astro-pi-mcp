# Live testing against real PixInsight

The unit suite runs against a *simulated* watcher. This procedure validates the bridge and
the risky tools against a real PixInsight (V8 PJSR) — the only way to know it actually works.

## Prerequisites
- PixInsight 1.9.4+ open.
- `npm install && npm run build` done in this repo.

## Steps

1. **Create the bridge dir** (once):
   ```bash
   npm run setup-bridge          # → ~/.astropilot/bridge/{commands,results,logs}
   ```

2. **Start the watcher inside PixInsight** (no signing needed):
   - **Process → Script Editor → File → Open** →
     `pjsr/astropilot-watcher.js` → press **F9**.
   - Or **SCRIPT → Feature Scripts… → Add** the `pjsr/` folder, then
     **SCRIPT → AstroPilot → Start Watcher**.
   - Confirm the console banner shows `Bridge: /Users/<you>/.astropilot/bridge` and
     `rev 2`. Leave it running.

3. **Run the live suite**:
   ```bash
   npm run test:live             # = ASTROPILOT_LIVE=1 vitest run
   ```
   It creates a synthetic 256×256 RGB image inside PixInsight, then exercises:
   execute_js · list/active_image · image_statistics · get_metadata · get_noise ·
   get_clipping · get_star_metrics · run_process (PixelMath) · take_screenshot ·
   snapshot/restore · get_history · analyze_image. It cleans up its windows afterward.

4. **Optional — test against a real file** (open_image + get_metadata):
   ```bash
   ASTROPILOT_LIVE=1 ASTROPILOT_TEST_IMAGE=/path/to/master.xisf npm run test:live
   ```

## Stopping the watcher
- **Ctrl+F11** in PixInsight, or `touch ~/.astropilot/bridge/shutdown`.

## Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| Every live test times out | Watcher not running, or its `Bridge:` path ≠ `~/.astropilot/bridge`. |
| `WatcherRevisionMismatch` error | Watcher script is older than the server — re-open `pjsr/astropilot-watcher.js` and F9 again (must be rev 2). |
| `take_screenshot` fails | Check `HistogramTransformation`/`Bitmap.save` errors in the PixInsight console; report the message. |
| `get_metadata` scale is null | Synthetic image has no FITS keywords — expected. Use `ASTROPILOT_TEST_IMAGE` with a real capture to test keyword parsing. |
| A tool errors only live | Capture the PixInsight **Process Console** output — the watcher logs `[AstroPilot] Error executing <tool>: <message>` there. |
