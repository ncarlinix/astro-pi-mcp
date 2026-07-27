import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectAstap,
  buildAstapArgs,
  parseKeywords,
  interpretSolve,
  solveWithAstap,
} from '../src/astro/astap.js';

describe('detectAstap', () => {
  // Machine-independent: don't assume whether ASTAP is installed. Test precedence with
  // temp files instead.
  it('returns an override path that exists', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'astap-')), 'astap');
    writeFileSync(p, '#!/bin/sh\n');
    expect(detectAstap(p)).toBe(p);
  });

  it('honors ASTROPILOT_ASTAP_PATH', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'astap-')), 'astap');
    writeFileSync(p, '#!/bin/sh\n');
    const saved = process.env.ASTROPILOT_ASTAP_PATH;
    process.env.ASTROPILOT_ASTAP_PATH = p;
    try {
      expect(detectAstap()).toBe(p);
    } finally {
      if (saved) process.env.ASTROPILOT_ASTAP_PATH = saved;
      else delete process.env.ASTROPILOT_ASTAP_PATH;
    }
  });
});

describe('buildAstapArgs', () => {
  it('does a blind solve without a center hint', () => {
    const args = buildAstapArgs('/tmp/x.fit');
    expect(args).toContain('-f');
    expect(args).toContain('/tmp/x.fit');
    expect(args).toContain('-update');
    expect(args).toContain('-wcs');
    const r = args[args.indexOf('-r') + 1];
    expect(Number(r)).toBe(180); // blind radius
    expect(args).not.toContain('-ra');
  });

  it('adds the star-database path with -d when given', () => {
    const args = buildAstapArgs('/tmp/x.fit', {}, '/db/d50');
    expect(args[args.indexOf('-d') + 1]).toBe('/db/d50');
  });

  it('constrains the search when RA/Dec/FOV hints are given', () => {
    const args = buildAstapArgs('/tmp/x.fit', { raHours: 6.5, decDeg: 4.93, fovDeg: 2.28 });
    expect(args[args.indexOf('-ra') + 1]).toBe('6.50000');
    expect(args[args.indexOf('-spd') + 1]).toBe('94.93000'); // dec + 90
    expect(args[args.indexOf('-fov') + 1]).toBe('2.2800');
    expect(Number(args[args.indexOf('-r') + 1])).toBe(15); // constrained radius
  });
});

describe('parseKeywords / interpretSolve', () => {
  it('parses a solved .wcs and derives scale + rotation from the CD matrix', () => {
    const wcs = [
      'PLTSOLVD=T',
      'CRVAL1 =  97.9880 / RA of reference pixel',
      'CRVAL2 =   4.9320 / Dec of reference pixel',
      "CD1_1  = -0.00064700",
      'CD1_2  =  0.00000000',
      'CD2_1  =  0.00000000',
      'CD2_2  =  0.00064700',
    ].join('\n');
    const kw = parseKeywords(wcs);
    expect(kw.PLTSOLVD).toBe('T');
    const res = interpretSolve(kw);
    expect(res.solved).toBe(true);
    expect(res.raDeg).toBeCloseTo(97.988, 3);
    expect(res.decDeg).toBeCloseTo(4.932, 3);
    // 0.000647 deg/px * 3600 ≈ 2.33 arcsec/px (matches the Rosette test frame).
    expect(res.scaleArcsecPerPx).toBeCloseTo(2.33, 1);
  });

  it('reports failure when PLTSOLVD is F', () => {
    const res = interpretSolve(parseKeywords('PLTSOLVD=F\nWARNING=no stars matched'));
    expect(res.solved).toBe(false);
    expect(res.error).toMatch(/no stars/);
  });
});

describe('solveWithAstap (injected exec + sidecar)', () => {
  it('runs ASTAP and parses the written sidecar', async () => {
    const sidecar: Record<string, string> = {
      '/tmp/frame.wcs': 'PLTSOLVD=T\nCRVAL1=97.99\nCRVAL2=4.93\nCDELT1=-0.000647\nCDELT2=0.000647',
    };
    let calledWith: string[] = [];
    const res = await solveWithAstap({
      astapPath: '/fake/astap',
      fitsPath: '/tmp/frame.fit',
      hints: { raHours: 6.5, decDeg: 4.93 },
      exec: async (_file, args) => {
        calledWith = args;
        return { code: 0, stdout: 'Solution found', stderr: '' };
      },
      readSidecar: (p) => sidecar[p] ?? null,
    });
    expect(res.solved).toBe(true);
    expect(res.raDeg).toBeCloseTo(97.99, 2);
    expect(res.scaleArcsecPerPx).toBeCloseTo(2.33, 1);
    expect(calledWith).toContain('-update');
  });

  it('surfaces a solver failure with no sidecar', async () => {
    const res = await solveWithAstap({
      astapPath: '/fake/astap',
      fitsPath: '/tmp/none.fit',
      exec: async () => ({ code: 1, stdout: '', stderr: 'no star database found' }),
      readSidecar: () => null,
    });
    expect(res.solved).toBe(false);
    expect(res.error).toMatch(/star database/);
  });
});
