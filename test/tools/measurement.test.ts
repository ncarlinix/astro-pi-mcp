import { describe, it, expect } from 'vitest';
import {
  getNoise,
  getBackgroundGradient,
  getBackgroundNeutrality,
  getStarMetrics,
  getClipping,
  getMetadata,
} from '../../src/mcp/tools/measurement.js';
import { recordingBackend, type RecordedCall } from './helpers.js';
import type { BridgeResult } from '../../src/types.js';

// Every probe is delivered via run_script; return a valid JSON return value so the tool
// produces a non-error result, and let tests assert on the embedded probe code.
function jsonSend(call: RecordedCall): BridgeResult {
  if (call.tool === 'run_script') {
    return {
      id: 't', timestamp: '', status: 'success', process: '__script__', duration_ms: 1,
      outputs: { returnValue: JSON.stringify({ viewId: 'm31', ok: true }), watcherRev: 1 },
    };
  }
  return { id: 't', timestamp: '', status: 'success', process: call.process, duration_ms: 1, outputs: { watcherRev: 1 } };
}

const code = (c: RecordedCall) => String(c.parameters.code);

describe('measurement tools', () => {
  it('get_noise runs the MRS noise probe', async () => {
    const { backend, calls } = recordingBackend(jsonSend);
    const res = await getNoise.handler(backend, { view: 'm31' });
    expect(res.isError).toBeFalsy();
    expect(calls[0]!.tool).toBe('run_script');
    expect(code(calls[0]!)).toContain('noiseMRS');
  });

  it('get_background_gradient runs the gradient probe with grid params', async () => {
    const { backend, calls } = recordingBackend(jsonSend);
    await getBackgroundGradient.handler(backend, { view: 'm31', gridSize: 7 });
    expect(code(calls[0]!)).toContain('cornerSpread');
    expect(code(calls[0]!)).toContain('g = 7'); // gridSize substituted into the script
  });

  it('get_background_neutrality runs the neutrality probe', async () => {
    const { backend, calls } = recordingBackend(jsonSend);
    await getBackgroundNeutrality.handler(backend, { view: 'm31', mode: 'linear' });
    expect(code(calls[0]!)).toContain('bgChroma');
  });

  it('get_star_metrics runs the star probe with a long timeout', async () => {
    const { backend, calls } = recordingBackend(jsonSend);
    await getStarMetrics.handler(backend, { view: 'm31' });
    expect(code(calls[0]!)).toContain('starPixelMedian');
    expect(calls[0]!.options?.timeoutMs).toBe(600_000);
  });

  it('get_clipping runs the clipping probe', async () => {
    const { backend, calls } = recordingBackend(jsonSend);
    await getClipping.handler(backend, { view: 'm31' });
    expect(code(calls[0]!)).toContain('clippedBlackPct');
  });

  it('get_metadata runs the metadata probe', async () => {
    const { backend, calls } = recordingBackend(jsonSend);
    await getMetadata.handler(backend, { view: 'm31' });
    expect(code(calls[0]!)).toContain('FOCALLEN');
  });

  it('surfaces a probe error as an error result', async () => {
    const { backend } = recordingBackend((call) =>
      call.tool === 'run_script'
        ? { id: 't', timestamp: '', status: 'success', process: '__script__', duration_ms: 1, outputs: { returnValue: JSON.stringify({ error: 'Image not found: m31' }), watcherRev: 1 } }
        : jsonSend(call),
    );
    const res = await getNoise.handler(backend, { view: 'm31' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/not found/);
  });

  it('errors when no view and no active image', async () => {
    const { backend } = recordingBackend((call) =>
      call.tool === 'active_image'
        ? { id: 't', timestamp: '', status: 'success', process: '__internal__', duration_ms: 1, outputs: { active: null, watcherRev: 1 } }
        : jsonSend(call),
    );
    const res = await getNoise.handler(backend, {});
    expect(res.isError).toBe(true);
  });
});
