import { z } from 'zod';
import type { ToolDef } from './types.js';
import { runScriptJson, resolveViewId, jsonResult, noViewResult } from './util.js';
import { noiseScript } from '../../pjsr/measure/noise.js';
import { gradientScript } from '../../pjsr/measure/gradient.js';
import { clippingScript } from '../../pjsr/measure/clipping.js';
import { starMetricsScript } from '../../pjsr/measure/stars.js';
import { KnowledgeBase } from '../../knowledge/index.js';

const kb = new KnowledgeBase();

interface Issue {
  aspect: string;
  score: number; // 0..10 (10 = excellent)
  finding: string;
  improve: string;
}

function num(x: unknown): number | null {
  const n = Number(x);
  return isFinite(n) ? n : null;
}

export const evaluateImage: ToolDef = {
  name: 'evaluate_image',
  description:
    'Critique an open view (Stage 15): scores gradient, clipping/saturation, stars ' +
    '(FWHM/eccentricity), and noise, with an overall 0–100 score and concrete improvement ' +
    'suggestions. Objective metrics only — pair with take_screenshot for aesthetic judgement. ' +
    'Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional(),
    skipStars: z.boolean().optional(),
  },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();

    const clip = await runScriptJson(backend, clippingScript(viewId, 200_000));
    const grad = await runScriptJson(backend, gradientScript(viewId, 5, 0.04));
    const noise = await runScriptJson(backend, noiseScript(viewId));
    const stars = args.skipStars ? null : await runScriptJson(backend, starMetricsScript(viewId, 150), 600_000);

    const issues: Issue[] = [];

    // Gradient
    if ('data' in grad) {
      const chans = (grad.data.channels as Array<{ cornerSpreadPctOfCenter?: unknown }>) ?? [];
      const worst = chans.reduce<number>((a, c) => Math.max(a, num(c.cornerSpreadPctOfCenter) ?? 0), 0);
      const score = worst < 3 ? 10 : worst < 10 ? 7 : worst < 25 ? 4 : 2;
      issues.push({
        aspect: 'gradient',
        score,
        finding: `worst corner-spread ${worst.toFixed(1)}% of center`,
        improve: worst < 3 ? 'None needed.' : 'Run DBE (or ABE degree 1) / gradient correction; MGC if plate-solved.',
      });
    }

    // Clipping / saturation
    if ('data' in clip) {
      const chans = (clip.data.channels as Array<{ clippedBlackPct?: unknown; saturatedWhitePct?: unknown }>) ?? [];
      const black = chans.reduce<number>((a, c) => Math.max(a, num(c.clippedBlackPct) ?? 0), 0);
      const white = chans.reduce<number>((a, c) => Math.max(a, num(c.saturatedWhitePct) ?? 0), 0);
      const score = black < 0.1 && white < 1 ? 10 : black < 1 && white < 5 ? 7 : 4;
      issues.push({
        aspect: 'clipping',
        score,
        finding: `black-clipped ${black.toFixed(2)}%, saturated ${white.toFixed(2)}% (worst channel)`,
        improve:
          black < 0.1 && white < 1
            ? 'None needed.'
            : black >= 1
              ? 'Black point too aggressive — back off the shadow clip in the stretch.'
              : 'Highlights clipping — protect stars/cores (HDRMT, masked stretch).',
      });
    }

    // Stars
    if (stars && 'data' in stars) {
      const ecc = num(stars.data.medianEccentricity);
      const fwhm = num(stars.data.medianFWHM);
      const score = ecc === null ? 6 : ecc < 0.5 ? 9 : ecc < 0.65 ? 6 : 3;
      issues.push({
        aspect: 'stars',
        score,
        finding: `median FWHM ${fwhm ?? '?'} px, eccentricity ${ecc ?? '?'} (moment-based)`,
        improve:
          ecc !== null && ecc >= 0.65
            ? 'Elongated stars — check guiding/tilt; BlurXTerminator can correct mild elongation.'
            : 'Stars round; optionally reduce with a star mask if oversized.',
      });
    }

    // Noise
    if ('data' in noise) {
      const chans = (noise.data.channels as Array<{ sigma?: unknown }>) ?? [];
      const worst = chans.reduce<number>((a, c) => Math.max(a, num(c.sigma) ?? 0), 0);
      const score = worst < 0.001 ? 9 : worst < 0.004 ? 7 : 5;
      issues.push({
        aspect: 'noise',
        score,
        finding: `worst-channel MRS sigma ${worst.toPrecision(3)}`,
        improve: worst < 0.001 ? 'Low noise.' : 'Consider NoiseXTerminator (linear) tuned to the measured sigma.',
      });
    }

    const overall = issues.length
      ? Math.round((issues.reduce((a, i) => a + i.score, 0) / (issues.length * 10)) * 100)
      : 0;

    const rubric = await kb.getDoc('CRITIC_RUBRIC');
    return jsonResult({
      viewId,
      overallScore: overall,
      issues: issues.sort((a, b) => a.score - b.score),
      rubricAvailable: !!rubric,
      note: 'Objective metric scores. For color balance, halos, and aesthetics, also take_screenshot and apply the critic rubric (get via explain / CRITIC_RUBRIC).',
    });
  },
};

export const evaluationTools: ToolDef[] = [evaluateImage];
