/**
 * Candidate selection for bracket-then-critic (Phase 4.4). The objective *scoring* lives in the
 * existing evaluate_image tool (gradient/clipping/stars/noise → 0–100); this module adds only the
 * part evaluate_image doesn't have: picking the "near-edge credible" candidate from a bracket —
 * the most-pushed look that still passes the hard gates (core-burn, star integrity).
 *
 * Pure and unit-testable.
 */
export interface Candidate {
  label: string;
  overall: number | null; // evaluate_image overallScore
  burnPass: boolean;       // check_burn verdict
  starsPass: boolean;      // check_stars verdict
}

export interface Pick {
  index: number;
  label: string;
  reason: string;
}

/**
 * Pick the credible best: highest overall among candidates that fail NO hard gate (coreBurn,
 * stars). If every candidate trips a gate, fall back to the plain best overall and say so.
 * This is "best credible"; true "push as far as credible allows" needs a boldness signal the
 * user defines — the floor/weights are the knobs to calibrate to taste.
 */
export function pickCredible(cands: Candidate[]): Pick {
  if (!cands.length) return { index: -1, label: '', reason: 'no candidates' };
  const ok = cands.map((c, i) => ({ c, i })).filter(({ c }) => c.burnPass && c.starsPass);
  const pool = ok.length ? ok : cands.map((c, i) => ({ c, i }));
  let best = pool[0]!;
  for (const p of pool) if ((p.c.overall ?? -1) > (best.c.overall ?? -1)) best = p;
  return {
    index: best.i,
    label: best.c.label,
    reason: ok.length
      ? `best overall (${best.c.overall}) among ${ok.length} candidate(s) with no core-burn/star failure`
      : `all ${cands.length} candidates failed a hard gate; took best overall (${best.c.overall})`,
  };
}
