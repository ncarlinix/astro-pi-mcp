import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { toToolResult, resolveViewId, noViewResult } from './util.js';
import type { ExecuteMethod } from '../../types.js';

function methodFor(view: string): { executeMethod: ExecuteMethod; targetView: string } {
  return { executeMethod: 'executeOn', targetView: view };
}

/**
 * HDRMultiscaleTransform — tames a blown / near-blown core by compressing large-scale dynamic
 * range while preserving small-scale detail. This is the step we ran by hand on M42 and M83.
 * Fewer layers = stronger core compression on smaller structures. toLightness + luminanceMask
 * keep colour and protect the background. Operates in place on the target view.
 */
export const runHdrmt: ToolDef = {
  name: 'run_hdrmt',
  description:
    'HDRMultiscaleTransform to compress a bright/blown core while keeping detail (the M42/M83 ' +
    'core-taming step). Lower "layers" targets smaller structures / stronger effect. Applies to ' +
    'lightness with a luminance mask by default (colour-safe). In place. Omit "view" for the ' +
    'active image. Follow with verify_result to confirm the core no longer burns.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    layers: z.number().int().min(1).max(10).optional().describe('numberOfLayers (default 6; try 4–6 for cores)'),
    iterations: z.number().int().min(1).max(5).optional().describe('numberOfIterations (default 1)'),
    overdrive: z.number().min(0).max(1).optional().describe('overdrive, extra local contrast (default 0)'),
    toLightness: z.boolean().optional().describe('Apply to lightness only, preserving colour (default true)'),
    luminanceMask: z.boolean().optional().describe('Self-mask by luminance to protect background (default true)'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const settings: Record<string, unknown> = {
      numberOfLayers: (args.layers as number | undefined) ?? 6,
      numberOfIterations: (args.iterations as number | undefined) ?? 1,
      overdrive: (args.overdrive as number | undefined) ?? 0,
      toLightness: (args.toLightness as boolean | undefined) ?? true,
      luminanceMask: (args.luminanceMask as boolean | undefined) ?? true,
    };
    const res = await backend.send('run_process', 'HDRMultiscaleTransform', { processId: 'HDRMultiscaleTransform', settings }, methodFor(viewId));
    const out = toToolResult(res);
    if (!out.isError) out.content.push({ type: 'text', text: `HDRMT applied to ${viewId} (layers=${settings.numberOfLayers}, iter=${settings.numberOfIterations})` });
    return out;
  },
};

/**
 * LocalHistogramEqualization — adds local contrast ("pop") at a chosen spatial scale. We used it
 * ad hoc on nebula structure. radius sets the scale (larger = broader structures); slopeLimit
 * caps the contrast boost (keeps it from going harsh); amount blends the effect. In place.
 */
export const runLhe: ToolDef = {
  name: 'run_lhe',
  description:
    'LocalHistogramEqualization for local contrast / structure "pop" at a chosen scale. Larger ' +
    '"radius" boosts broader structures; "slopeLimit" caps harshness; "amount" blends it in. ' +
    'In place. Omit "view" for the active image. Usually masked — pass a mask via make_mask + ' +
    'run on the masked view, or apply at low amount.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    radius: z.number().int().min(16).max(512).optional().describe('Kernel radius in px (default 110; structure scale)'),
    slopeLimit: z.number().min(1).max(8).optional().describe('Contrast-limit slope (default 1.5; higher = stronger)'),
    amount: z.number().min(0).max(1).optional().describe('Effect blend 0..1 (default 0.8)'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const settings: Record<string, unknown> = {
      radius: (args.radius as number | undefined) ?? 110,
      slopeLimit: (args.slopeLimit as number | undefined) ?? 1.5,
      amount: (args.amount as number | undefined) ?? 0.8,
    };
    const res = await backend.send('run_process', 'LocalHistogramEqualization', { processId: 'LocalHistogramEqualization', settings }, methodFor(viewId));
    const out = toToolResult(res);
    if (!out.isError) out.content.push({ type: 'text', text: `LHE applied to ${viewId} (radius=${settings.radius}, slope=${settings.slopeLimit}, amount=${settings.amount})` });
    return out;
  },
};

export const detailTools: ToolDef[] = [runHdrmt, runLhe];
