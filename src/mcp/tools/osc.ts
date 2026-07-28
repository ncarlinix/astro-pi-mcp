import { z } from 'zod';
import type { ToolDef } from './types.js';
import { toToolResult, resolveViewId, noViewResult } from './util.js';
import { OSC_CAMERAS, duobandExtraction } from '../../astro/osc.js';

export const listOscCameras: ToolDef = {
  name: 'list_osc_cameras',
  description: 'List known one-shot-colour cameras with sensor, pixel size, and processing notes.',
  inputSchema: {},
  handler: async () => ({ content: [{ type: 'text', text: JSON.stringify(OSC_CAMERAS, null, 2) }] }),
};

export const extractDuoband: ToolDef = {
  name: 'extract_duoband',
  description:
    'Extract synthetic Ha and OIII mono images from a duoband OSC image (e.g. L-eXtreme, ' +
    'L-Ultimate) using PixelMath: Ha ≈ Red, OIII ≈ mean(Green, Blue). Creates two new views ' +
    '(<view>_Ha, <view>_OIII) ready for HOO/synthetic-SHO via apply_palette. Omit "view" for ' +
    'the active image. Synthetic SII would NOT be scientific — use apply_palette synthetic-SHO ' +
    'for an artistic SHO look only.',
  inputSchema: { view: z.string().optional() },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const ex = duobandExtraction(viewId);
    const haId = `${viewId}_Ha`;
    const oiiiId = `${viewId}_OIII`;

    // Image-generating PixelMath must executeOn a target view (global execution is refused by
    // PixInsight); the source view supplies geometry even though output goes to a new image.
    const haRes = await backend.send('run_process', 'PixelMath', {
      processId: 'PixelMath',
      settings: { expression: ex.Ha, useSingleExpression: true, createNewImage: true, newImageId: haId },
    }, { targetView: viewId });
    if (haRes.status === 'error') return toToolResult(haRes);

    const oiiiRes = await backend.send('run_process', 'PixelMath', {
      processId: 'PixelMath',
      settings: { expression: ex.OIII, useSingleExpression: true, createNewImage: true, newImageId: oiiiId },
    }, { targetView: viewId });
    if (oiiiRes.status === 'error') return toToolResult(oiiiRes);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ source: viewId, ha: haId, oiii: oiiiId, expressions: ex }, null, 2),
        },
        { type: 'text', text: `Extracted synthetic Ha (${haId}) and OIII (${oiiiId}). Next: apply_palette HOO ha=${haId} oiii=${oiiiId}.` },
      ],
    };
  },
};

export const oscTools: ToolDef[] = [listOscCameras, extractDuoband];
