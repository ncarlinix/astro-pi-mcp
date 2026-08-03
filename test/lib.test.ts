import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore, JsonDoc } from '../src/store/json-store.js';
import { getPalette, PALETTES } from '../src/palettes/index.js';
import { getOscCamera, duobandExtraction } from '../src/astro/osc.js';
import { parseSesame } from '../src/astro/simbad.js';
import { KnowledgeBase } from '../src/knowledge/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'astropilot-store-'));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
}

describe('JsonStore / JsonDoc', () => {
  it('puts, gets, lists, and deletes', async () => {
    const dir = await tempDir();
    const store = new JsonStore<{ id: string; v: number }>('things', dir);
    await store.put({ id: 'a', v: 1 });
    await store.put({ id: 'b', v: 2 });
    expect((await store.get('a'))?.v).toBe(1);
    expect((await store.list()).length).toBe(2);
    expect(await store.delete('a')).toBe(true);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.delete('missing')).toBe(false);
  });

  it('JsonDoc reads fallback then persists', async () => {
    const dir = await tempDir();
    const doc = new JsonDoc<{ n: number }>('doc', dir);
    expect(await doc.read({ n: 0 })).toEqual({ n: 0 });
    await doc.write({ n: 5 });
    expect(await doc.read({ n: 0 })).toEqual({ n: 5 });
  });
});

describe('palettes', () => {
  it('HOO routes Ha→R, OIII→G&B', () => {
    const p = getPalette('HOO')!;
    expect(p.build({ Ha: 'ha', OIII: 'oiii' })).toEqual({ R: 'ha', G: 'oiii', B: 'oiii' });
  });
  it('SHO needs SII', () => {
    expect(getPalette('SHO')!.build({ Ha: 'ha', OIII: 'oiii' })).toBeNull();
  });
  it('synthetic-SHO is flagged synthetic', () => {
    const p = getPalette('synthetic-SHO')!;
    expect(p.synthetic).toBe(true);
    expect(p.scientificWhenReal).toBe(false);
  });
  it('foraxx has no built-in expression', () => {
    expect(getPalette('foraxx')!.build({ Ha: 'ha', OIII: 'oiii' })).toBeNull();
  });
  it('registry is non-empty', () => {
    expect(PALETTES.length).toBeGreaterThan(3);
  });
});

describe('OSC', () => {
  it('looks up a camera and builds a duoband split', () => {
    expect(getOscCamera('asi533mc')?.pixelSizeUm).toBe(3.76);
    const ex = duobandExtraction('src');
    expect(ex.Ha).toBe('src[0]');
    expect(ex.OIII).toContain('src[1]');
  });
});

describe('Sesame parser', () => {
  it('extracts J2000 coordinates and object type', () => {
    const block = '# M31\n%J 010.6847083 +41.2690611 = ...\n%C.0 G  (galaxy)\n';
    const r = parseSesame('M31', block);
    expect(r.ra).toBeCloseTo(10.6847, 3);
    expect(r.dec).toBeCloseTo(41.269, 3);
    expect(r.objectType).toContain('G');
  });
});

describe('KnowledgeBase (reads docs/)', () => {
  it('lists workflow playbooks and fetches one', async () => {
    const kb = new KnowledgeBase();
    const wfs = await kb.listWorkflows();
    expect(wfs.length).toBeGreaterThanOrEqual(7);
    expect(wfs.map((w) => w.category)).toContain('osc-hoo');
    const md = await kb.getWorkflow('osc-hoo');
    expect(md).toBeTruthy();
    expect(md!).toContain('#');
    expect(await kb.getWorkflow('does-not-exist')).toBeNull();
  });
});
