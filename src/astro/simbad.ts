/**
 * Target name resolution via the CDS Sesame service (SIMBAD/NED/VizieR) — Stage 5.
 * Network access is optional and injectable (pass `fetchFn` in tests). Returns ICRS J2000
 * coordinates and, when available, the object type string.
 */
export interface ResolvedTarget {
  name: string;
  ra: number | null; // degrees
  dec: number | null; // degrees
  objectType: string | null;
  raw?: string;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const SESAME_BASE = 'https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?';

/** Parse a Sesame `-oI` text block. `%J <ra> <dec>` carries ICRS J2000 in degrees. */
export function parseSesame(name: string, text: string): ResolvedTarget {
  const j = /%J\s+([\d.]+)\s+([-+][\d.]+)/.exec(text);
  const ra = j ? Number(j[1]) : null;
  const dec = j ? Number(j[2]) : null;
  const c = /%C\.0\s+(.+)/.exec(text) ?? /%C\s+(.+)/.exec(text);
  return {
    name,
    ra: ra !== null && isFinite(ra) ? ra : null,
    dec: dec !== null && isFinite(dec) ? dec : null,
    objectType: c ? c[1]!.trim() : null,
    raw: text.slice(0, 400),
  };
}

export async function resolveTarget(
  name: string,
  fetchFn?: FetchLike,
): Promise<ResolvedTarget> {
  const f: FetchLike | undefined = fetchFn ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!f) {
    return { name, ra: null, dec: null, objectType: null, raw: 'no fetch available' };
  }
  const res = await f(SESAME_BASE + encodeURIComponent(name));
  if (!res.ok) {
    return { name, ra: null, dec: null, objectType: null, raw: `HTTP ${res.status}` };
  }
  return parseSesame(name, await res.text());
}

/**
 * Distance lookup via the SIMBAD TAP service — Stage 2.3 fallback for the LCARS card when a
 * target isn't in the curated table. Reliable for stars/open clusters via trigonometric
 * parallax; for galaxies/nebulae it falls back to a redshift-independent mesDistance row.
 * Network is injectable (same FetchLike as resolveTarget) and every failure path returns nulls,
 * so a caller can treat "no distance" as "—". Does not throw.
 */
export interface DistanceResult {
  ly: number | null;
  pc: number | null;
  method: string | null;
  raw?: string;
}

const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync?request=doQuery&lang=adql&format=json&query=';
const PC_PER_LY = 3.2615638;

/** Human-readable light-year string: "~5,700 ly" or "~15 Mly". Returns "—" for non-finite input. */
export function formatLightYears(ly: number | null): string {
  if (ly === null || !isFinite(ly) || ly <= 0) return '—';
  if (ly >= 1e6) {
    const m = ly / 1e6;
    return `~${m >= 10 ? Math.round(m) : m.toFixed(1)} Mly`;
  }
  // round to a sensible scale: nearest 100 under 100k ly
  const rounded = ly >= 1e4 ? Math.round(ly / 100) * 100 : Math.round(ly / 10) * 10;
  return `~${rounded.toLocaleString('en-US')} ly`;
}

export async function resolveDistance(name: string, fetchFn?: FetchLike): Promise<DistanceResult> {
  const miss = (raw: string): DistanceResult => ({ ly: null, pc: null, method: null, raw });
  const f: FetchLike | undefined = fetchFn ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!f) return miss('no fetch available');
  const esc = name.replace(/'/g, "''");
  const adql =
    'SELECT TOP 8 b.plx_value, d.dist, d.unit, d.method ' +
    'FROM basic AS b JOIN ident AS i ON i.oidref = b.oid ' +
    'LEFT JOIN mesDistance AS d ON d.oidref = b.oid ' +
    `WHERE i.id = '${esc}'`;
  let res: { ok: boolean; status: number; text(): Promise<string> };
  try {
    res = await f(SIMBAD_TAP + encodeURIComponent(adql));
  } catch {
    return miss('fetch error');
  }
  if (!res.ok) return miss(`HTTP ${res.status}`);
  let j: { data?: unknown[] };
  try {
    j = JSON.parse(await res.text()) as { data?: unknown[] };
  } catch {
    return miss('bad json');
  }
  const rows = (Array.isArray(j.data) ? j.data : []) as unknown[][];
  if (!rows.length) return miss('no match');
  // 1) trigonometric parallax (mas) — best for stars/clusters
  const plx = rows[0]?.[0];
  if (typeof plx === 'number' && isFinite(plx) && plx > 0) {
    const pc = 1000 / plx;
    return { ly: pc * PC_PER_LY, pc, method: 'parallax' };
  }
  // 2) mesDistance row (pc/kpc/Mpc) — redshift-independent distances for extragalactic targets
  for (const r of rows) {
    const dist = r?.[1];
    const unit = r?.[2];
    const method = (r?.[3] as string | undefined) ?? 'mesDistance';
    if (typeof dist === 'number' && isFinite(dist) && dist > 0) {
      const pc = unit === 'kpc' ? dist * 1e3 : unit === 'Mpc' ? dist * 1e6 : unit === 'pc' ? dist : null;
      if (pc !== null) return { ly: pc * PC_PER_LY, pc, method };
    }
  }
  return miss('no distance field');
}
