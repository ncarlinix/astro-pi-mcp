import { z } from 'zod';
import type { ToolDef } from './types.js';
import { toToolResult } from './util.js';
import { PALETTES, getPalette, type ChannelViews } from '../../palettes/index.js';

export const listPalettes: ToolDef = {
  name: 'list_palettes',
  description:
    'List available narrowband palettes (HOO, SHO, HOS, synthetic-SHO, …) with their required ' +
    'channels and whether they are scientific or artistic/synthetic.',
  inputSchema: {},
  handler: async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          PALETTES.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            requires: p.requires,
            scientificWhenReal: p.scientificWhenReal,
            synthetic: p.synthetic,
            note: p.note,
          })),
          null,
          2,
        ),
      },
    ],
  }),
};

export const applyPalette: ToolDef = {
  name: 'apply_palette',
  description:
    'Combine narrowband channels into a color image via a named palette using PixelMath ' +
    '(creates a new image). Provide the view ids for the required channels (ha/oiii/sii). ' +
    'Synthetic palettes are labelled and must not be presented as scientifically accurate.',
  inputSchema: {
    palette: z.string().describe('Palette id (see list_palettes)'),
    ha: z.string().optional().describe('Ha channel view id'),
    oiii: z.string().optional().describe('OIII channel view id'),
    sii: z.string().optional().describe('SII channel view id'),
    newImageId: z.string().optional().describe('Output image id (default "<palette>_result")'),
  },
  handler: async (backend, args) => {
    const palette = getPalette(args.palette as string);
    if (!palette) {
      return {
        content: [{ type: 'text', text: `Unknown palette "${String(args.palette)}". Use list_palettes.` }],
        isError: true,
      };
    }
    const ch: ChannelViews = {
      Ha: args.ha as string | undefined,
      OIII: args.oiii as string | undefined,
      SII: args.sii as string | undefined,
    };
    const missing = palette.requires.filter((l) => !ch[l]);
    if (missing.length) {
      return {
        content: [{ type: 'text', text: `Palette "${palette.id}" needs channel(s): ${missing.join(', ')}` }],
        isError: true,
      };
    }
    const expr = palette.build(ch);
    if (!expr) {
      return {
        content: [
          { type: 'text', text: `Palette "${palette.id}" has no built-in expression. ${palette.note ?? ''}`.trim() },
        ],
        isError: true,
      };
    }
    const newImageId = (args.newImageId as string | undefined) ?? `${palette.id}_result`;
    const res = await backend.send('run_process', 'PixelMath', {
      processId: 'PixelMath',
      settings: {
        expression: expr.R,
        expression1: expr.G,
        expression2: expr.B,
        useSingleExpression: false,
        createNewImage: true,
        newImageId,
      },
    });
    const out = toToolResult(res);
    if (!out.isError) {
      out.content.push({
        type: 'text',
        text:
          `Applied ${palette.name} → ${newImageId}. ` +
          (palette.synthetic
            ? 'ARTISTIC/synthetic palette — do not claim scientific accuracy.'
            : 'Scientific when channels are from real filters.'),
      });
    }
    return out;
  },
};

export const paletteTools: ToolDef[] = [listPalettes, applyPalette];
