/**
 * Lightweight astronomy math for session planning (Stage 20) — offline, no network.
 * Low-precision algorithms (Meeus-style) sufficient for framing/visibility/moon-avoidance,
 * NOT for astrometry. Angles in degrees unless noted.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const norm360 = (d: number): number => ((d % 360) + 360) % 360;
const sind = (d: number): number => Math.sin(d * D2R);
const cosd = (d: number): number => Math.cos(d * D2R);

/** Julian Day for a Date (UTC). */
export function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5;
}

/** Centuries since J2000.0 (TT≈UTC at this precision). */
function julianCenturies(date: Date): number {
  return (julianDay(date) - 2451545.0) / 36525;
}

/** Greenwich Mean Sidereal Time in degrees. */
export function gmstDeg(date: Date): number {
  const jd = julianDay(date);
  const d = jd - 2451545.0;
  const t = d / 36525;
  return norm360(280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000);
}

export interface EquatorialCoord {
  ra: number; // degrees
  dec: number; // degrees
}

/** Low-precision solar position (Meeus ch. 25), good to ~0.01°. */
export function sunPosition(date: Date): EquatorialCoord {
  const t = julianCenturies(date);
  const L0 = norm360(280.46646 + 36000.76983 * t + 0.0003032 * t * t);
  const M = norm360(357.52911 + 35999.05029 * t - 0.0001537 * t * t);
  const C =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * sind(M) +
    (0.019993 - 0.000101 * t) * sind(2 * M) +
    0.000289 * sind(3 * M);
  const trueLong = L0 + C;
  const eps = 23.439291 - 0.0130042 * t;
  const ra = norm360(Math.atan2(cosd(eps) * sind(trueLong), cosd(trueLong)) * R2D);
  const dec = Math.asin(sind(eps) * sind(trueLong)) * R2D;
  return { ra, dec };
}

/** Low-precision lunar position (Meeus ch. 47, principal terms), good to ~0.3°. */
export function moonPosition(date: Date): EquatorialCoord {
  const t = julianCenturies(date);
  const Lp = norm360(218.3164477 + 481267.88123421 * t);
  const D = norm360(297.8501921 + 445267.1114034 * t);
  const M = norm360(357.5291092 + 35999.0502909 * t);
  const Mp = norm360(134.9633964 + 477198.8675055 * t);
  const F = norm360(93.272095 + 483202.0175233 * t);

  const lon =
    Lp +
    6.288774 * sind(Mp) +
    1.274027 * sind(2 * D - Mp) +
    0.658314 * sind(2 * D) +
    0.213618 * sind(2 * Mp) -
    0.185116 * sind(M) -
    0.114332 * sind(2 * F);
  const lat =
    5.128122 * sind(F) +
    0.280602 * sind(Mp + F) +
    0.277693 * sind(Mp - F) +
    0.173237 * sind(2 * D - F);
  const eps = 23.439291 - 0.0130042 * t;

  const ra = norm360(
    Math.atan2(sind(lon) * cosd(eps) - Math.tan(lat * D2R) * sind(eps), cosd(lon)) * R2D,
  );
  const dec = Math.asin(sind(lat) * cosd(eps) + cosd(lat) * sind(eps) * sind(lon)) * R2D;
  return { ra, dec };
}

/** Illuminated fraction of the Moon (0=new, 1=full) + phase name + phase angle (deg). */
export function moonIllumination(date: Date): {
  illuminatedFraction: number;
  phaseAngle: number;
  phaseName: string;
  waxing: boolean;
} {
  const sun = sunPosition(date);
  const moon = moonPosition(date);
  // Geocentric elongation of the Moon from the Sun.
  const elong =
    Math.acos(
      sind(sun.dec) * sind(moon.dec) + cosd(sun.dec) * cosd(moon.dec) * cosd(sun.ra - moon.ra),
    ) * R2D;
  // Phase angle Sun-Moon-Earth ≈ 180 - elongation (Moon ~far vs Earth-Sun scale).
  const phaseAngle = 180 - elong;
  const illuminatedFraction = (1 + cosd(phaseAngle)) / 2;
  // Waxing if the Moon is east of the Sun in ecliptic longitude.
  const waxing = norm360(moon.ra - sun.ra) < 180;
  const f = illuminatedFraction;
  let phaseName: string;
  if (f < 0.03) phaseName = 'new';
  else if (f < 0.47) phaseName = waxing ? 'waxing crescent' : 'waning crescent';
  else if (f < 0.53) phaseName = waxing ? 'first quarter' : 'last quarter';
  else if (f < 0.97) phaseName = waxing ? 'waxing gibbous' : 'waning gibbous';
  else phaseName = 'full';
  return { illuminatedFraction, phaseAngle, phaseName, waxing };
}

export interface HorizontalCoord {
  altitude: number; // degrees above horizon
  azimuth: number; // degrees east of north
}

/** Equatorial → horizontal for an observer at (latDeg, lonDeg, +E) at the given instant. */
export function equatorialToHorizontal(
  eq: EquatorialCoord,
  latDeg: number,
  lonDeg: number,
  date: Date,
): HorizontalCoord {
  const lst = norm360(gmstDeg(date) + lonDeg);
  const H = norm360(lst - eq.ra); // hour angle in degrees
  const alt =
    Math.asin(sind(eq.dec) * sind(latDeg) + cosd(eq.dec) * cosd(latDeg) * cosd(H)) * R2D;
  const az =
    norm360(
      Math.atan2(-sind(H), cosd(latDeg) * Math.tan(eq.dec * D2R) - sind(latDeg) * cosd(H)) * R2D,
    );
  return { altitude: alt, azimuth: az };
}

/** Angular separation between two equatorial coords (degrees). */
export function angularSeparation(a: EquatorialCoord, b: EquatorialCoord): number {
  const cosSep =
    sind(a.dec) * sind(b.dec) + cosd(a.dec) * cosd(b.dec) * cosd(a.ra - b.ra);
  return Math.acos(Math.max(-1, Math.min(1, cosSep))) * R2D;
}

/** Parse an RA string ("HH MM SS", "HH:MM:SS", or decimal degrees) to degrees. */
export function parseRa(s: string | number): number | null {
  if (typeof s === 'number') return isFinite(s) ? norm360(s) : null;
  const parts = s.trim().split(/[\s:]+/).map(Number);
  if (parts.length === 3 && parts.every(isFinite)) {
    return norm360((parts[0]! + parts[1]! / 60 + parts[2]! / 3600) * 15);
  }
  const f = Number(s);
  return isFinite(f) ? norm360(f) : null;
}

/** Parse a Dec string ("+DD MM SS", "DD:MM:SS", or decimal degrees) to degrees. */
export function parseDec(s: string | number): number | null {
  if (typeof s === 'number') return isFinite(s) ? s : null;
  const t = s.trim();
  const sign = t.startsWith('-') ? -1 : 1;
  const parts = t.replace(/^[+-]/, '').split(/[\s:]+/).map(Number);
  if (parts.length === 3 && parts.every(isFinite)) {
    return sign * (parts[0]! + parts[1]! / 60 + parts[2]! / 3600);
  }
  const f = Number(t);
  return isFinite(f) ? f : null;
}
