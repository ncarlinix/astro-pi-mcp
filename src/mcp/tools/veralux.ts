import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { toToolResult, resolveViewId, noViewResult } from './util.js';
import type { ExecuteMethod } from '../../types.js';

function methodFor(view: string): { executeMethod: ExecuteMethod; targetView: string } {
  return { executeMethod: 'executeOn', targetView: view };
}

/**
 * VeraLux HyperMetricStretch — a perceptual nonlinear stretch (the VeraLux module is installed as
 * native PixInsight processes, so this runs headless via run_process). Confirmed live: executing
 * it on a linear master stretches it (median 0.006 → 0.020). Defaults below are the module's own.
 * Its sibling, StarComposer (star recomposition), needs starless + starmask views — reach it via
 * run_process('StarComposer', { starlessView, starmaskView, ... }) when you have those.
 */
export const runVeralux: ToolDef = {
  name: 'run_veralux',
  description:
    "VeraLux HyperMetricStretch: a perceptual nonlinear stretch, run headless. Good as the broadband " +
    "stretch step (alternative to MTF/GHS). targetBackground sets the target background level; logD " +
    "is the stretch intensity; colorGrip/colorConvergence control colour; protectB protects bright " +
    "structure. In place. Omit \"view\" for the active image. (StarComposer, the VeraLux star step, " +
    "takes starless+starmask views — use run_process for it.)",
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    targetBackground: z.number().min(0.02).max(0.6).optional().describe('Target background level (default 0.2)'),
    logD: z.number().min(0).max(6).optional().describe('Stretch intensity, log of D (default 2)'),
    colorGrip: z.number().min(0).max(3).optional().describe('Colour grip / saturation hold (default 1)'),
    colorConvergence: z.number().min(0).max(10).optional().describe('Colour convergence (default 3.5)'),
    protectB: z.number().min(0).max(12).optional().describe('Bright-structure protection (default 6)'),
    adaptiveAnchor: z.boolean().optional().describe('Adaptive black anchor (default true)'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const settings: Record<string, unknown> = {
      targetBackground: (args.targetBackground as number | undefined) ?? 0.2,
      logD: (args.logD as number | undefined) ?? 2,
      colorGrip: (args.colorGrip as number | undefined) ?? 1,
      colorConvergence: (args.colorConvergence as number | undefined) ?? 3.5,
      protectB: (args.protectB as number | undefined) ?? 6,
      adaptiveAnchor: (args.adaptiveAnchor as boolean | undefined) ?? true,
    };
    const res = await backend.send('run_process', 'HyperMetricStretch', { processId: 'HyperMetricStretch', settings }, methodFor(viewId));
    const out = toToolResult(res);
    if (!out.isError) out.content.push({ type: 'text', text: `VeraLux HyperMetricStretch applied to ${viewId} (targetBackground=${settings.targetBackground}, logD=${settings.logD})` });
    return out;
  },
};

export const veraluxTools: ToolDef[] = [runVeralux];
