import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { runScriptJson } from './util.js';
import { renderScript, dimsScript, type StfMode } from '../../pjsr/render.js';

export const renderComparison: ToolDef = {
  name: 'render_comparison',
  description:
    'Render several open views (e.g. Natural / HOO / SHO / Foraxx interpretations) and return ' +
    'them as inline images for side-by-side comparison (Stage 16). Each is autostretched by ' +
    'default and downscaled to maxDim.',
  inputSchema: {
    views: z.array(z.string()).min(1).describe('View ids to render and compare'),
    stf: z.enum(['auto', 'asis', 'view']).optional().describe('Stretch mode (default auto)'),
    maxDim: z.number().int().positive().optional().describe('Max long-edge px per tile (default 768)'),
    quality: z.number().int().min(1).max(100).optional(),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const views = args.views as string[];
    const maxDim = (args.maxDim as number | undefined) ?? 768;
    const stf = (args.stf as StfMode) ?? 'auto';
    const content: ToolResult['content'] = [];
    let anyOk = false;

    for (const view of views) {
      // Downsample factor from dims.
      let ds = 1;
      const dims = await runScriptJson(backend, dimsScript(view));
      if ('data' in dims) {
        const w = Number(dims.data.width);
        const h = Number(dims.data.height);
        if (isFinite(w) && isFinite(h)) ds = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
      }
      const outPath = join(tmpdir(), `astropilot-cmp-${randomUUID()}.jpg`);
      const r = await runScriptJson(
        backend,
        renderScript(view, outPath, stf, undefined, ds, (args.quality as number | undefined) ?? 85),
      );
      if ('error' in r) {
        content.push({ type: 'text', text: `${view}: render failed — ${r.error}` });
        continue;
      }
      try {
        const data = await readFile(outPath);
        content.push({ type: 'text', text: `— ${view} —` });
        content.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' });
        anyOk = true;
      } catch (e) {
        content.push({ type: 'text', text: `${view}: rendered but unreadable (${String(e)})` });
      } finally {
        await unlink(outPath).catch(() => {});
      }
    }

    return { content, isError: !anyOk };
  },
};

export const compareTools: ToolDef[] = [renderComparison];
