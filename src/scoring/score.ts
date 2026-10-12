/**
 * Image scoring (Phase 4.4, objective backbone). Composes the measurements already produced by
 * analyze_image + the core-burn gate into 8 normalised 0–100 dimensions and a weighted overall.
 * This is the *measurable* half of bracket-then-critic: it quantifies an image. The subjective
 * half — generating weak/target/edge/overdone candidates and picking the "near-edge credible" one
 * — rides on top via the weights here, which the user calibrates to taste (the defaults are a
 * sensible, neutral starting point, NOT a fixed aesthetic).
 *
 * Pure and unit-testable. Every input is optional; a missing metric scores as null (excluded from
 * the overall) rather than guessing.
 */
export interface ScoreMetrics {
  burntFraction?: number | null;      // worst-block fraction above the burn threshold (0..1); 0 = clean
  starCount?: number | null;
  medianFWHM?: number | null;         // px
  medianEccentricity?: number | null; // 0 (round) .. 1
  snr?: number | null;                // median medianOverSigma
  neutralitySpreadPct?: number | null;// background colour spread %
  gradientPct?: number | null;        // worst gradient % of centre
  whiteClipPct?: number | null;       // saturated highlights %
  blackClipPct?: number | null;       // crushed shadows %
  backgroundLevel?: number | null;    // luminance median (0..1)
}

export interface DimensionScore { score: number | null; note: string; }
export interface ImageScore {
  dimensions: Record<string, DimensionScore>;
  overall: number | null;
  weights: Record<string, number>;
}

const clamp = (x: number) => Math.max(0, Math.min(100, x));
/** Linear score: value `good`→100, `bad`→0, clamped. Handles either direction. */
function ramp(v: number, good: number, bad: number): number {
  if (good === bad) return 50;
  return clamp(((v - bad) / (good - bad)) * 100);
}
/** Tent score: peaks at `ideal`, falls to 0 at ideal±`halfWidth`. For "a target band is best". */
function tent(v: number, ideal: number, halfWidth: number): number {
  return clamp(100 * (1 - Math.abs(v - ideal) / halfWidth));
}

export const DEFAULT_WEIGHTS: Record<string, number> = {
  coreBurn: 1.5, stars: 1.2, noise: 1.0, neutrality: 1.0,
  gradient: 1.0, highlights: 0.8, shadows: 0.8, backgroundLevel: 0.9,
};

export function scoreImage(m: ScoreMetrics, weights: Record<string, number> = DEFAULT_WEIGHTS): ImageScore {
  const dims: Record<string, DimensionScore> = {};
  const n = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

  const burn = n(m.burntFraction);
  dims.coreBurn = burn === null ? { score: null, note: 'no burn metric' }
    : { score: burn <= 0 ? 100 : clamp(100 - burn * 2500), note: `worst-block burnt fraction ${burn}` };

  const fwhm = n(m.medianFWHM), ecc = n(m.medianEccentricity), cnt = n(m.starCount);
  if (fwhm === null && cnt === null) dims.stars = { score: null, note: 'no star metrics' };
  else {
    const sFwhm = fwhm === null ? 100 : ramp(fwhm, 2.2, 7);          // tight 2.2px→100, bloated 7px→0
    const sEcc = ecc === null ? 100 : ramp(ecc, 0.35, 0.8);         // round→100, elongated→0
    const sCnt = cnt === null ? 100 : ramp(cnt, 300, 20);           // plenty→100, destroyed→0
    dims.stars = { score: clamp(0.45 * sFwhm + 0.25 * sEcc + 0.30 * sCnt), note: `FWHM ${fwhm ?? '?'} ecc ${ecc ?? '?'} count ${cnt ?? '?'}` };
  }

  const snr = n(m.snr);
  dims.noise = snr === null ? { score: null, note: 'no SNR' } : { score: ramp(snr, 120, 15), note: `median SNR ${snr}` };

  const spread = n(m.neutralitySpreadPct);
  dims.neutrality = spread === null ? { score: null, note: 'mono or no neutrality' } : { score: ramp(spread, 0.3, 4), note: `bg spread ${spread}%` };

  const grad = n(m.gradientPct);
  dims.gradient = grad === null ? { score: null, note: 'no gradient metric' } : { score: ramp(grad, 1, 20), note: `worst gradient ${grad}%` };

  const white = n(m.whiteClipPct);
  dims.highlights = white === null ? { score: null, note: 'no clip metric' } : { score: ramp(white, 0.02, 2), note: `saturated ${white}%` };

  const black = n(m.blackClipPct);
  dims.shadows = black === null ? { score: null, note: 'no clip metric' } : { score: ramp(black, 0.05, 5), note: `crushed ${black}%` };

  const bg = n(m.backgroundLevel);
  dims.backgroundLevel = bg === null ? { score: null, note: 'no background level' }
    : { score: tent(bg, 0.10, 0.09), note: `bg median ${bg} (ideal ~0.10)` };

  // Weighted overall across the dimensions that have a score.
  let wsum = 0, acc = 0;
  for (const [k, d] of Object.entries(dims)) {
    if (d.score === null) continue;
    const w = weights[k] ?? 1;
    acc += d.score * w; wsum += w;
  }
  const overall = wsum > 0 ? Math.round((acc / wsum) * 10) / 10 : null;
  return { dimensions: dims, overall, weights };
}

/** Pick the "near-edge credible" candidate: the highest overall among those with NO hard failure
 *  (coreBurn and stars above `floor`), i.e. push the look as far as it goes while staying clean.
 *  Returns the chosen index + why. Falls back to plain best overall if all fail the floor. */
export function pickCredible(scores: ImageScore[], floor = 55): { index: number; reason: string } {
  const ok = scores
    .map((s, i) => ({ i, s }))
    .filter(({ s }) => (s.dimensions.coreBurn?.score ?? 100) >= floor && (s.dimensions.stars?.score ?? 100) >= floor);
  const pool = ok.length ? ok : scores.map((s, i) => ({ i, s }));
  let best = pool[0]!;
  for (const c of pool) if ((c.s.overall ?? -1) > (best.s.overall ?? -1)) best = c;
  return { index: best.i, reason: ok.length ? `highest overall (${best.s.overall}) with no coreBurn/stars failure` : `all candidates below floor ${floor}; took best overall (${best.s.overall})` };
}
