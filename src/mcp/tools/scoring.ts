import type { ToolDef, ToolResult } from './types.js';
import { z } from 'zod';
import { resolveViewId, noViewResult } from './util.js';
import { analyzeTools } from './analyze.js';
import { qualityTools } from './quality.js';
import { scoreImage, type ScoreMetrics } from '../../scoring/score.js';

function findTool(list: ToolDef[], name: string): ToolDef {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`internal: tool "${name}" not found`);
  return t;
}
const textOf = (r: ToolResult): string => (r.content ?? []).map((c) => ('text' in c ? c.text : '')).join(' ');

export const scoreImageTool: ToolDef = {
  name: 'score_image',
  description:
    'Score an open view on 8 objective dimensions (0–100) and a weighted overall (Phase 4.4 ' +
    'backbone): core-burn, stars, noise/SNR, background neutrality, gradient, highlights, shadows, ' +
    'background level. Composes analyze_image + the core-burn gate. This quantifies an image; the ' +
    'bracket-generate + "near-edge credible" selection on top is a separate, taste-calibrated step. ' +
    'Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();

    const analyze = findTool(analyzeTools, 'analyze_image');
    const checkBurn = findTool(qualityTools, 'check_burn');

    const az = await analyze.handler(backend, { view: viewId, verbose: false });
    let report: Record<string, unknown> = {};
    try { report = (JSON.parse(textOf(az)) as { report?: Record<string, unknown> }).report ?? {}; } catch { /* leave empty */ }

    const burnRes = await checkBurn.handler(backend, { view: viewId });
    let burntFraction: number | null = null;
    try {
      const m = /"worstBlockFraction":\s*([0-9.]+)/.exec(textOf(burnRes));
      if (m) burntFraction = parseFloat(m[1]!);
    } catch { /* leave null */ }

    const snrArr = (report.snrByChannel as Array<{ medianOverSigma?: number; saturatedWhitePct?: number; clippedBlackPct?: number }> | undefined) ?? [];
    const med = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
    const snr = med(snrArr.map((c) => c.medianOverSigma).filter((x): x is number => typeof x === 'number'));
    const whiteClipPct = snrArr.length ? Math.max(...snrArr.map((c) => c.saturatedWhitePct ?? 0)) : null;
    const blackClipPct = snrArr.length ? Math.max(...snrArr.map((c) => c.clippedBlackPct ?? 0)) : null;
    const stars = (report.stars as { medianFWHM?: number; medianEccentricity?: number; starCount?: number } | null) ?? null;
    const neutrality = (report.neutrality as { spreadPct?: number } | null) ?? null;
    const gradient = (report.gradient as { worstGradientPctOfCenter?: number } | undefined) ?? undefined;
    const classification = (report.classification as { luminanceMedian?: number } | undefined) ?? undefined;

    const metrics: ScoreMetrics = {
      burntFraction,
      starCount: stars?.starCount ?? null,
      medianFWHM: stars?.medianFWHM ?? null,
      medianEccentricity: stars?.medianEccentricity ?? null,
      snr,
      neutralitySpreadPct: neutrality?.spreadPct ?? null,
      gradientPct: gradient?.worstGradientPctOfCenter ?? null,
      whiteClipPct,
      blackClipPct,
      backgroundLevel: classification?.luminanceMedian ?? null,
    };
    const scored = scoreImage(metrics);
    return { content: [{ type: 'text', text: JSON.stringify({ view: viewId, overall: scored.overall, dimensions: scored.dimensions, metrics }, null, 2) }] };
  },
};

export const scoringTools: ToolDef[] = [scoreImageTool];
