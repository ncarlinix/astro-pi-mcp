/**
 * Prep caching (Phase 4.1). A content/param fingerprint over a source master lets the OSC
 * pipeline skip the ~10–15 min linear prep (GradientCorrection → SPCC → BXT → NXT) when the
 * exact same input is reprocessed with the exact same parameters. The cached artifact is the
 * post-NXT linear image, saved as XISF; the manifest maps fingerprint → artifact.
 *
 * Everything here is pure Node (no PixInsight), fail-safe, and unit-testable: point
 * ASTROPILOT_CACHE_DIR at a temp dir in tests. Any corruption/IO error degrades to "no cache"
 * rather than throwing, so a caller can always fall through to a normal prep run.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export function cacheRoot(): string {
  return process.env.ASTROPILOT_CACHE_DIR || join(homedir(), '.astropilot', 'cache', 'prep');
}

export interface PrepFingerprintInput {
  sourcePath: string;
  sizeBytes: number;
  mtimeMs: number;
  params: Record<string, unknown>;
}

/** Stable JSON: sort object keys recursively so param order never changes the fingerprint. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = canonical(o[k]); return acc; }, {});
  }
  return v;
}

/** 32-hex fingerprint over source identity (path + size + mtime) and the prep params. */
export function prepFingerprint(i: PrepFingerprintInput): string {
  const s = JSON.stringify({ p: i.sourcePath, s: i.sizeBytes, m: Math.round(i.mtimeMs), prm: canonical(i.params) });
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

export interface CacheEntry {
  fingerprint: string;
  file: string;
  sourcePath: string;
  object?: string;
  createdAt: string;
  bytes?: number;
}

type Manifest = Record<string, CacheEntry>;
function manifestPath(): string { return join(cacheRoot(), 'manifest.json'); }

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath(), 'utf-8');
    const m = JSON.parse(raw) as Manifest;
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

async function writeManifest(m: Manifest): Promise<void> {
  await mkdir(cacheRoot(), { recursive: true });
  const tmp = manifestPath() + '.tmp';
  await writeFile(tmp, JSON.stringify(m, null, 2), 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, manifestPath());
}

/** Return a live cache entry for this fingerprint, or null. A manifest row whose artifact is
 *  gone is pruned on read so the pipeline never tries to load a missing file. */
export async function cacheLookup(fingerprint: string): Promise<CacheEntry | null> {
  const m = await readManifest();
  const e = m[fingerprint];
  if (!e) return null;
  if (!existsSync(e.file)) {
    delete m[fingerprint];
    try { await writeManifest(m); } catch { /* best-effort prune */ }
    return null;
  }
  return e;
}

/** Absolute path where this fingerprint's artifact should be saved (caller writes the XISF). */
export async function cacheArtifactPath(fingerprint: string): Promise<string> {
  await mkdir(cacheRoot(), { recursive: true });
  return join(cacheRoot(), `${fingerprint}.xisf`);
}

/** Record (or overwrite) a manifest entry after the artifact has been written. Reads the file
 *  size when not supplied. Fail-safe: returns false on any error. */
export async function cacheStore(entry: Omit<CacheEntry, 'createdAt' | 'bytes'> & { createdAt?: string; bytes?: number }): Promise<boolean> {
  try {
    let bytes = entry.bytes;
    if (bytes === undefined && existsSync(entry.file)) {
      try { bytes = (await stat(entry.file)).size; } catch { /* leave undefined */ }
    }
    const m = await readManifest();
    m[entry.fingerprint] = { ...entry, createdAt: entry.createdAt ?? new Date().toISOString(), bytes };
    await writeManifest(m);
    return true;
  } catch {
    return false;
  }
}

export interface CacheStats { dir: string; count: number; bytes: number; entries: CacheEntry[]; }

export async function cacheStats(): Promise<CacheStats> {
  const m = await readManifest();
  const entries = Object.values(m);
  const bytes = entries.reduce((a, e) => a + (e.bytes ?? 0), 0);
  return { dir: cacheRoot(), count: entries.length, bytes, entries };
}

/** Remove one fingerprint (artifact + manifest row) or, with no argument, the whole cache.
 *  Returns the number of artifacts deleted. */
export async function cacheClear(fingerprint?: string): Promise<number> {
  const m = await readManifest();
  const targets = fingerprint ? (m[fingerprint] ? [m[fingerprint]] : []) : Object.values(m);
  let removed = 0;
  for (const e of targets) {
    try { if (existsSync(e.file)) { await unlink(e.file); } removed++; } catch { /* keep going */ }
    delete m[e.fingerprint];
  }
  try { await writeManifest(m); } catch { /* best-effort */ }
  return removed;
}
