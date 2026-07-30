/**
 * @fileoverview Domain types for the ephemeris compute layer — the wire contracts
 *   shared between the EphemerisService and the tool output schemas. Units are
 *   normalized here (degrees, sidereal hours, AU) so radians/raw engine values
 *   never reach a schema.
 * @module services/ephemeris/types
 */

/** Closed set of solar-system bodies the core computes, lower-cased on the wire. */
export const BODY_NAMES = [
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
] as const;

export type BodyName = (typeof BODY_NAMES)[number];

/**
 * Bodies astronomy_find_events accepts. Earth extends the shared set for the
 * `perigee_apogee` class only — it has heliocentric apsides (perihelion/aphelion)
 * but no observer-relative sky position, so position/rise-set/list-visible keep
 * the narrower `BODY_NAMES` enum and reject `earth` at the schema boundary.
 */
export const EVENT_BODY_NAMES = [...BODY_NAMES, 'earth'] as const;

export type EventBodyName = (typeof EVENT_BODY_NAMES)[number];

/** The nine consolidated event classes for astronomy_find_events. */
export const EVENT_NAMES = [
  'solar_eclipse',
  'lunar_eclipse',
  'equinox',
  'solstice',
  'moon_quarter',
  'opposition',
  'conjunction',
  'max_elongation',
  'perigee_apogee',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** Geographic observer + elevation. Maps 1:1 to astronomy-engine's Observer. */
export interface ObserverInput {
  elevation: number;
  latitude: number;
  longitude: number;
}

/** Equatorial coordinates, normalized to sidereal hours + degrees. */
export interface EquatorialCoords {
  decDegrees: number;
  distanceAu: number;
  raHours: number;
}

/** Refraction-corrected horizontal coordinates. */
export interface HorizontalCoords {
  aboveHorizon: boolean;
  altitudeDegrees: number;
  azimuthDegrees: number;
}

/** Ecliptic-of-date longitude/latitude in degrees. */
export interface EclipticCoords {
  latitudeDegrees: number;
  longitudeDegrees: number;
}

/** Constellation a point falls in. */
export interface ConstellationRef {
  abbreviation: string;
  name: string;
}

/** Full apparent position record for one body at one instant. */
export interface SkyPosition {
  angularDiameterArcsec: number | null;
  body: string;
  constellation: ConstellationRef;
  ecliptic: EclipticCoords;
  equatorial: EquatorialCoords;
  horizontal: HorizontalCoords;
  illuminatedFraction: number | null;
  magnitude: number | null;
  phaseAngleDegrees: number | null;
  timeLocal?: string;
  timeUtc: string;
}

/** A SkyPosition enriched for the "what's up" list. */
export interface VisibleBody extends SkyPosition {
  rank: number;
  visibilityNote: string;
}

/** Sky-condition gate derived from the Sun's altitude. */
export type SkyCondition =
  | 'daylight'
  | 'civil_twilight'
  | 'nautical_twilight'
  | 'astronomical_twilight'
  | 'dark';

export interface ListVisibleResult {
  bodies: VisibleBody[];
  skyCondition: SkyCondition;
  sunAltitudeDegrees: number;
}

/** One dawn/dusk pair for a twilight depth. */
export interface TwilightPair {
  dawnLocal?: string | null;
  dawnUtc: string | null;
  duskLocal?: string | null;
  duskUtc: string | null;
}

export interface TwilightSet {
  astronomical: TwilightPair;
  civil: TwilightPair;
  nautical: TwilightPair;
}

/** Rise / set / transit cycle for one body on one search window. */
export interface RiseSetEvent {
  note?: string;
  riseLocal?: string;
  riseUtc: string | null;
  setLocal?: string;
  setUtc: string | null;
  transitAltitudeDegrees: number | null;
  transitLocal?: string;
  transitUtc: string | null;
  twilight?: TwilightSet;
}

export type QuarterName = 'new' | 'first_quarter' | 'full' | 'last_quarter';

export interface QuarterEvent {
  quarter: QuarterName;
  timeLocal?: string;
  timeUtc: string;
}

export interface MoonPhaseResult {
  ageDays: number;
  illuminatedFraction: number;
  nextQuarters: QuarterEvent[];
  phaseAngleDegrees: number;
  phaseName: string;
  timeLocal?: string;
  timeUtc: string;
}

/** Discriminated event record. `event` is the discriminator; details vary. */
export interface EventRecord {
  /** Apsis classification. */
  apsisKind?: 'perigee' | 'apogee' | 'perihelion' | 'aphelion';
  /** Body the event pertains to (opposition/conjunction/elongation/apsis). */
  body?: string;
  /** Which conjunction an inner planet reaches — inferior (near side) or superior (far side). */
  conjunctionKind?: 'inferior' | 'superior';
  /** Solar/lunar eclipse contact times (ISO 8601 UTC), present per eclipse phase. */
  contacts?: Record<string, string | null>;
  distanceAu?: number;
  distanceKm?: number;
  /** Greatest-elongation angle in degrees. */
  elongationDegrees?: number;
  event: EventName;
  /** Eclipse classification (solar/lunar). */
  kind?: string;
  /** True when a solar eclipse is above the horizon for the observer at peak. */
  localVisible?: boolean;
  /** Peak fraction of the disc obscured, when known (eclipses). */
  obscuration?: number | null;
  /** Moon quarter name. */
  quarter?: QuarterName;
  timeLocal?: string;
  timeUtc: string;
  /** Morning/evening apparition (max elongation). */
  visibility?: 'morning' | 'evening';
  /** Which equinox/solstice. */
  which?: 'march' | 'september' | 'june' | 'december';
}

/** A bundled bright-star catalog entry, J2000 EQJ. */
export interface CatalogStar {
  /** Declination in degrees [-90,90], J2000. */
  decDegrees: number;
  /** Bayer / alternate designation, e.g. "Alpha Canis Majoris". */
  designation: string;
  /** Approximate distance in light-years (drives parallax). */
  distanceLightYears: number;
  /** Apparent visual magnitude. */
  magnitude: number;
  /** Canonical common name, e.g. "Sirius". */
  name: string;
  /** Right ascension in sidereal hours [0,24), J2000. */
  raHours: number;
}
