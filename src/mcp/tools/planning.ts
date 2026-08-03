import { z } from 'zod';
import type { ToolDef } from './types.js';
import { jsonResult } from './util.js';
import {
  moonIllumination,
  moonPosition,
  sunPosition,
  equatorialToHorizontal,
  angularSeparation,
  parseRa,
  parseDec,
} from '../../astro/ephemeris.js';

function whenDate(when?: string): Date {
  if (!when) return new Date();
  const d = new Date(when);
  return isNaN(d.getTime()) ? new Date() : d;
}

export const moonInfo: ToolDef = {
  name: 'moon_info',
  description:
    'Moon phase for a given time (default now): illuminated fraction, phase name, waxing/waning. ' +
    'With observer lat/lon, also reports the Moon altitude (below horizon = not a problem).',
  inputSchema: {
    when: z.string().optional().describe('ISO datetime (UTC); default now'),
    lat: z.number().optional().describe('Observer latitude (deg)'),
    lon: z.number().optional().describe('Observer longitude (deg, +E)'),
  },
  handler: async (_backend, args) => {
    const date = whenDate(args.when as string | undefined);
    const illum = moonIllumination(date);
    const out: Record<string, unknown> = {
      when: date.toISOString(),
      illuminatedFraction: Number(illum.illuminatedFraction.toFixed(3)),
      phaseName: illum.phaseName,
      waxing: illum.waxing,
    };
    if (typeof args.lat === 'number' && typeof args.lon === 'number') {
      const horiz = equatorialToHorizontal(moonPosition(date), args.lat as number, args.lon as number, date);
      out.moonAltitude = Number(horiz.altitude.toFixed(1));
      out.moonAboveHorizon = horiz.altitude > 0;
    }
    return jsonResult(out);
  },
};

export const targetVisibility: ToolDef = {
  name: 'target_visibility',
  description:
    'Compute a target’s altitude/azimuth for an observer and time, plus angular separation ' +
    'from the Moon and the Moon’s illumination — the core of moon-avoidance planning. RA/Dec ' +
    'accept sexagesimal ("HH MM SS" / "+DD MM SS") or decimal degrees.',
  inputSchema: {
    ra: z.union([z.string(), z.number()]).describe('Target RA'),
    dec: z.union([z.string(), z.number()]).describe('Target Dec'),
    lat: z.number().describe('Observer latitude (deg)'),
    lon: z.number().describe('Observer longitude (deg, +E)'),
    when: z.string().optional().describe('ISO datetime (UTC); default now'),
  },
  handler: async (_backend, args) => {
    const ra = parseRa(args.ra as string | number);
    const dec = parseDec(args.dec as string | number);
    if (ra === null || dec === null) {
      return { content: [{ type: 'text', text: 'Could not parse ra/dec.' }], isError: true };
    }
    const date = whenDate(args.when as string | undefined);
    const eq = { ra, dec };
    const horiz = equatorialToHorizontal(eq, args.lat as number, args.lon as number, date);
    const moon = moonPosition(date);
    const moonHoriz = equatorialToHorizontal(moon, args.lat as number, args.lon as number, date);
    const sep = angularSeparation(eq, moon);
    const illum = moonIllumination(date);
    const sunHoriz = equatorialToHorizontal(sunPosition(date), args.lat as number, args.lon as number, date);

    return jsonResult({
      when: date.toISOString(),
      target: { raDeg: Number(ra.toFixed(4)), decDeg: Number(dec.toFixed(4)), altitude: Number(horiz.altitude.toFixed(1)), azimuth: Number(horiz.azimuth.toFixed(1)), aboveHorizon: horiz.altitude > 0 },
      sun: { altitude: Number(sunHoriz.altitude.toFixed(1)), isDark: sunHoriz.altitude < -18 },
      moon: {
        altitude: Number(moonHoriz.altitude.toFixed(1)),
        aboveHorizon: moonHoriz.altitude > 0,
        illuminatedFraction: Number(illum.illuminatedFraction.toFixed(3)),
        separationDeg: Number(sep.toFixed(1)),
      },
      advice:
        horiz.altitude < 20
          ? 'Target low (<20°): expect atmospheric degradation.'
          : sep < 30 && moonHoriz.altitude > 0 && illum.illuminatedFraction > 0.4
            ? 'Moon is bright, close, and up: poor for broadband; use narrowband or wait.'
            : 'Reasonable conditions for imaging.',
    });
  },
};

export const planningTools: ToolDef[] = [moonInfo, targetVisibility];
