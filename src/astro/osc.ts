/**
 * OSC (one-shot-colour) camera knowledge (Stage 11): common sensors + duoband handling.
 * Pixel sizes are manufacturer specs (facts, not fabricated tuning values).
 */
export interface OscCamera {
  id: string;
  name: string;
  sensor: string;
  pixelSizeUm: number;
  resolution: [number, number];
  notes: string;
}

export const OSC_CAMERAS: OscCamera[] = [
  { id: 'asi533mc', name: 'ZWO ASI533MC Pro', sensor: 'Sony IMX533 (1")', pixelSizeUm: 3.76, resolution: [3008, 3008], notes: 'Square sensor, very low amp glow; popular duoband target camera.' },
  { id: 'asi2600mc', name: 'ZWO ASI2600MC Pro', sensor: 'Sony IMX571 (APS-C)', pixelSizeUm: 3.76, resolution: [6248, 4176], notes: 'APS-C, excellent well depth; a go-to broadband/duoband OSC.' },
  { id: 'asi294mc', name: 'ZWO ASI294MC Pro', sensor: 'Sony IMX294 (4/3")', pixelSizeUm: 4.63, resolution: [4144, 2822], notes: 'Bin1 vs unlocked-bin2 modes matter; watch for pattern noise.' },
  { id: 'asi071mc', name: 'ZWO ASI071MC Pro', sensor: 'Sony IMX071 (APS-C)', pixelSizeUm: 4.78, resolution: [4944, 3284], notes: 'Older APS-C OSC.' },
  { id: 'canon-dslr', name: 'Canon DSLR (generic)', sensor: 'Canon CMOS', pixelSizeUm: 4.3, resolution: [6000, 4000], notes: 'Modded (astro) recommended for Ha; CR2/CR3 via calibration.' },
  { id: 'sony-mirrorless', name: 'Sony mirrorless (generic)', sensor: 'Sony CMOS', pixelSizeUm: 3.9, resolution: [6000, 4000], notes: 'Star-eater/raw-compression caveats on some bodies.' },
];

export function getOscCamera(id: string): OscCamera | undefined {
  return OSC_CAMERAS.find((c) => c.id.toLowerCase() === id.toLowerCase());
}

/**
 * PixelMath expressions to synthesise Ha and OIII from a duoband OSC image.
 * Standard approximation: Ha ≈ Red channel; OIII ≈ mean(Green, Blue). This is the common,
 * widely-documented split (not a fabricated coefficient recipe).
 */
export function duobandExtraction(sourceView: string): { Ha: string; OIII: string } {
  return {
    Ha: `${sourceView}[0]`,
    OIII: `(${sourceView}[1] + ${sourceView}[2])/2`,
  };
}
