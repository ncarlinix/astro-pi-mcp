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
