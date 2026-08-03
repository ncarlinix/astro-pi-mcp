import { z } from 'zod';
import type { ToolDef } from './types.js';
import { runScriptJson, resolveViewId, jsonResult, noViewResult } from './util.js';
import { noiseScript } from '../../pjsr/measure/noise.js';
import { gradientScript } from '../../pjsr/measure/gradient.js';
import { neutralityScript } from '../../pjsr/measure/neutrality.js';
import { starMetricsScript } from '../../pjsr/measure/stars.js';
import { clippingScript } from '../../pjsr/measure/clipping.js';
import { metadataScript } from '../../pjsr/measure/metadata.js';

const STAR_TIMEOUT_MS = 600_000; // star detection scans the whole frame.

export const getNoise: ToolDef = {
  name: 'get_noise',
  description:
    'Per-channel MRS noise estimate (sigma) for an open view. ALWAYS use this rather than ' +
    'stdDev to gauge noise/denoising — stdDev is signal-dominated on astro images. Omit ' +
    '"view" for the active image.',
  inputSchema: { view: z.string().optional() },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const r = await runScriptJson(backend, noiseScript(viewId));
    return 'error' in r ? { content: [{ type: 'text', text: r.error }], isError: true } : jsonResult(r.data);
  },
};

export const getBackgroundGradient: ToolDef = {
  name: 'get_background_gradient',
  description:
    'Background map: per-channel medians over a gridSize×gridSize grid of star-robust boxes ' +
    '+ corner spread + least-squares plane fit. Corner spread is the gradient-severity ' +
    'signal (drops after correction). Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional(),
    gridSize: z.number().int().min(2).max(9).optional().describe('Grid is N×N boxes (default 5)'),
    boxFraction: z.number().min(0.01).max(0.2).optional().describe('Box side as image fraction (default 0.04)'),
  },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const r = await runScriptJson(
      backend,
      gradientScript(viewId, (args.gridSize as number) ?? 5, (args.boxFraction as number) ?? 0.04),
    );
    return 'error' in r ? { content: [{ type: 'text', text: r.error }], isError: true } : jsonResult(r.data);
  },
};

export const getBackgroundNeutrality: ToolDef = {
  name: 'get_background_neutrality',
  description:
    'Background color-neutrality (color images only). mode:"linear" (pre-stretch): spreadPct ' +
    '≤1 = neutral. mode:"poststretch": bgChroma + faint/bright signal medians. signalChannel ' +
    'is the dominant emission hue (default R). Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional(),
    mode: z.enum(['linear', 'poststretch']).describe('linear = pre-stretch gate; poststretch = after stretching'),
    signalChannel: z.enum(['R', 'G', 'B']).optional().describe('Dominant hue channel (default R)'),
    targetSamples: z.number().int().min(10000).max(1000000).optional().describe('Approx. samples (default 150000)'),
  },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const r = await runScriptJson(
      backend,
      neutralityScript(
        viewId,
        args.mode as 'linear' | 'poststretch',
        (args.signalChannel as 'R' | 'G' | 'B') ?? 'R',
        (args.targetSamples as number) ?? 150_000,
      ),
    );
    return 'error' in r ? { content: [{ type: 'text', text: r.error }], isError: true } : jsonResult(r.data);
  },
};

export const getStarMetrics: ToolDef = {
  name: 'get_star_metrics',
  description:
    'Star metrics: approximate star count, median FWHM (px) + eccentricity of the brightest ' +
    'stars (moment-based, comparison-stable NOT photometric — ~2.3× a PSF-fit FWHM), and ' +
    'brightest-star coordinates. Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional(),
    maxStars: z.number().int().min(10).max(1000).optional().describe('Brightest stars to measure (default 200)'),
  },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const r = await runScriptJson(backend, starMetricsScript(viewId, (args.maxStars as number) ?? 200), STAR_TIMEOUT_MS);
    return 'error' in r ? { content: [{ type: 'text', text: r.error }], isError: true } : jsonResult(r.data);
  },
};

export const getClipping: ToolDef = {
  name: 'get_clipping',
  description:
    'Per-channel clipped-black / saturated-white fractions and coarse percentiles (exact ' +
    'min/max). Use to detect black/white clipping. Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional(),
    targetSamples: z.number().int().min(10000).max(1000000).optional().describe('Approx. samples (default 200000)'),
  },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const r = await runScriptJson(backend, clippingScript(viewId, (args.targetSamples as number) ?? 200_000));
    return 'error' in r ? { content: [{ type: 'text', text: r.error }], isError: true } : jsonResult(r.data);
  },
};

export const getMetadata: ToolDef = {
  name: 'get_metadata',
  description:
    'Read FITS/XISF header keywords: camera, telescope, filter, gain, offset, exposure, ' +
    'pixel size, focal length, and the derived image scale (arcsec/px). Omit "view" for the ' +
    'active image.',
  inputSchema: { view: z.string().optional() },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const r = await runScriptJson(backend, metadataScript(viewId));
    return 'error' in r ? { content: [{ type: 'text', text: r.error }], isError: true } : jsonResult(r.data);
  },
};

export const measurementTools: ToolDef[] = [
  getNoise,
  getBackgroundGradient,
  getBackgroundNeutrality,
  getStarMetrics,
  getClipping,
  getMetadata,
];
