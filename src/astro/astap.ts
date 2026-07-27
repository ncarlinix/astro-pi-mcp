/**
 * ASTAP plate-solving integration (Stage 5). ASTAP is an external CLI solver; we save the
 * open view to a temp FITS, run ASTAP with `-update` (which writes WCS keywords back into
 * the file), then re-open it in PixInsight so SPCC/SPFC/MGC can read the astrometric
 * solution. Network-free once a star database is installed.
 *
 * The pure pieces here — detection, argument construction, and result parsing — are unit
 * tested; the subprocess exec is injectable.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

export interface SolveHints {
  /** Approximate field-center RA in hours (0–24). */
  raHours?: number;
  /** Approximate field-center declination in degrees. */
  decDeg?: number;
  /** Field height in degrees (ASTAP `-fov`). */
  fovDeg?: number;
  /** Search radius in degrees; small when a center is known, else blind (180). */
  radiusDeg?: number;
}

export interface AstapResult {
  solved: boolean;
  raDeg?: number;
  decDeg?: number;
  scaleArcsecPerPx?: number;
  rotationDeg?: number;
  error?: string;
  raw?: Record<string, string>;
}

export type ExecLike = (
  file: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Look up an executable name on PATH without spawning a process. */
function onPath(name: string): string | null {
  const path = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.com', ''] : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** Resolve the ASTAP executable. Order: override → ASTROPILOT_ASTAP_PATH → per-OS known
 *  locations → PATH (astap_cli, astap). Returns null if not found. */
export function detectAstap(override?: string): string | null {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  if (process.env.ASTROPILOT_ASTAP_PATH) candidates.push(process.env.ASTROPILOT_ASTAP_PATH);
  if (process.platform === 'darwin') {
    candidates.push('/Applications/ASTAP.app/Contents/MacOS/astap');
  } else if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\astap\\astap.exe');
  } else {
    candidates.push('/opt/astap/astap', '/usr/bin/astap', '/usr/local/bin/astap');
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return onPath('astap_cli') ?? onPath('astap');
}

/** True if a directory contains ASTAP star-database files (*.1476 or *.290). */
function dirHasDb(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).some((f) => /\.(1476|290)$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Resolve the ASTAP star-database directory. Order: override → ASTROPILOT_ASTAP_DB →
 * standard locations. Returns null if none found (ASTAP then falls back to its astap.cfg).
 */
export function detectAstapDb(override?: string): string | null {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  if (process.env.ASTROPILOT_ASTAP_DB) candidates.push(process.env.ASTROPILOT_ASTAP_DB);
  const home = homedir();
  candidates.push(
    join(home, 'Library', 'Application Support', 'astap'),
    join(home, '.astap'),
    '/usr/local/share/astap',
    '/opt/astap',
  );
  for (const c of candidates) {
    if (dirHasDb(c)) return c;
  }
  return null;
}

/** Build the ASTAP command-line arguments. `dbPath` (optional) sets the star database dir. */
export function buildAstapArgs(fitsPath: string, hints: SolveHints = {}, dbPath?: string): string[] {
  const args = ['-f', fitsPath, '-wcs', '-update', '-z', '0'];
  if (dbPath) args.push('-d', dbPath);
  if (hints.fovDeg && hints.fovDeg > 0) args.push('-fov', hints.fovDeg.toFixed(4));
  if (hints.raHours != null && hints.decDeg != null) {
    args.push('-ra', hints.raHours.toFixed(5));
    args.push('-spd', (hints.decDeg + 90).toFixed(5)); // south pole distance = dec + 90
    args.push('-r', (hints.radiusDeg ?? 15).toFixed(1)); // constrained search around the hint
  } else {
    args.push('-r', (hints.radiusDeg ?? 180).toFixed(1)); // blind
  }
  return args;
}

/** Parse `KEY=VALUE` / FITS-card lines from an ASTAP .ini or .wcs file into a map. */
export function parseKeywords(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:\/.*)?$/.exec(line);
    if (m) map[m[1]!.toUpperCase()] = m[2]!.replace(/^'|'$/g, '').trim();
  }
  return map;
}

const numOrNull = (s: string | undefined): number | null => {
  if (s == null) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
};

/** Turn parsed keywords into a solve result (RA/Dec/scale/rotation). */
export function interpretSolve(kw: Record<string, string>): AstapResult {
  const flag = (kw.PLTSOLVD ?? '').toUpperCase();
  const solved = flag.startsWith('T') || (kw.CRVAL1 != null && kw.CRVAL2 != null && flag !== 'F');
  if (!solved) {
    return { solved: false, error: kw.WARNING ?? kw.ERROR ?? 'ASTAP found no solution', raw: kw };
  }
  const raDeg = numOrNull(kw.CRVAL1);
  const decDeg = numOrNull(kw.CRVAL2);
  const cd11 = numOrNull(kw.CD1_1);
  const cd12 = numOrNull(kw.CD1_2);
  const cd21 = numOrNull(kw.CD2_1);
  let scaleArcsecPerPx: number | undefined;
  if (cd11 != null && cd12 != null) {
    scaleArcsecPerPx = Math.sqrt(cd11 * cd11 + cd12 * cd12) * 3600;
  } else if (kw.CDELT1 != null) {
    scaleArcsecPerPx = Math.abs(numOrNull(kw.CDELT1)!) * 3600;
  }
  let rotationDeg = numOrNull(kw.CROTA2) ?? undefined;
  if (rotationDeg == null && cd21 != null && cd11 != null) {
    rotationDeg = (Math.atan2(cd21, cd11) * 180) / Math.PI;
  }
  return {
    solved: true,
    raDeg: raDeg ?? undefined,
    decDeg: decDeg ?? undefined,
    scaleArcsecPerPx: scaleArcsecPerPx ? Number(scaleArcsecPerPx.toPrecision(5)) : undefined,
    rotationDeg: rotationDeg != null ? Number(rotationDeg.toPrecision(5)) : undefined,
    raw: kw,
  };
}

const defaultExec: ExecLike = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface SolveOptions {
  astapPath: string;
  fitsPath: string;
  hints?: SolveHints;
  /** Star-database directory (`-d`). If omitted, ASTAP uses its own astap.cfg. */
  dbPath?: string;
  exec?: ExecLike;
  /** Injectable reader for the sidecar result files (default reads from disk). */
  readSidecar?: (path: string) => string | null;
}

/** Run ASTAP on a FITS file and parse the resulting .ini/.wcs sidecar. */
export async function solveWithAstap(opts: SolveOptions): Promise<AstapResult> {
  const exec = opts.exec ?? defaultExec;
  const read =
    opts.readSidecar ?? ((p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : null));
  const args = buildAstapArgs(opts.fitsPath, opts.hints, opts.dbPath);
  const { code, stdout, stderr } = await exec(opts.astapPath, args);

  const base = opts.fitsPath.replace(/\.[^.]+$/, '');
  let kw: Record<string, string> = {};
  // ASTAP writes <base>.wcs (always on solve) and <base>.ini (result summary).
  for (const ext of ['.wcs', '.ini']) {
    const text = read(base + ext);
    if (text) kw = { ...kw, ...parseKeywords(text) };
  }
  const res = interpretSolve(kw);
  if (!res.solved) {
    res.error =
      res.error && Object.keys(kw).length
        ? res.error
        : stderr.trim() || stdout.trim() || `ASTAP exited ${code} with no solution file (is a star database installed?)`;
  }
  return res;
}
