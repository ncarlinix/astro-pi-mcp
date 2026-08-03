/**
 * Narrowband palette registry (Stage 10). Palettes here are CHANNEL ROUTINGS (which
 * emission line drives which output channel) — standard, not fabricated numeric recipes.
 * Artistic/dynamic palettes (Foraxx, Gold, …) whose published PixelMath uses specific
 * coefficients are intentionally NOT hard-coded (never fabricate expressions); they carry
 * a knowledge-base pointer instead.
 *
 * Scientific integrity: `scientificWhenReal` marks palettes that are physically meaningful
 * when the channels come from real filters. `synthetic` marks palettes that reassign or
 * invent a channel (e.g. synthetic SII) — never claimed as scientifically accurate.
 */
export type Line = 'Ha' | 'OIII' | 'SII';

export interface ChannelViews {
  Ha?: string;
  OIII?: string;
  SII?: string;
}

export interface PaletteExpr {
  R: string;
  G: string;
  B: string;
}

export interface Palette {
  id: string;
  name: string;
  description: string;
  requires: Line[];
  scientificWhenReal: boolean;
  synthetic: boolean;
  /** Build per-channel PixelMath expressions, or null if the palette needs a KB recipe. */
  build: (ch: ChannelViews) => PaletteExpr | null;
  note?: string;
}

const has = (ch: ChannelViews, lines: Line[]): boolean => lines.every((l) => !!ch[l]);

export const PALETTES: Palette[] = [
  {
    id: 'HOO',
    name: 'HOO (natural narrowband)',
    description: 'Ha → red, OIII → green & blue. The natural duoband palette.',
    requires: ['Ha', 'OIII'],
    scientificWhenReal: true,
    synthetic: false,
    build: (ch) => (has(ch, ['Ha', 'OIII']) ? { R: ch.Ha!, G: ch.OIII!, B: ch.OIII! } : null),
  },
  {
    id: 'SHO',
    name: 'SHO (Hubble palette)',
    description: 'SII → red, Ha → green, OIII → blue. Requires real SII for scientific use.',
    requires: ['Ha', 'OIII', 'SII'],
    scientificWhenReal: true,
    synthetic: false,
    build: (ch) =>
      has(ch, ['Ha', 'OIII', 'SII']) ? { R: ch.SII!, G: ch.Ha!, B: ch.OIII! } : null,
  },
  {
    id: 'HOS',
    name: 'HOS',
    description: 'Ha → red, OIII → green, SII → blue.',
    requires: ['Ha', 'OIII', 'SII'],
    scientificWhenReal: true,
    synthetic: false,
    build: (ch) =>
      has(ch, ['Ha', 'OIII', 'SII']) ? { R: ch.Ha!, G: ch.OIII!, B: ch.SII! } : null,
  },
  {
    id: 'synthetic-SHO',
    name: 'Synthetic SHO (artistic)',
    description:
      'SHO-style look from duoband data with NO real SII: Ha drives red as a pseudo-SII. ' +
      'ARTISTIC ONLY — the red channel is not real SII and must never be presented as ' +
      'scientifically accurate.',
    requires: ['Ha', 'OIII'],
    scientificWhenReal: false,
    synthetic: true,
    build: (ch) => (has(ch, ['Ha', 'OIII']) ? { R: ch.Ha!, G: ch.Ha!, B: ch.OIII! } : null),
    note: 'Synthetic SII (= Ha). Label outputs clearly as artistic; do not claim SII data.',
  },
  {
    id: 'foraxx',
    name: 'Foraxx (dynamic, duoband)',
    description:
      'Dynamic, data-driven Ha/OIII palette (SII substituted by Ha for duoband). MUST be applied ' +
      'to STRETCHED (nonlinear) channels — the blend operates on 0..1 tonal values.',
    requires: ['Ha', 'OIII'],
    scientificWhenReal: false,
    synthetic: true,
    // Authoritative Foraxx expression (thecoldestnights.com / ForaxX), duoband form with SII→Ha:
    //   R = Ha ;  G = ((O*H)^~(O*H))*H + ~((O*H)^~(O*H))*O ;  B = OIII
    // (~x = 1-x, ^ = power in PixInsight PixelMath.)
    build: (ch) => {
      if (!has(ch, ['Ha', 'OIII'])) return null;
      const H = ch.Ha!, O = ch.OIII!;
      const mix = `(${O}*${H})^~(${O}*${H})`;
      return { R: H, G: `(${mix})*${H} + ~(${mix})*${O}`, B: O };
    },
    note: 'Duoband Foraxx (SII=Ha). Apply on STRETCHED Ha/OIII. Source: thecoldestnights.com (ForaxX).',
  },
];

export function getPalette(id: string): Palette | undefined {
  return PALETTES.find((p) => p.id.toLowerCase() === id.toLowerCase());
}
