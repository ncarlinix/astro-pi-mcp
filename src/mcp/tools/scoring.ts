import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { evaluationTools } from './evaluate.js';
import { qualityTools } from './quality.js';
import { pickCredible, type Candidate } from '../../scoring/score.js';

function findTool(list: ToolDef[], name: string): ToolDef {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`internal: tool "${name}" not found`);
  return t;
}
const textOf = (r: ToolResult): string => (r.content ?? []).map((c) => ('text' in c ? c.text : '')).join(' ');

export const pickBest: ToolDef = {
  name: 'pick_best',
  description:
    'Bracket-then-critic selector (Phase 4.4): given several candidate views (e.g. weak / target / ' +
    'edge / overdone variants of a stretch), score each with evaluate_image and gate each with ' +
    'check_burn + check_stars, then pick the "credible best" — the highest objective score with no ' +
    'core-burn or star-destruction failure. Reuses the existing scorers (no parallel scoring). ' +
    'Bracket *generation* is a separate, taste-calibrated step.',
  inputSchema: {
    views: z.array(z.string()).min(2).describe('Candidate view ids to compare'),
    minStars: z.number().int().positive().optional().describe('Star-gate minimum (default 50)'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const views = args.views as string[];
    const minStars = args.minStars as number | undefined;
    const evaluate = findTool(evaluationTools, 'evaluate_image');
    const checkBurn = findTool(qualityTools, 'check_burn');
    const checkStars = findTool(qualityTools, 'check_stars');

    const cands: Candidate[] = [];
    const detail: Array<Record<string, unknown>> = [];
    for (const view of views) {
      const ev = await evaluate.handler(backend, { view });
      let overall: number | null = null;
      try { overall = (JSON.parse(textOf(ev)) as { overallScore?: number }).overallScore ?? null; } catch { /* leave null */ }
      const burn = await checkBurn.handler(backend, { view });
      const burnPass = textOf(burn).startsWith('PASS');
      const stars = await checkStars.handler(backend, { view, ...(minStars ? { minStars } : {}) });
      const starsPass = textOf(stars).startsWith('PASS');
      cands.push({ label: view, overall, burnPass, starsPass });
      detail.push({ view, overall, burnPass, starsPass });
    }
    const pick = pickCredible(cands);
    return { content: [{ type: 'text', text: JSON.stringify({ winner: pick.label, reason: pick.reason, candidates: detail }, null, 2) }] };
  },
};

export const scoringTools: ToolDef[] = [pickBest];
