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
    name: 'Foraxx (dynamic)',
    description:
      'Dynamic Ha/OIII palette. Its published PixelMath uses specific coefficients — not ' +
      'hard-coded here to avoid fabricating expressions.',
    requires: ['Ha', 'OIII'],
    scientificWhenReal: false,
    synthetic: true,
    build: () => null,
    note: 'See docs/workflows (SHO/duoband) for the authoritative Foraxx expression, then apply via run_process("PixelMath", …).',
  },
];

export function getPalette(id: string): Palette | undefined {
  return PALETTES.find((p) => p.id.toLowerCase() === id.toLowerCase());
}
