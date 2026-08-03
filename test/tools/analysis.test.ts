import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import {
  imageStatistics,
  takeScreenshot,
  exportPreview,
  plateSolve,
} from '../../src/mcp/tools/analysis.js';
import { recordingBackend, type RecordedCall } from './helpers.js';
import type { BridgeResult } from '../../src/types.js';

function ok(process: string, returnValue: unknown): BridgeResult {
  return {
    id: 't',
    timestamp: '',
    status: 'success',
    process,
    duration_ms: 1,
    outputs: { returnValue: JSON.stringify(returnValue), watcherRev: 1 },
    message: 'ok',
  };
}

/** Emulates the watcher for render/dims run_script calls; writes the render output file so
 *  take_screenshot can read it back. */
function renderAwareSend(call: RecordedCall): BridgeResult | Promise<BridgeResult> {
  if (call.tool === 'active_image') {
    return { id: 't', timestamp: '', status: 'success', process: '__internal__', duration_ms: 1, outputs: { id: 'activeView', watcherRev: 1 } };
  }
  if (call.tool === 'run_script') {
    const code = String(call.parameters.code);
    if (/bmp\.save/.test(code)) {
      const m = /bmp\.save\((".*?")/.exec(code);
      const path = m ? (JSON.parse(m[1]!) as string) : '/tmp/none';
      return (async () => {
        await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // tiny fake JPEG
        return ok('__script__', { viewId: 'activeView', path, width: 100, height: 100, warnings: [] });
      })();
    }
    // dims script
    return ok('__script__', { viewId: 'activeView', width: 4000, height: 3000, isColor: true, channels: 3 });
  }
  return ok(call.process, {});
}

describe('analysis tools', () => {
  it('image_statistics forwards the view id', async () => {
    const { backend, calls } = recordingBackend();
    await imageStatistics.handler(backend, { view: 'm31' });
    expect(calls[0]).toMatchObject({
      tool: 'get_image_statistics',
      parameters: { viewId: 'm31' },
    });
  });

  it('take_screenshot resolves the active view and returns inline image content', async () => {
    const { backend, calls } = recordingBackend(renderAwareSend);
    const res = await takeScreenshot.handler(backend, {});
    // Resolves active view, fetches dims for downsample, then renders.
    expect(calls.map((c) => c.tool)).toEqual(['active_image', 'run_script', 'run_script']);
    expect(res.isError).toBeFalsy();
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
  });

  it('take_screenshot errors when there is no active view', async () => {
    const { backend } = recordingBackend((call) =>
      call.tool === 'active_image'
        ? { id: 't', timestamp: '', status: 'success', process: '__internal__', duration_ms: 1, outputs: { active: null, watcherRev: 1 } }
        : ok(call.process, {}),
    );
    const res = await takeScreenshot.handler(backend, {});
    expect(res.isError).toBe(true);
  });

  it('export_preview renders to the given path and returns metadata', async () => {
    const { backend, calls } = recordingBackend(renderAwareSend);
    const res = await exportPreview.handler(backend, { view: 'm31', path: '/tmp/preview.png' });
    // With an explicit view, no active_image call; dims + render only.
    expect(calls.map((c) => c.tool)).toEqual(['run_script']); // no maxDim → no dims call
    expect(res.isError).toBeFalsy();
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });

  it('plate_solve errors gracefully when the fake image cannot be solved', async () => {
    // Machine-independent: whether or not ASTAP is installed, solving a nonexistent fake
    // file must fail cleanly ("ASTAP not found" if absent, "Plate solve failed" if present).
    const { backend } = recordingBackend(renderAwareSend);
    const res = await plateSolve.handler(backend, { view: 'm31' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/astap not found|plate solve failed/i);
  });

  it('plate_solve skips ASTAP when the view already has a WCS', async () => {
    const send = (call: RecordedCall): BridgeResult => {
      if (call.tool === 'run_script' && String(call.parameters.code).includes('hasAstrometricSolution')) {
        return ok('__script__', { geometry: { width: 100, height: 100 }, metadata: {}, astrometry: { solved: true, hasCTYPE: true, hasCDMatrix: true } });
      }
      return ok(call.process, {});
    };
    const { backend, calls } = recordingBackend(send);
    const res = await plateSolve.handler(backend, { view: 'm31' });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.solver).toBe('existing-wcs');
    expect(parsed.solvedViewId).toBe('m31');
    // No save_image / open_image were issued (no re-solve).
    expect(calls.some((c) => c.tool === 'save_image')).toBe(false);
  });
});
