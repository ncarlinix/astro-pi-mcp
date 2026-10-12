/**
 * Hierarchical knowledge store (Phase 4.2): learned processing params that layer on top of the
 * 4.3 briefs. Params resolve most-specific-first across four levels —
 *
 *   universal  <  trait:<name>  <  type:<class>  <  target:<id>
 *
 * — so a value set for M83 beats one for all galaxies, which beats one for a trait, which beats
 * a universal default. record() logs the params actually accepted for a target and auto-promotes
 * a value to the type level once PROMOTE_THRESHOLD distinct sibling targets agree on it, so good
 * parameters learned on one target inform similar ones.
 *
 * Pure Node, fail-safe, unit-testable: point ASTROPILOT_KNOWLEDGE_DIR at a temp dir. Any IO/parse
 * error degrades to an empty store rather than throwing.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const PROMOTE_THRESHOLD = 3;

export function knowledgeDir(): string {
  return process.env.ASTROPILOT_KNOWLEDGE_DIR || join(homedir(), '.astropilot', 'knowledge');
}
function storePath(): string { return join(knowledgeDir(), 'params.json'); }

export type Params = Record<string, unknown>;

interface Bucket { params: Params; }
interface TargetBucket extends Bucket { type?: string; observations: Params[]; }
interface Store {
  universal: Bucket;
  trait: Record<string, Bucket>;
  type: Record<string, Bucket>;
  target: Record<string, TargetBucket>;
}

function empty(): Store {
  return { universal: { params: {} }, trait: {}, type: {}, target: {} };
}

async function read(): Promise<Store> {
  try {
    const s = JSON.parse(await readFile(storePath(), 'utf-8')) as Partial<Store>;
    return {
      universal: s.universal ?? { params: {} },
      trait: s.trait ?? {},
      type: s.type ?? {},
      target: s.target ?? {},
    };
  } catch {
    return empty();
  }
}

async function write(s: Store): Promise<void> {
  await mkdir(knowledgeDir(), { recursive: true });
  const tmp = storePath() + '.tmp';
  await writeFile(tmp, JSON.stringify(s, null, 2), 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, storePath());
}

export type Level = 'universal' | 'trait' | 'type' | 'target';

export interface ResolveResult {
  params: Params;
  provenance: Record<string, string>; // param key → the level it came from (e.g. "type:galaxy")
}

/** Merge params most-specific-last so the specific level wins, recording where each key came from. */
export async function knowledgeResolve(
  opts: { target?: string | null; type?: string | null; traits?: string[] },
): Promise<ResolveResult> {
  const s = await read();
  const params: Params = {};
  const provenance: Record<string, string> = {};
  const apply = (b: Bucket | undefined, label: string) => {
    if (!b || !b.params) return;
    for (const k of Object.keys(b.params)) { params[k] = b.params[k]; provenance[k] = label; }
  };
  apply(s.universal, 'universal');
  for (const t of opts.traits ?? []) apply(s.trait[t], `trait:${t}`);
  if (opts.type) apply(s.type[opts.type], `type:${opts.type}`);
  if (opts.target) apply(s.target[opts.target], `target:${opts.target}`);
  return { params, provenance };
}

/** Set (merge) params at a level. For trait/type/target, `name` picks the bucket. */
export async function knowledgeSet(level: Level, name: string | null, params: Params): Promise<void> {
  const s = await read();
  if (level === 'universal') {
    s.universal.params = { ...s.universal.params, ...params };
  } else if (name) {
    const coll = s[level] as Record<string, Bucket>;
    coll[name] = { params: { ...(coll[name]?.params ?? {}), ...params } };
  }
  await write(s);
}

/** Record the params accepted for a target (keeps the latest per key as an observation) and run
 *  auto-promotion. Returns the keys/values promoted to the type level this call. */
export async function knowledgeRecord(
  target: string,
  type: string | null,
  params: Params,
): Promise<{ promoted: Params }> {
  const s = await read();
  const tb: TargetBucket = s.target[target] ?? { params: {}, observations: [] };
  if (type) tb.type = type;
  tb.params = { ...tb.params, ...params };
  tb.observations = [...(tb.observations ?? []), { ...params, _at: new Date().toISOString() }].slice(-20);
  s.target[target] = tb;

  const promoted: Params = {};
  if (type) {
    // For each param key, count distinct sibling targets of this type whose current value agrees.
    const siblings = Object.entries(s.target).filter(([, b]) => b.type === type);
    const keys = new Set<string>();
    for (const [, b] of siblings) for (const k of Object.keys(b.params)) if (k !== '_at') keys.add(k);
    for (const k of keys) {
      const counts = new Map<string, number>();
      for (const [, b] of siblings) {
        if (k in b.params) {
          const v = JSON.stringify(b.params[k]);
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
      for (const [vJson, n] of counts) {
        if (n >= PROMOTE_THRESHOLD) {
          const v = JSON.parse(vJson);
          const cur = s.type[type]?.params?.[k];
          if (JSON.stringify(cur) !== vJson) {
            s.type[type] = { params: { ...(s.type[type]?.params ?? {}), [k]: v } };
            promoted[k] = v;
          }
        }
      }
    }
  }
  await write(s);
  return { promoted };
}

export interface KnowledgeStats {
  dir: string;
  universal: Params;
  traits: string[];
  types: Record<string, Params>;
  targets: Record<string, { type?: string; params: Params; observations: number }>;
}

export async function knowledgeStats(): Promise<KnowledgeStats> {
  const s = await read();
  const targets: KnowledgeStats['targets'] = {};
  for (const [k, b] of Object.entries(s.target)) targets[k] = { type: b.type, params: b.params, observations: (b.observations ?? []).length };
  const types: Record<string, Params> = {};
  for (const [k, b] of Object.entries(s.type)) types[k] = b.params;
  return { dir: knowledgeDir(), universal: s.universal.params, traits: Object.keys(s.trait), types, targets };
}

/** Clear a level/name, or the whole store when called with no args. Returns true on success. */
export async function knowledgeClear(level?: Level, name?: string | null): Promise<boolean> {
  try {
    if (!level) { await write(empty()); return true; }
    const s = await read();
    if (level === 'universal') s.universal = { params: {} };
    else if (name) delete (s[level] as Record<string, unknown>)[name];
    else if (level === 'trait') s.trait = {};
    else if (level === 'type') s.type = {};
    else if (level === 'target') s.target = {};
    await write(s);
    return true;
  } catch {
    return false;
  }
}
