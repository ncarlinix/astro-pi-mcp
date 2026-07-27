import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { toToolResult, jsonResult } from './util.js';
import type { ProcessingBackend } from '../../backend/types.js';
import type { BridgeResult } from '../../types.js';
import { renderScript, dimsScript, type StfMode } from '../../pjsr/render.js';
import { metadataScript } from '../../pjsr/measure/metadata.js';
import { parseRa, parseDec } from '../../astro/ephemeris.js';
import { detectAstap, detectAstapDb, solveWithAstap, type SolveHints } from '../../astro/astap.js';

const STF = ['auto', 'asis', 'view'] as const;

/** Parse the JSON returnValue a run_script render/dims call produced. */
function scriptJson(res: BridgeResult): Record<string, unknown> | { error: string } {
  if (res.status === 'error') return { error: res.error?.message ?? 'script failed' };
  const raw = (res.outputs as { returnValue?: unknown } | undefined)?.returnValue;
  if (typeof raw !== 'string') return { error: 'watcher returned no value' };
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: `unparseable script output: ${raw.slice(0, 200)}` };
  }
}

/** Resolve a view id, falling back to the active image when none is given. */
async function resolveViewId(
  backend: ProcessingBackend,
  view: string | undefined,
): Promise<string | null> {
  if (view) return view;
  const res = await backend.send('active_image', '__internal__', {});
  const id = (res.outputs as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

/** Compute an integer downsample factor so max(width,height) ≤ maxDim. */
async function downsampleFor(
  backend: ProcessingBackend,
  viewId: string,
  maxDim: number | undefined,
): Promise<number> {
  if (!maxDim || maxDim <= 0) return 1;
  const dims = scriptJson(await backend.send('run_script', '__script__', { code: dimsScript(viewId) }));
  const w = Number((dims as { width?: unknown }).width);
  const h = Number((dims as { height?: unknown }).height);
  if (!isFinite(w) || !isFinite(h)) return 1;
  return Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
}

export const imageStatistics: ToolDef = {
  name: 'image_statistics',
  description:
    'Per-channel statistics (mean, median, stdDev, min, max) for an open view. Omit "view" ' +
    'to use the active image.',
  inputSchema: { view: z.string().optional().describe('View id; omit for the active image') },
  handler: async (backend, args) => {
    const res = await backend.send('get_image_statistics', '__internal__', { viewId: args.view });
    return toToolResult(res);
  },
};

export const takeScreenshot: ToolDef = {
  name: 'take_screenshot',
  description:
    'Render an open view to an image and return it inline (base64 JPEG) for visual ' +
    'inspection. Downscaled to maxDim (default 1024). stf: "auto" autostretches linear ' +
    'data (default), "view" applies the view\'s STF, "asis" renders raw. Omit "view" for ' +
    'the active image.',
  inputSchema: {
    view: z.string().optional(),
    stf: z.enum(STF).optional().describe('Stretch mode (default auto)'),
    maxDim: z.number().int().positive().optional().describe('Max long-edge px (default 1024)'),
    quality: z.number().int().min(1).max(100).optional().describe('JPEG quality (default 90)'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) {
      return { content: [{ type: 'text', text: 'No view specified and no active image.' }], isError: true };
    }
    const maxDim = (args.maxDim as number | undefined) ?? 1024;
    const ds = await downsampleFor(backend, viewId, maxDim);
    const outPath = join(tmpdir(), `astropilot-shot-${randomUUID()}.jpg`);
    const code = renderScript(viewId, outPath, (args.stf as StfMode) ?? 'auto', undefined, ds, (args.quality as number | undefined) ?? 90);
    const out = scriptJson(await backend.send('run_script', '__script__', { code }));
    if ('error' in out) {
      return { content: [{ type: 'text', text: `Render failed: ${String(out.error)}` }], isError: true };
    }
    try {
      const data = await readFile(outPath);
      return {
        content: [
          { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' },
          { type: 'text', text: `${viewId} — ${JSON.stringify(out)}` },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Rendered but could not read ${outPath}: ${String(e)}` }], isError: true };
    } finally {
      await unlink(outPath).catch(() => {});
    }
  },
};

export const exportPreview: ToolDef = {
  name: 'export_preview',
  description:
    'Render an open view to a file on disk (PNG/JPEG by extension) and return its path. ' +
    'Downscaled to maxDim when given. Omit "view" for the active image.',
  inputSchema: {
    path: z.string().describe('Absolute output path; extension selects PNG/JPEG'),
    view: z.string().optional(),
    stf: z.enum(STF).optional().describe('Stretch mode (default auto)'),
    maxDim: z.number().int().positive().optional().describe('Max long-edge px'),
    quality: z.number().int().min(1).max(100).optional(),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) {
      return { content: [{ type: 'text', text: 'No view specified and no active image.' }], isError: true };
    }
    const ds = await downsampleFor(backend, viewId, args.maxDim as number | undefined);
    const code = renderScript(viewId, args.path as string, (args.stf as StfMode) ?? 'auto', undefined, ds, args.quality as number | undefined);
    const out = scriptJson(await backend.send('run_script', '__script__', { code }));
    if ('error' in out) {
      return { content: [{ type: 'text', text: `Render failed: ${String(out.error)}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  },
};

const ASTAP_INSTALL_HELP =
  'ASTAP not found. Install the ASTAP CLI and a star database (e.g. D50 for wide fields, ' +
  'or H17/H18 for narrow), then retry. macOS default: /Applications/ASTAP.app/Contents/' +
  'MacOS/astap. Override with ASTROPILOT_ASTAP_PATH. Download: https://www.hnsky.org/astap.htm';

export const plateSolve: ToolDef = {
  name: 'plate_solve',
  description:
    'Plate-solve an open view with ASTAP (external solver): saves the view to a temp FITS, ' +
    'runs ASTAP with header hints from the image, writes the WCS back, and re-opens the ' +
    'solved file so SPCC/SPFC/MGC can use the astrometric solution. Requires ASTAP + a star ' +
    'database installed. Omit "view" for the active image; RA/Dec/focalLength/pixelSize ' +
    'override the header hints.',
  inputSchema: {
    view: z.string().optional(),
    ra: z.union([z.string(), z.number()]).optional().describe('RA hint (sexagesimal or deg)'),
    dec: z.union([z.string(), z.number()]).optional().describe('Dec hint (sexagesimal or deg)'),
    focalLength: z.number().optional().describe('Focal length hint (mm)'),
    pixelSize: z.number().optional().describe('Pixel size hint (µm)'),
    reopen: z.boolean().optional().describe('Re-open the solved FITS to import WCS (default true)'),
    force: z.boolean().optional().describe('Re-solve even if the view already has a WCS'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) {
      return { content: [{ type: 'text', text: 'No view specified and no active image.' }], isError: true };
    }

    // Read metadata first — it carries the astrometry status and the solve hints.
    const meta = scriptJson(await backend.send('run_script', '__script__', { code: metadataScript(viewId) }));
    const m = ('error' in meta ? {} : meta) as Record<string, unknown>;
    const metadata = (m.metadata ?? {}) as Record<string, unknown>;
    const geometry = (m.geometry ?? {}) as Record<string, unknown>;
    const astrometry = (m.astrometry ?? {}) as Record<string, unknown>;

    // Short-circuit: a view that already carries a real WCS needs no solving.
    if (astrometry.solved === true && args.force !== true) {
      return jsonResult({
        solved: true,
        solver: 'existing-wcs',
        solvedViewId: viewId,
        astrometry,
        note: 'View already has an astrometric solution — ASTAP skipped. SPCC/SPFC/MGC can use it directly. Pass force=true to re-solve.',
      });
    }

    const astapPath = detectAstap();
    if (!astapPath) {
      return { content: [{ type: 'text', text: ASTAP_INSTALL_HELP }], isError: true };
    }

    const raInput = (args.ra as string | number | undefined) ?? (metadata.ra as string | undefined);
    const decInput = (args.dec as string | number | undefined) ?? (metadata.dec as string | undefined);
    const raDeg = raInput != null ? parseRa(raInput) : null;
    const decDeg = decInput != null ? parseDec(decInput) : null;

    const height = Number(geometry.height) || 0;
    const focalLength = (args.focalLength as number | undefined) ?? (metadata.focalLengthMm as number | undefined);
    const pixelSize = (args.pixelSize as number | undefined) ?? (metadata.pixelSizeUm as number | undefined);
    let scaleArcsec = metadata.imageScaleArcsecPerPx as number | undefined;
    if ((!scaleArcsec || scaleArcsec <= 0) && focalLength && pixelSize) {
      scaleArcsec = (206.265 * pixelSize) / focalLength;
    }
    const fovDeg = scaleArcsec && height ? (scaleArcsec * height) / 3600 : undefined;

    const hints: SolveHints = {};
    if (raDeg != null && decDeg != null) {
      hints.raHours = raDeg / 15;
      hints.decDeg = decDeg;
    }
    if (fovDeg) hints.fovDeg = fovDeg;

    // Save to a temp FITS (ASTAP reads FITS; the -update run writes WCS back into it).
    const fits = join(tmpdir(), `astropilot-solve-${randomUUID()}.fit`);
    const save = await backend.send('save_image', '__internal__', { viewId, filePath: fits, overwrite: true });
    if (save.status === 'error') return toToolResult(save);

    const dbPath = detectAstapDb();
    const result = await solveWithAstap({ astapPath, fitsPath: fits, hints, dbPath: dbPath ?? undefined });
    if (!result.solved) {
      const dbHint = dbPath
        ? ` (star DB: ${dbPath})`
        : ' No star database auto-detected — set ASTROPILOT_ASTAP_DB to your database folder (e.g. the d50_star_database dir) or configure it in ASTAP.';
      return {
        content: [{ type: 'text', text: `Plate solve failed: ${result.error ?? 'unknown'}.${dbHint} Hints used: ${JSON.stringify(hints)}` }],
        isError: true,
      };
    }

    // Re-open the WCS-updated FITS so PixInsight builds the astrometric solution for SPCC.
    let solvedViewId = viewId;
    if (args.reopen !== false) {
      const opened = await backend.send('open_image', '__internal__', { filePath: fits });
      const id = (opened.outputs as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') solvedViewId = id;
    }

    return jsonResult({
      solved: true,
      solver: 'astap',
      raDeg: result.raDeg,
      decDeg: result.decDeg,
      scaleArcsecPerPx: result.scaleArcsecPerPx,
      rotationDeg: result.rotationDeg,
      solvedViewId,
      hints,
      note:
        args.reopen === false
          ? 'WCS written into the temp FITS; not re-opened.'
          : `WCS imported into "${solvedViewId}". Run SPCC/SPFC/MGC on that view (they read the astrometric solution).`,
    });
  },
};

export const analysisTools: ToolDef[] = [
  imageStatistics,
  takeScreenshot,
  exportPreview,
  plateSolve,
];
