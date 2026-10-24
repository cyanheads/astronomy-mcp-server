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

/**
 * Bodies a two-body conjunction pairs: the Moon and the planets. The Sun is left out —
 * a body's conjunction with it is the one-body `conjunction` search, and the Moon's is
 * new moon — and so is Earth, which has no longitude seen from its own center.
 */
export const PAIR_BODY_NAMES = [
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

export type PairBodyName = (typeof PAIR_BODY_NAMES)[number];

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
  /** Angular distance from the Sun in degrees [0,180], seen from Earth's center. */
  sunElongationDegrees: number;
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

/** One forward rise/set search: its cycles, the Sun's night under way at the start, and where it stops. */
export interface RiseSetSearch {
  events: RiseSetEvent[];
  /**
   * Sun only: the preceding night when the first cycle's day begins after `start`. Bounded
   * by the preceding culmination (or a later sunset) and that day's sunrise or culmination.
   * Absent when the first cycle already owns the night. Not one of `events`.
   */
  nightInProgress?: TwilightSet;
  /** The instant the cycle loop would resume from — a continuation searched from here repeats and skips nothing. */
  resumeAt: Date;
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
  /**
   * Moon–Sun ecliptic-longitude difference in degrees [0,360): 0 new, 90 first quarter,
   * 180 full, 270 last quarter. Not the Sun–body–observer `SkyPosition.phaseAngleDegrees`.
   */
  phaseLongitudeDegrees: number;
  phaseName: string;
  timeLocal?: string;
  timeUtc: string;
}

/**
 * Eclipse contact phases, bare-named. A solar eclipse uses the five from `partial_begin`
 * to `partial_end`; a lunar eclipse adds the two penumbral contacts. `contacts` keys each
 * phase as `<phase>_utc`, `contactAltitudesDegrees` by the bare name.
 */
export type EclipsePhase =
  | 'penumbral_begin'
  | 'partial_begin'
  | 'total_begin'
  | 'peak'
  | 'total_end'
  | 'partial_end'
  | 'penumbral_end';

/** Discriminated event record. `event` is the discriminator; details vary. */
export interface EventRecord {
  /** Apsis classification. */
  apsisKind?: 'perigee' | 'apogee' | 'perihelion' | 'aphelion';
  /** Body the event pertains to (opposition/conjunction/elongation/apsis). */
  body?: string;
  /** Two-body conjunction only: the second body, in the order the caller named the pair. */
  body2?: string;
  /** Which conjunction an inner planet reaches with the Sun — inferior (near side) or superior (far side). */
  conjunctionKind?: 'inferior' | 'superior';
  /**
   * Refracted altitude in degrees of the eclipsed body (Sun for solar, Moon for lunar) at
   * each contact, keyed by phase; null for a phase that does not occur. Observer only.
   */
  contactAltitudesDegrees?: Partial<Record<EclipsePhase, number | null>>;
  /** Solar/lunar eclipse contact times (ISO 8601 UTC), present per eclipse phase. */
  contacts?: Record<string, string | null>;
  distanceAu?: number;
  distanceKm?: number;
  /** Greatest-elongation angle in degrees. */
  elongationDegrees?: number;
  event: EventName;
  /** Eclipse classification (solar/lunar). */
  kind?: string;
  /** Observer only: true when the eclipsed body is above the horizon at any contact. */
  localVisible?: boolean;
  /** Peak fraction of the disc obscured, when known (eclipses). */
  obscuration?: number | null;
  /** Global total/annular solar eclipse: geographic latitude of greatest eclipse. */
  peakLatitudeDegrees?: number;
  /** Global total/annular solar eclipse: geographic longitude of greatest eclipse. */
  peakLongitudeDegrees?: number;
  /** Moon quarter name. */
  quarter?: QuarterName;
  /**
   * Two-body conjunction only: the pair's angular separation in degrees, seen from Earth's
   * center at the conjunction instant. Not their closest approach, which for two planets
   * can fall days or weeks away and be degrees closer.
   */
  separationDegrees?: number;
  timeLocal?: string;
  timeUtc: string;
  /** Morning/evening apparition (max elongation). */
  visibility?: 'morning' | 'evening';
  /** Which equinox/solstice. */
  which?: 'march' | 'september' | 'june' | 'december';
}

/** One forward event search. `body`, `body2`, and `observer` apply to some classes only. */
export interface FindEventsOptions {
  /** Target body of a body-relative class. */
  body?: EventBodyName;
  /** Second body of a two-body conjunction; valid with `event: 'conjunction'` only. */
  body2?: PairBodyName;
  /** Occurrences to return; the search stops sooner at the end of the supported span. */
  count: number;
  /** Eclipse classes only: switches solar eclipses to local, and adds local circumstances. */
  observer?: ObserverInput;
  start: Date;
  /** IANA zone for `timeLocal`. */
  timezone?: string;
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
