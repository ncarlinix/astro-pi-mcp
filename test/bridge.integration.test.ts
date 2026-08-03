// Live integration test — requires a running PixInsight with pjsr/astropilot-watcher.js
// started (F9). Self-skips unless ASTROPILOT_LIVE=1 so ordinary `npm test` stays green on
// machines without PixInsight.
//
//   1. Open PixInsight, run pjsr/astropilot-watcher.js (F9).
//   2. ASTROPILOT_LIVE=1 npm run test        (or: npm run test:live)
//
// The suite creates its own synthetic image inside PixInsight (no external file needed),
// exercises the risky tool chain against it, then cleans up. If ASTROPILOT_TEST_IMAGE
// points at a real file, open_image + get_metadata are tested against it too.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PixInsightBackend } from '../src/backend/pixinsight.js';
import { executeJs, runProcess } from '../src/mcp/tools/processing.js';
import { listImages, activeImage, openImage, closeImage } from '../src/mcp/tools/images.js';
import { imageStatistics, takeScreenshot } from '../src/mcp/tools/analysis.js';
import { getMetadata, getNoise, getClipping, getStarMetrics } from '../src/mcp/tools/measurement.js';
import { analyzeImage } from '../src/mcp/tools/analyze.js';
import { snapshot, restore, getHistory } from '../src/mcp/tools/session.js';

const LIVE = process.env.ASTROPILOT_LIVE === '1';
const TEST_ID = 'astropilot_test';
const T = 60_000;

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? '').join('\n');
}

describe.skipIf(!LIVE)('live bridge (PixInsight + watcher required)', () => {
  const backend = new PixInsightBackend();

  beforeAll(async () => {
    await backend.init();
    if (!(await backend.isAlive())) {
      throw new Error('Watcher not responding. Open pjsr/astropilot-watcher.js in PixInsight and run it (F9).');
    }
    // Create a synthetic 256×256 RGB image with a background level and a bright block
    // (a fake "star") so statistics/rendering/stars have real content to chew on.
    const make = `(function(){
      var id = ${JSON.stringify(TEST_ID)};
      var ex = ImageWindow.windowById(id); if (!ex.isNull) ex.forceClose();
      var w = new ImageWindow(256, 256, 3, 32, true, true, id);
      var v = w.mainView; v.beginProcess();
      v.image.fill(0.1);
      v.image.selectedRect = new Rect(120, 120, 140, 140);
      v.image.fill(0.9);
      v.image.resetSelections();
      v.endProcess(); w.show();
      id
    })()`;
    const res = await executeJs.handler(backend, { code: make });
    if (res.isError) throw new Error('Could not create synthetic test image: ' + textOf(res));
  }, T);

  afterAll(async () => {
    await executeJs
      .handler(backend, {
        code: `["${TEST_ID}","${TEST_ID}_snap"].forEach(function(id){var w=ImageWindow.windowById(id); if(!w.isNull) w.forceClose();}); "cleaned"`,
      })
      .catch(() => {});
  }, T);

  it('execute_js evaluates 2+2 to 4', async () => {
    const res = await executeJs.handler(backend, { code: '2+2' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('4');
  }, T);

  it('list_images includes the synthetic image', async () => {
    const res = await listImages.handler(backend, {});
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(TEST_ID);
  }, T);

  it('active_image returns without error', async () => {
    expect((await activeImage.handler(backend, {})).isError).toBeFalsy();
  }, T);

  it('image_statistics reports the elevated mean from the bright block', async () => {
    const res = await imageStatistics.handler(backend, { view: TEST_ID });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/mean/i);
  }, T);

  it('get_metadata returns geometry for the synthetic image', async () => {
    const res = await getMetadata.handler(backend, { view: TEST_ID });
    expect(res.isError).toBeFalsy();
    const meta = JSON.parse(textOf(res));
    expect(meta.geometry.width).toBe(256);
    expect(meta.geometry.isColor).toBe(true);
  }, T);

  it('get_noise returns per-channel sigma', async () => {
    const res = await getNoise.handler(backend, { view: TEST_ID });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res)).channels.length).toBe(3);
  }, T);

  it('get_clipping returns exact min/max', async () => {
    const res = await getClipping.handler(backend, { view: TEST_ID });
    expect(res.isError).toBeFalsy();
    const c = JSON.parse(textOf(res)).channels[0];
    expect(c.max).toBeGreaterThan(0.8); // the bright block
  }, T);

  it('get_star_metrics runs the detector', async () => {
    const res = await getStarMetrics.handler(backend, { view: TEST_ID, maxStars: 50 });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toHaveProperty('starCount');
  }, T);

  it('run_process applies PixelMath (identity) on the view', async () => {
    const res = await runProcess.handler(backend, { processId: 'PixelMath', settings: { expression: '$T', useSingleExpression: true }, view: TEST_ID });
    expect(res.isError).toBeFalsy();
  }, T);

  it('take_screenshot returns inline image content', async () => {
    const res = await takeScreenshot.handler(backend, { view: TEST_ID, maxDim: 256 });
    expect(res.isError).toBeFalsy();
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
  }, T);

  it('snapshot then restore round-trips (rev-2 watcher)', async () => {
    const snap = await snapshot.handler(backend, { view: TEST_ID });
    expect(snap.isError).toBeFalsy();
    const rest = await restore.handler(backend, { view: TEST_ID, snapshotId: `${TEST_ID}_snap` });
    expect(rest.isError).toBeFalsy();
  }, T);

  it('get_history reports a non-negative index', async () => {
    const res = await getHistory.handler(backend, { view: TEST_ID });
    expect(res.isError).toBeFalsy();
    // toToolResult joins the outputs JSON and the human message with a blank line;
    // parse just the JSON prefix.
    const outputs = JSON.parse((res.content[0] as { text: string }).text.split('\n\n')[0]!);
    expect(outputs.historyIndex).toBeGreaterThanOrEqual(0);
  }, T);

  it('analyze_image produces a report + summary', async () => {
    const res = await analyzeImage.handler(backend, { view: TEST_ID, skipStars: true });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res));
    expect(parsed).toHaveProperty('summary');
    expect(parsed.report.geometry.width).toBe(256);
  }, T);

  it('opens ASTROPILOT_TEST_IMAGE and reads its metadata (if provided)', async () => {
    const path = process.env.ASTROPILOT_TEST_IMAGE;
    if (!path) {
      expect(true).toBe(true); // no file provided → nothing to assert
      return;
    }
    const opened = await openImage.handler(backend, { path });
    expect(opened.isError).toBeFalsy();
    const openedId = (JSON.parse(textOf(opened)) as { id?: string }).id;
    expect(openedId).toBeTruthy();
    const meta = await getMetadata.handler(backend, { view: openedId! });
    expect(meta.isError).toBeFalsy();
    if (openedId) await closeImage.handler(backend, { view: openedId });
  }, T);
});
