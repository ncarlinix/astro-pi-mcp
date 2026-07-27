import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordingBackend, type RecordedCall } from './helpers.js';
import type { BridgeResult } from '../../src/types.js';

import { applyPalette, listPalettes } from '../../src/mcp/tools/palette.js';
import { extractDuoband, listOscCameras } from '../../src/mcp/tools/osc.js';
import { saveEquipmentProfile, listEquipmentProfiles, getEquipmentProfile, deleteEquipmentProfile } from '../../src/mcp/tools/equipment.js';
import { saveRecipe, runRecipe } from '../../src/mcp/tools/recipes.js';
import { setPreference, getPreferences } from '../../src/mcp/tools/preferences.js';
import { saveProject, logProjectStep, generateReport } from '../../src/mcp/tools/project.js';
import { moonInfo, targetVisibility } from '../../src/mcp/tools/planning.js';
import { evaluateImage } from '../../src/mcp/tools/evaluate.js';
import { makeMask } from '../../src/mcp/tools/masks.js';
import { undo } from '../../src/mcp/tools/session.js';
import { classifyTargetTool } from '../../src/mcp/tools/target.js';
import { listWorkflows } from '../../src/mcp/tools/knowledge.js';

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? '').join('\n');
}
function json(res: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(res.content.find((c) => c.type === 'text')!.text!);
}

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'astropilot-home-'));
  process.env.ASTROPILOT_HOME = home;
});
afterAll(async () => {
  delete process.env.ASTROPILOT_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('Stage 10 palettes', () => {
  it('applies HOO via PixelMath', async () => {
    const { backend, calls } = recordingBackend();
    const res = await applyPalette.handler(backend, { palette: 'HOO', ha: 'Ha', oiii: 'OIII' });
    expect(res.isError).toBeFalsy();
    const s = calls[0]!.parameters.settings as Record<string, unknown>;
    expect(calls[0]!.process).toBe('PixelMath');
    expect(s.expression).toBe('Ha');
    expect(s.expression1).toBe('OIII');
    expect(s.createNewImage).toBe(true);
  });
  it('rejects a palette with missing channels', async () => {
    const { backend } = recordingBackend();
    const res = await applyPalette.handler(backend, { palette: 'SHO', ha: 'Ha', oiii: 'OIII' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/SII/);
  });
  it('lists palettes', async () => {
    const { backend } = recordingBackend();
    const res = await listPalettes.handler(backend, {});
    expect(json(res).some((p: any) => p.id === 'HOO')).toBe(true);
  });
});

describe('Stage 11 OSC', () => {
  it('extract_duoband issues two PixelMath calls', async () => {
    const { backend, calls } = recordingBackend();
    const res = await extractDuoband.handler(backend, { view: 'osc' });
    expect(res.isError).toBeFalsy();
    expect(calls.filter((c) => c.process === 'PixelMath')).toHaveLength(2);
    expect(text(res)).toContain('osc_Ha');
  });
  it('lists cameras', async () => {
    const { backend } = recordingBackend();
    expect(text(await listOscCameras.handler(backend, {}))).toContain('ASI533');
  });
});

describe('Stage 12 equipment profiles (persisted)', () => {
  it('round-trips a profile', async () => {
    const { backend } = recordingBackend();
    await saveEquipmentProfile.handler(backend, { id: 'rig1', camera: 'ASI2600MC', bortle: 6 });
    expect(json(await getEquipmentProfile.handler(backend, { id: 'rig1' })).camera).toBe('ASI2600MC');
    expect(json(await listEquipmentProfiles.handler(backend, {})).length).toBe(1);
    const del = await deleteEquipmentProfile.handler(backend, { id: 'rig1' });
    expect(del.isError).toBeFalsy();
  });
});

describe('Stage 14 recipes', () => {
  it('versions on re-save and dry-runs without executing', async () => {
    const { backend, calls } = recordingBackend();
    const steps = [{ processId: 'AutomaticBackgroundExtractor' }, { processId: 'PixelMath', settings: { expression: '$T' } }];
    const v1 = json(await saveRecipe.handler(backend, { id: 'r1', steps }));
    expect(v1.saved.version).toBe(1);
    const v2 = json(await saveRecipe.handler(backend, { id: 'r1', steps }));
    expect(v2.saved.version).toBe(2);
    const run = json(await runRecipe.handler(backend, { id: 'r1', dryRun: true }));
    expect(run.results).toHaveLength(2);
    expect(calls.filter((c) => c.tool === 'run_process')).toHaveLength(0); // dry run
  });

  it('executes steps against the backend', async () => {
    const { backend, calls } = recordingBackend();
    await saveRecipe.handler(backend, { id: 'r2', steps: [{ processId: 'PixelMath', settings: { expression: '$T' } }] });
    await runRecipe.handler(backend, { id: 'r2', view: 'v' });
    const proc = calls.find((c) => c.tool === 'run_process')!;
    expect(proc.process).toBe('PixelMath');
    expect(proc.options?.targetView).toBe('v');
  });
});

describe('Stage 18 preferences', () => {
  it('sets global + project override and computes effective', async () => {
    const { backend } = recordingBackend();
    await setPreference.handler(backend, { key: 'favoritePalette', value: 'HOO' });
    await setPreference.handler(backend, { key: 'favoritePalette', value: 'SHO', project: 'p1' });
    const eff = json(await getPreferences.handler(backend, { project: 'p1' }));
    expect(eff.effective.favoritePalette).toBe('SHO');
    const glob = json(await getPreferences.handler(backend, {}));
    expect(glob.effective.favoritePalette).toBe('HOO');
  });
});

describe('Stage 17 projects', () => {
  it('saves, logs, and generates a markdown report', async () => {
    const { backend } = recordingBackend();
    await saveProject.handler(backend, { id: 'rosette', target: 'Rosette Nebula', frames: { lights: 120 } });
    await logProjectStep.handler(backend, { id: 'rosette', entry: 'Ran DBE' });
    const report = text(await generateReport.handler(backend, { id: 'rosette' }));
    expect(report).toContain('# Processing Report');
    expect(report).toContain('Rosette Nebula');
    expect(report).toContain('Ran DBE');
  });
});

describe('Stage 20 planning', () => {
  it('moon_info returns a fraction', async () => {
    const { backend } = recordingBackend();
    const info = json(await moonInfo.handler(backend, { when: '2024-06-06T12:00:00Z' }));
    expect(info.illuminatedFraction).toBeGreaterThanOrEqual(0);
    expect(info.illuminatedFraction).toBeLessThanOrEqual(1);
  });
  it('target_visibility computes altitude + moon separation', async () => {
    const { backend } = recordingBackend();
    const v = json(await targetVisibility.handler(backend, { ra: '05 41 00', dec: '+04 07 00', lat: 40, lon: -74, when: '2026-01-01T06:00:00Z' }));
    expect(typeof v.target.altitude).toBe('number');
    expect(typeof v.moon.separationDeg).toBe('number');
  });
});

describe('Stage 8/15 evaluate_image', () => {
  it('scores an image from probe outputs', async () => {
    const send = (call: RecordedCall): BridgeResult => {
      const ret = (o: unknown): BridgeResult => ({ id: 't', timestamp: '', status: 'success', process: '__script__', duration_ms: 1, outputs: { returnValue: JSON.stringify(o), watcherRev: 2 } });
      const code = String(call.parameters.code);
      if (code.includes('clippedBlackPct')) return ret({ channels: [{ clippedBlackPct: 0, saturatedWhitePct: 0.3 }] });
      if (code.includes('cornerSpread')) return ret({ channels: [{ cornerSpreadPctOfCenter: 4 }] });
      if (code.includes('pixelFraction')) return ret({ channels: [{ sigma: 0.0006 }] });
      return ret({});
    };
    const { backend } = recordingBackend(send);
    const res = json(await evaluateImage.handler(backend, { view: 'v', skipStars: true }));
    expect(res.overallScore).toBeGreaterThan(0);
    expect(res.overallScore).toBeLessThanOrEqual(100);
    expect(res.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Stage 9 masks', () => {
  it('luminance mask uses CIEL via PixelMath', async () => {
    const { backend, calls } = recordingBackend();
    await makeMask.handler(backend, { view: 'v', mode: 'luminance', color: true });
    expect((calls[0]!.parameters.settings as any).expression).toBe('CIEL($T)');
  });
  it('star mask runs StarMask', async () => {
    const { backend, calls } = recordingBackend();
    await makeMask.handler(backend, { view: 'v', mode: 'star' });
    expect(calls[0]!.process).toBe('StarMask');
  });
});

describe('Stage 17 session', () => {
  it('undo forwards to the bridge', async () => {
    const { backend, calls } = recordingBackend();
    await undo.handler(backend, { view: 'v', steps: 2 });
    expect(calls[0]!.tool).toBe('undo');
    expect(calls[0]!.parameters).toMatchObject({ viewId: 'v', steps: 2 });
  });
});

describe('Stage 5 classify_target (offline heuristic)', () => {
  it('assembles evidence from metadata + stars', async () => {
    const send = (call: RecordedCall): BridgeResult => {
      const ret = (o: unknown): BridgeResult => ({ id: 't', timestamp: '', status: 'success', process: '__script__', duration_ms: 1, outputs: { returnValue: JSON.stringify(o), watcherRev: 2 } });
      const code = String(call.parameters.code);
      if (code.includes('FOCALLEN')) return ret({ geometry: { width: 4000, height: 3000 }, metadata: { object: 'M42', filter: 'L-Ultimate' } });
      if (code.includes('starPixelMedian')) return ret({ starCount: 3000 });
      return ret({});
    };
    const { backend } = recordingBackend(send);
    const res = json(await classifyTargetTool.handler(backend, { view: 'v' }));
    expect(res.evidence.objectName).toBe('M42');
    expect(res.evidence.starDensityPerMpx).toBeGreaterThan(0);
  });
});

describe('Stage 6 knowledge', () => {
  it('list_workflows returns categories', async () => {
    const { backend } = recordingBackend();
    const list = json(await listWorkflows.handler(backend, {}));
    expect(list.some((w: any) => w.category === 'mono-sho')).toBe(true);
  });
});
