/**
 * Processing briefs (Phase 4.3): turn a target's traits (what it is + which filter shot it) into
 * a concrete process_osc recommendation, instead of per-target code. Pure, testable, no PixInsight.
 *
 * Two trait axes drive everything:
 *   - dataType: broadband vs duoband, decided by the acquisition FILTER.
 *   - targetClass: emission nebula / galaxy / reflection / cluster / planetary / supernova-remnant,
 *     from the OBJECT name (small catalog) or an explicit override.
 */
export type DataType = 'broadband' | 'duoband';
export type TargetClass =
  | 'emission-nebula' | 'galaxy' | 'reflection-nebula' | 'planetary-nebula'
  | 'supernova-remnant' | 'open-cluster' | 'globular-cluster' | 'unknown';

/** Classify the acquisition filter into a data type. Returns null when the filter string is just a
 *  wheel position / unrecognised, so the caller can flag "confirm filter" rather than guess. */
export function classifyFilter(filter: string | null | undefined): { dataType: DataType | null; matched: string | null } {
  if (!filter) return { dataType: null, matched: null };
  const f = String(filter).toLowerCase().replace(/[\s_-]+/g, '');
  const duo = ['lextreme', 'lultimate', 'lenhance', 'duo', 'dual', 'sho', 'ha', 'halpha', 'oiii', 'sii', 'nbz', 'alpt'];
  const broad = ['uvir', 'uhc', 'lum', 'clear', 'cls', 'l', 'r', 'g', 'b', 'red', 'green', 'blue', 'none', 'osc'];
  for (const d of duo) if (f.includes(d)) return { dataType: 'duoband', matched: d };
  for (const b of broad) if (f === b || f.includes(b)) return { dataType: 'broadband', matched: b };
  return { dataType: null, matched: null }; // e.g. a bare position number like "3"
}

interface CatalogHit { class: TargetClass; }
/** Compact object → class catalog for the targets this rig actually shoots. Keyed by a normalised
 *  designation (letters+digits, upper-case). Common names are mapped to their catalog id first. */
const COMMON_NAMES: Record<string, string> = {
  ROSETTE: 'NGC2237', EAGLE: 'M16', LAGOON: 'M8', TRIFID: 'M20', OMEGA: 'M17', SWAN: 'M17',
  ORION: 'M42', RUNNINGCHICKEN: 'IC2944', HELIX: 'NGC7293', PLEIADES: 'M45', ANDROMEDA: 'M31',
  WHIRLPOOL: 'M51', PINWHEEL: 'M101', SOUTHERNPINWHEEL: 'M83', SOMBRERO: 'M104', VEIL: 'NGC6960',
  HORSEHEAD: 'IC434', FLAME: 'NGC2024', HEART: 'IC1805', SOUL: 'IC1848', ELEPHANTTRUNK: 'IC1396',
  CARINA: 'NGC3372', TARANTULA: 'NGC2070', DUMBBELL: 'M27', RING: 'M57',
};
const CATALOG: Record<string, CatalogHit> = {
  // emission nebulae
  M8: { class: 'emission-nebula' }, M16: { class: 'emission-nebula' }, M17: { class: 'emission-nebula' },
  M20: { class: 'emission-nebula' }, M42: { class: 'emission-nebula' }, NGC2237: { class: 'emission-nebula' },
  IC2944: { class: 'emission-nebula' }, NGC6188: { class: 'emission-nebula' }, IC434: { class: 'emission-nebula' },
  IC1805: { class: 'emission-nebula' }, IC1848: { class: 'emission-nebula' }, IC1396: { class: 'emission-nebula' },
  NGC3372: { class: 'emission-nebula' }, NGC2070: { class: 'emission-nebula' }, NGC2024: { class: 'emission-nebula' },
  // galaxies
  M31: { class: 'galaxy' }, M33: { class: 'galaxy' }, M51: { class: 'galaxy' }, M81: { class: 'galaxy' },
  M82: { class: 'galaxy' }, M83: { class: 'galaxy' }, M101: { class: 'galaxy' }, M104: { class: 'galaxy' }, M106: { class: 'galaxy' },
  // reflection / cluster / planetary / SNR
  M45: { class: 'reflection-nebula' }, M13: { class: 'globular-cluster' }, M3: { class: 'globular-cluster' },
  M5: { class: 'globular-cluster' }, M15: { class: 'globular-cluster' }, M11: { class: 'open-cluster' },
  M27: { class: 'planetary-nebula' }, M57: { class: 'planetary-nebula' }, NGC7293: { class: 'planetary-nebula' },
  NGC6960: { class: 'supernova-remnant' }, NGC6992: { class: 'supernova-remnant' },
};

export function targetKey(name: string | null | undefined): string {
  if (!name) return '';
  const bare = name.toUpperCase().replace(/[\s_-]+/g, '');
  return normDesignation(COMMON_NAMES[bare] ?? name);
}

function normDesignation(name: string): string {
  return name.toUpperCase().replace(/[\s_]+/g, '').replace(/^NGC0*/, 'NGC').replace(/^IC0*/, 'IC').replace(/^M0*/, 'M');
}

export function classifyObject(objectName: string | null | undefined): { class: TargetClass; via: string | null } {
  if (!objectName) return { class: 'unknown', via: null };
  const bare = objectName.toUpperCase().replace(/[\s_-]+/g, '');
  const viaName = COMMON_NAMES[bare];
  const key = normDesignation(viaName ?? objectName);
  const hit = CATALOG[key];
  if (hit) return { class: hit.class, via: viaName ? `common name → ${viaName}` : 'catalog' };
  return { class: 'unknown', via: null };
}

export interface ProcessingBrief {
  object: string | null;
  targetClass: TargetClass;
  dataType: DataType;
  dataTypeConfident: boolean;
  recommended: Record<string, unknown>; // ready to spread into process_osc
  rationale: string[];
  confirm: string[]; // things the caller should verify before trusting the brief
}

/** Build a process_osc recommendation from traits. dataType falls back to broadband when the
 *  filter is unknown, flagged via dataTypeConfident=false + a confirm note. */
export function buildBrief(
  object: string | null,
  targetClass: TargetClass,
  filterResult: { dataType: DataType | null; matched: string | null },
): ProcessingBrief {
  const dataType: DataType = filterResult.dataType ?? 'broadband';
  const dataTypeConfident = filterResult.dataType !== null;
  const rationale: string[] = [];
  const confirm: string[] = [];
  if (!dataTypeConfident) confirm.push('FILTER not recognised (often just a wheel position) — confirm broadband vs dual-band; set dataType/filter explicitly if dual-band.');

  const rec: Record<string, unknown> = { dataType };
  if (dataType === 'duoband') {
    rec.palette = 'hoo';
    rationale.push('Dual-band filter → extract Ha/OIII and combine as HOO (shared stretch preserves the Ha:OIII ratio).');
  }

  switch (targetClass) {
    case 'emission-nebula':
      Object.assign(rec, { nebulaBoost: 0.6, backgroundBlack: 0.35, saturation: 0.55, starHandling: 'reduce', starReduction: 0.5 });
      rationale.push('Emission nebula: boost nebula structure, deepen background, reduce stars so the gas dominates.');
      break;
    case 'galaxy':
      Object.assign(rec, { dataType: 'broadband', nebulaBoost: 0.3, backgroundBlack: 0.3, saturation: 0.5, stretch: 'ghs', starHandling: 'keep' });
      rationale.push('Galaxy: broadband (dual-band filters starve a galaxy of continuum); GHS for core-safe contrast, gentle boost, keep stars. Consider run_hdrmt on the core if it burns.');
      if (dataType === 'duoband') confirm.push('Target looks like a galaxy but the filter read dual-band — galaxies are normally broadband; confirm.');
      break;
    case 'reflection-nebula':
      Object.assign(rec, { dataType: 'broadband', nebulaBoost: 0.4, backgroundBlack: 0.3, saturation: 0.55, starHandling: 'keep' });
      rationale.push('Reflection nebula: broadband (scattered continuum, not line emission); keep stars, moderate boost.');
      break;
    case 'planetary-nebula':
      Object.assign(rec, { nebulaBoost: 0.5, backgroundBlack: 0.35, saturation: 0.6, starHandling: 'keep' });
      rationale.push('Planetary nebula: small, strong OIII/Ha — saturate, keep stars (the object is compact). run_hdrmt if the core clips.');
      break;
    case 'supernova-remnant':
      Object.assign(rec, { nebulaBoost: 0.6, backgroundBlack: 0.35, saturation: 0.6, starHandling: 'reduce', starReduction: 0.5 });
      rationale.push('SNR: filamentary line emission — strong boost + star reduction so filaments read.');
      break;
    case 'open-cluster':
    case 'globular-cluster':
      Object.assign(rec, { dataType: 'broadband', nebulaBoost: 0, backgroundBlack: 0.25, saturation: 0.5, stretch: 'mtf', starHandling: 'keep' });
      rationale.push('Cluster: stars ARE the subject — no nebula boost, no star reduction, gentle background, preserve star colour.');
      break;
    default:
      Object.assign(rec, { nebulaBoost: 0.5, backgroundBlack: 0.3, saturation: 0.5, starHandling: 'keep' });
      rationale.push('Unknown class → safe broadband defaults; inspect visually (take_screenshot) and set targetClass to refine.');
      confirm.push('targetClass unknown — not in the catalog; confirm what the image contains.');
  }
  // A class branch may force broadband even when the filter was dual-band (e.g. a galaxy through
  // an L-eXtreme) — drop the HOO palette so the recommendation is internally consistent.
  if (rec.dataType === 'broadband') delete (rec as Record<string, unknown>).palette;
  return { object, targetClass, dataType: rec.dataType as DataType, dataTypeConfident, recommended: rec, rationale, confirm };
}
