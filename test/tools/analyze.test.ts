import { describe, it, expect } from 'vitest';
import { analyzeImage } from '../../src/mcp/tools/analyze.js';
import { recordingBackend, type RecordedCall } from './helpers.js';
import type { BridgeResult } from '../../src/types.js';

function ret(obj: unknown): BridgeResult {
  return {
    id: 't', timestamp: '', status: 'success', process: '__script__', duration_ms: 1,
    outputs: { returnValue: JSON.stringify(obj), watcherRev: 1 },
  };
}

/** Dispatch each probe by a unique marker in its script body and return canned data for a
 *  linear color image. */
function makeSend(overrides: Partial<Record<string, unknown>> = {}) {
  return (call: RecordedCall): BridgeResult => {
    if (call.tool !== 'run_script') {
      return { id: 't', timestamp: '', status: 'success', process: call.process, duration_ms: 1, outputs: { watcherRev: 1 } };
    }
    const code = String(call.parameters.code);
    if (code.includes('FOCALLEN')) {
      return ret(overrides.metadata ?? {
        geometry: { width: 4000, height: 3000, channels: 3, isColor: true, bitsPerSample: 32 },
        metadata: { camera: 'ASI2600MC', imageScaleArcsecPerPx: 1.5, focalLengthMm: 500, pixelSizeUm: 3.76 },
      });
    }
    if (code.includes('clippedBlackPct')) {
      return ret(overrides.clipping ?? {
        channels: [
          { name: 'R', p50: 0.03, min: 0.001, max: 0.9, clippedBlackPct: 0, saturatedWhitePct: 0.2 },
          { name: 'G', p50: 0.028, min: 0.001, max: 0.88, clippedBlackPct: 0, saturatedWhitePct: 0.1 },
          { name: 'B', p50: 0.032, min: 0.001, max: 0.92, clippedBlackPct: 0, saturatedWhitePct: 0.3 },
        ],
      });
    }
    if (code.includes('starPixelMedian')) {
      return ret(overrides.stars ?? { starCount: 1200, medianFWHM: 3.2, medianEccentricity: 0.4 });
    }
    if (code.includes('pixelFraction')) {
      return ret(overrides.noise ?? {
        channels: [
          { name: 'R', sigma: 0.0005 },
          { name: 'G', sigma: 0.0005 },
          { name: 'B', sigma: 0.0005 },
        ],
      });
    }
    if (code.includes('cornerSpread')) {
      return ret(overrides.gradient ?? {
        channels: [
          { cornerSpreadPctOfCenter: 5 },
          { cornerSpreadPctOfCenter: 4 },
          { cornerSpreadPctOfCenter: 5 },
        ],
      });
    }
    if (code.includes('bgChroma')) {
      return ret(overrides.neutrality ?? { spreadPct: 0.8 });
    }
    return ret({});
  };
}

function parse(text: string) {
  return JSON.parse(text) as { summary: string; report: any };
}

describe('analyze_image', () => {
  it('produces a full report for a linear color image', async () => {
    const { backend, calls } = recordingBackend(makeSend());
    const res = await analyzeImage.handler(backend, { view: 'm31' });
    expect(res.isError).toBeFalsy();
    const { summary, report } = parse((res.content[0] as { text: string }).text);

    expect(report.classification.linear).toBe(true);
    expect(report.classification.label).toBe('linear');
    expect(report.gradient.severity).toBe('mild');
    expect(report.neutrality.neutral).toBe(true);
    expect(report.stars.starDensityPerMpx).toBe(100); // 1200 / 12 Mpx
    expect(report.snrByChannel[0].medianOverSigma).toBe(60); // 0.03 / 0.0005
    expect(report.imageScaleArcsecPerPx).toBe(1.5);
    expect(summary).toContain('linear');
    expect(summary).toContain('stars');

    // Ran metadata, clipping, noise, gradient, neutrality (color), stars = 6 run_scripts.
    expect(calls.filter((c) => c.tool === 'run_script')).toHaveLength(6);
  });

  it('classifies a nonlinear image and skips stars + neutrality (mono)', async () => {
    const send = makeSend({
      metadata: { geometry: { width: 2000, height: 2000, channels: 1, isColor: false }, metadata: {} },
      clipping: { channels: [{ name: 'K', p50: 0.35, min: 0.01, max: 1, clippedBlackPct: 0, saturatedWhitePct: 2.5 }] },
      noise: { channels: [{ name: 'K', sigma: 0.002 }] },
      gradient: { channels: [{ cornerSpreadPctOfCenter: 40 }] },
    });
    const { backend, calls } = recordingBackend(send);
    const res = await analyzeImage.handler(backend, { view: 'mono', skipStars: true });
    const { summary, report } = parse((res.content[0] as { text: string }).text);

    expect(report.classification.linear).toBe(false);
    expect(report.gradient.severity).toBe('strong');
    expect(report.neutrality).toBeNull(); // mono → no neutrality probe
    expect(report.stars).toBeNull(); // skipStars
    expect(summary).toContain('mono');
    expect(summary).toContain('saturated');
    // metadata, clipping, noise, gradient only (no neutrality, no stars).
    expect(calls.filter((c) => c.tool === 'run_script')).toHaveLength(4);
  });

  it('errors when there is no active image', async () => {
    const { backend } = recordingBackend((call) =>
      call.tool === 'active_image'
        ? { id: 't', timestamp: '', status: 'success', process: '__internal__', duration_ms: 1, outputs: { active: null, watcherRev: 1 } }
        : ret({}),
    );
    const res = await analyzeImage.handler(backend, {});
    expect(res.isError).toBe(true);
  });
});
