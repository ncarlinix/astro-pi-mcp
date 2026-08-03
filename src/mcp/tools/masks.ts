import { z } from 'zod';
import type { ToolDef } from './types.js';
import { toToolResult, resolveViewId, noViewResult } from './util.js';

export const makeMask: ToolDef = {
  name: 'make_mask',
  description:
    'Generate a mask from an open view (Stage 9). Modes: "luminance" (extract luminance via ' +
    'PixelMath CIEL for color, identity for mono), "range" (binary/soft mask for a value band ' +
    '[lo,hi]), "star" (PixInsight StarMask process). Creates a new mask view. Omit "view" for ' +
    'the active image.',
  inputSchema: {
    view: z.string().optional(),
    mode: z.enum(['luminance', 'range', 'star']),
    lo: z.number().min(0).max(1).optional().describe('range mode: low bound (default 0)'),
    hi: z.number().min(0).max(1).optional().describe('range mode: high bound (default 1)'),
    color: z.boolean().optional().describe('luminance mode: source is color (use CIEL); default true'),
    newImageId: z.string().optional().describe('Output mask id (default "<view>_mask")'),
  },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const maskId = (args.newImageId as string | undefined) ?? `${viewId}_mask`;
    const mode = args.mode as 'luminance' | 'range' | 'star';

    if (mode === 'star') {
      // StarMask creates its own star-mask window from the target view.
      const res = await backend.send('run_process', 'StarMask', { processId: 'StarMask', settings: {} }, {
        executeMethod: 'executeOn',
        targetView: viewId,
      });
      const out = toToolResult(res);
      if (!out.isError) out.content.push({ type: 'text', text: 'StarMask created a star-mask window; use list_images to find its id.' });
      return out;
    }

    let expression: string;
    if (mode === 'luminance') {
      const isColor = (args.color as boolean | undefined) ?? true;
      expression = isColor ? 'CIEL($T)' : '$T';
    } else {
      const lo = (args.lo as number | undefined) ?? 0;
      const hi = (args.hi as number | undefined) ?? 1;
      // Soft-ish band: 1 inside [lo,hi], 0 outside.
      expression = `iif($T >= ${lo} && $T <= ${hi}, 1, 0)`;
    }

    const res = await backend.send('run_process', 'PixelMath', {
      processId: 'PixelMath',
      settings: { expression, useSingleExpression: true, createNewImage: true, newImageId: maskId },
    });
    const out = toToolResult(res);
    if (!out.isError) out.content.push({ type: 'text', text: `Created ${mode} mask → ${maskId}` });
    return out;
  },
};

export const maskTools: ToolDef[] = [makeMask];
