import { describe, it, expect } from 'vitest';
import {
  julianDay,
  gmstDeg,
  moonIllumination,
  equatorialToHorizontal,
  angularSeparation,
  parseRa,
  parseDec,
} from '../src/astro/ephemeris.js';

describe('ephemeris', () => {
  it('J2000 epoch has JD 2451545.0', () => {
    expect(julianDay(new Date('2000-01-01T12:00:00Z'))).toBeCloseTo(2451545.0, 6);
  });

  it('GMST is within [0,360)', () => {
    const g = gmstDeg(new Date('2026-07-27T00:00:00Z'));
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThan(360);
  });

  it('parses sexagesimal and decimal RA/Dec', () => {
    expect(parseRa('12 00 00')).toBeCloseTo(180, 6);
    expect(parseRa('06:00:00')).toBeCloseTo(90, 6);
    expect(parseRa(200)).toBeCloseTo(200, 6);
    expect(parseDec('+41 16 09')).toBeCloseTo(41.269, 2);
    expect(parseDec('-30:00:00')).toBeCloseTo(-30, 6);
    expect(parseDec(-45.5)).toBeCloseTo(-45.5, 6);
  });

  it('moon illumination stays in [0,1] and swings across half a synodic month', () => {
    const d0 = new Date('2024-06-06T12:00:00Z');
    const d1 = new Date(d0.getTime() + 14.77 * 86_400_000);
    const f0 = moonIllumination(d0).illuminatedFraction;
    const f1 = moonIllumination(d1).illuminatedFraction;
    for (const f of [f0, f1]) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    // Half a synodic month apart → nearly opposite phases.
    expect(Math.abs(f0 - f1)).toBeGreaterThan(0.5);
  });

  it('altitude of the celestial pole equals observer latitude', () => {
    const lat = 45;
    const alt = equatorialToHorizontal({ ra: 123, dec: 90 }, lat, -70, new Date('2026-03-01T02:00:00Z')).altitude;
    expect(alt).toBeCloseTo(lat, 3);
  });

  it('angular separation is 0 for identical coords and 90 for orthogonal', () => {
    expect(angularSeparation({ ra: 10, dec: 20 }, { ra: 10, dec: 20 })).toBeCloseTo(0, 6);
    expect(angularSeparation({ ra: 0, dec: 0 }, { ra: 90, dec: 0 })).toBeCloseTo(90, 6);
  });
});
