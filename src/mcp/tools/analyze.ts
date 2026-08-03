import { z } from 'zod';
import type { ToolDef } from './types.js';
import type { ProcessingBackend } from '../../backend/types.js';
import { runScriptJson, resolveViewId, jsonResult, noViewResult, type ScriptJson } from './util.js';
import { noiseScript } from '../../pjsr/measure/noise.js';
import { gradientScript } from '../../pjsr/measure/gradient.js';
import { neutralityScript } from '../../pjsr/measure/neutrality.js';
import { starMetricsScript } from '../../pjsr/measure/stars.js';
import { clippingScript } from '../../pjsr/measure/clipping.js';
import { metadataScript } from '../../pjsr/measure/metadata.js';

/** Return parsed data or undefined (recording the error text) for a probe result. */
function data(r: ScriptJson, errors: Record<string, string>, key: string): Record<string, unknown> | undefined {
  if ('error' in r) {
    errors[key] = r.error;
    return undefined;
  }
  return r.data;
}

function num(x: unknown): number | null {
  const n = Number(x);
  return isFinite(n) ? n : null;
}

interface ChannelClip {
  name?: string;
  p50?: unknown;
  min?: unknown;
  max?: unknown;
  clippedBlackPct?: unknown;
  saturatedWhitePct?: unknown;
}

/** Classify linear vs nonlinear from the luminance median (channel p50 average). */
function classifyLinearity(lumMedian: number | null): { linear: boolean | null; label: string; confidence: string } {
  if (lumMedian === null) return { linear: null, label: 'unknown', confidence: 'none' };
  if (lumMedian < 0.08) return { linear: true, label: 'linear', confidence: lumMedian < 0.04 ? 'high' : 'medium' };
  if (lumMedian > 0.2) return { linear: false, label: 'nonlinear (stretched)', confidence: lumMedian > 0.3 ? 'high' : 'medium' };
  return { linear: null, label: 'ambiguous (weakly stretched or bright field)', confidence: 'low' };
}

// Thresholds apply to a LINEAR-domain gradient signal (% of center). A stretch compresses the
// background toward black and amplifies small ramps ~10x, so a linear gradient of only ~1-2%
// becomes a prominent visible gradient after stretching. The "negligible" bar is therefore
// deliberately tight — anything above it should get GradientCorrection/ABE before SPCC.
function gradientLabel(pct: number | null): string {
  if (pct === null) return 'unknown';
  if (pct < 0.8) return 'none/negligible';
  if (pct < 2.5) return 'mild';
  if (pct < 6) return 'moderate';
  return 'strong';
}

export const analyzeImage: ToolDef = {
  name: 'analyze_image',
  description:
    'Comprehensive automatic understanding of an open view: linear vs nonlinear, per-channel ' +
    'noise (MRS sigma) and SNR, dynamic range, clipping/saturation, background gradient ' +
    'severity, color balance & neutrality (color), star count/density/FWHM/eccentricity, ' +
    'image scale, and acquisition metadata. Composes the measurement probes into one report ' +
    'plus a short natural-language summary. Omit "view" for the active image. Set ' +
    'skipStars=true to skip the (slower) star scan.',
  inputSchema: {
    view: z.string().optional(),
    skipStars: z.boolean().optional().describe('Skip the star-detection scan (faster)'),
    maxStars: z.number().int().min(10).max(1000).optional().describe('Brightest stars to measure (default 150)'),
  },
  handler: async (backend: ProcessingBackend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();

    const errors: Record<string, string> = {};

    // Bridge is serial; run probes in sequence.
    const meta = data(await runScriptJson(backend, metadataScript(viewId)), errors, 'metadata');
    const clip = data(await runScriptJson(backend, clippingScript(viewId, 200_000)), errors, 'clipping');
    const noise = data(await runScriptJson(backend, noiseScript(viewId)), errors, 'noise');
    const gradient = data(
      await runScriptJson(backend, gradientScript(viewId, 5, 0.04)),
      errors,
      'gradient',
    );

    const geometry = (meta?.geometry ?? {}) as Record<string, unknown>;
    const isColor = geometry.isColor === true;

    let neutrality: Record<string, unknown> | undefined;
    if (isColor) {
      neutrality = data(
        await runScriptJson(backend, neutralityScript(viewId, 'linear', 'R', 150_000)),
        errors,
        'neutrality',
      );
    }

    let stars: Record<string, unknown> | undefined;
    if (!args.skipStars) {
      stars = data(
        await runScriptJson(backend, starMetricsScript(viewId, (args.maxStars as number) ?? 150), 600_000),
        errors,
        'stars',
      );
    }

    // --- Derive the understanding ---
    const clipChannels = (clip?.channels as ChannelClip[] | undefined) ?? [];
    const noiseChannels = (noise?.channels as Array<{ name?: string; sigma?: unknown }> | undefined) ?? [];

    const medians = clipChannels.map((c) => num(c.p50)).filter((x): x is number => x !== null);
    const lumMedian = medians.length ? medians.reduce((a, b) => a + b, 0) / medians.length : null;
    const linearity = classifyLinearity(lumMedian);

    // Per-channel SNR ≈ median / sigma (background-signal-limited proxy).
    const snr = clipChannels.map((c, i) => {
      const sigma = num(noiseChannels[i]?.sigma);
      const med = num(c.p50);
      const max = num(c.max);
      return {
        channel: c.name ?? `C${i}`,
        sigma,
        medianOverSigma: sigma && med !== null && sigma > 0 ? Number((med / sigma).toPrecision(4)) : null,
        dynamicRangeStops: sigma && max !== null && sigma > 0 ? Number(Math.log2(max / sigma).toPrecision(4)) : null,
        clippedBlackPct: num(c.clippedBlackPct),
        saturatedWhitePct: num(c.saturatedWhitePct),
      };
    });

    // Gradient severity = worst per-channel linear-gradient signal, taken as the LARGER of the
    // least-squares plane amplitude and the corner spread. Plane amplitude catches a smooth
    // ramp (e.g. left→right) that corner-spread can under-report; corner spread catches
    // localized/irregular gradients the plane fit averages out. Measured on linear data.
    const gradChannels =
      (gradient?.channels as
        | Array<{ cornerSpreadPctOfCenter?: unknown; planeAmplitudePctOfCenter?: unknown }>
        | undefined) ?? [];
    const worstCornerSpread = gradChannels.reduce<number | null>((acc, c) => {
      const p = num(c.cornerSpreadPctOfCenter);
      return p === null ? acc : acc === null ? p : Math.max(acc, p);
    }, null);
    const worstPlaneAmplitude = gradChannels.reduce<number | null>((acc, c) => {
      const p = num(c.planeAmplitudePctOfCenter);
      return p === null ? acc : acc === null ? p : Math.max(acc, p);
    }, null);
    const worstGradient =
      worstCornerSpread === null
        ? worstPlaneAmplitude
        : worstPlaneAmplitude === null
          ? worstCornerSpread
          : Math.max(worstCornerSpread, worstPlaneAmplitude);

    // Color balance: R:G:B median ratios normalised to G.
    let colorBalance: Record<string, number | null> | null = null;
    if (isColor && clipChannels.length >= 3) {
      const g = num(clipChannels[1]?.p50);
      colorBalance = {
        rOverG: g && g > 0 ? Number((num(clipChannels[0]?.p50)! / g).toPrecision(4)) : null,
        bOverG: g && g > 0 ? Number((num(clipChannels[2]?.p50)! / g).toPrecision(4)) : null,
      };
    }

    const w = num(geometry.width) ?? 0;
    const h = num(geometry.height) ?? 0;
    const megapixels = (w * h) / 1e6;
    const starCount = num(stars?.starCount);
    const starDensity = starCount !== null && megapixels > 0 ? Number((starCount / megapixels).toPrecision(4)) : null;
    const imageScale = num((meta?.metadata as { imageScaleArcsecPerPx?: unknown } | undefined)?.imageScaleArcsecPerPx);

    const report = {
      viewId,
      geometry,
      classification: {
        ...linearity,
        luminanceMedian: lumMedian,
      },
      snrByChannel: snr,
      gradient: {
        worstGradientPctOfCenter: worstGradient,
        worstCornerSpreadPctOfCenter: worstCornerSpread,
        worstPlaneAmplitudePctOfCenter: worstPlaneAmplitude,
        severity: gradientLabel(worstGradient),
        note: 'linear-domain; stretching amplifies gradients ~10x. Anything above "none/negligible" → run GradientCorrection/ABE before SPCC.',
      },
      colorBalance,
      neutrality: neutrality
        ? { spreadPct: num(neutrality.spreadPct), neutral: num(neutrality.spreadPct) !== null ? num(neutrality.spreadPct)! <= 1 : null }
        : null,
      stars: stars
        ? {
            starCount,
            starDensityPerMpx: starDensity,
            medianFWHM: num(stars.medianFWHM),
            medianEccentricity: num(stars.medianEccentricity),
          }
        : null,
      imageScaleArcsecPerPx: imageScale,
      metadata: meta?.metadata ?? null,
      probeErrors: Object.keys(errors).length ? errors : undefined,
    };

    // Short natural-language summary, built from the typed locals.
    const summaryParts: string[] = [
      `${w || '?'}×${h || '?'} ${isColor ? 'color' : 'mono'} image; ${linearity.label}.`,
    ];
    if (stars) {
      summaryParts.push(
        `~${starCount ?? '?'} stars (${starDensity ?? '?'}/Mpx), median FWHM ${num(stars.medianFWHM) ?? '?'} px, ` +
          `eccentricity ${num(stars.medianEccentricity) ?? '?'}.`,
      );
    }
    summaryParts.push(`Gradient: ${gradientLabel(worstGradient)}.`);
    if (neutrality) {
      const spread = num(neutrality.spreadPct);
      if (spread !== null) summaryParts.push(`Background ${spread <= 1 ? 'neutral' : 'color-biased'} (spread ${spread}%).`);
    }
    if (imageScale) summaryParts.push(`Image scale ${imageScale}"/px.`);
    if (snr.some((c) => (c.saturatedWhitePct ?? 0) > 1)) {
      summaryParts.push('Note: >1% saturated pixels in at least one channel.');
    }

    return jsonResult({ summary: summaryParts.join(' '), report });
  },
};

export const analyzeTools: ToolDef[] = [analyzeImage];
