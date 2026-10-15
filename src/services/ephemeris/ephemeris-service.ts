/**
 * @fileoverview EphemerisService — the keyless, offline compute core. Wraps
 *   astronomy-engine plus the bundled bright-star catalog and owns all unit
 *   normalization (radians/sidereal-hours → degrees/hours), the angular-diameter
 *   computation, the phase-name / visibility-note derivations, timezone formatting,
 *   and DefineStar slot management. Pure computation — no upstream, no ctx.state,
 *   nothing crosses requests; the catalog loads once at module init. This is a
 *   server-as-service: given (body, time, observer) every method is deterministic.
 * @module services/ephemeris/ephemeris-service
 */

import { invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  AngleBetween,
  AngleFromSun,
  type Apsis,
  ApsisKind,
  type AstroTime,
  Body,
  Constellation,
  DefineStar,
  type EclipseEvent,
  Ecliptic,
  Equator,
  GeoVector,
  Horizon,
  type HourAngleEvent,
  Illumination,
  type LocalSolarEclipseInfo,
  type LunarEclipseInfo,
  MakeTime,
  MoonPhase,
  NextGlobalSolarEclipse,
  NextLocalSolarEclipse,
  NextLunarApsis,
  NextLunarEclipse,
  NextMoonQuarter,
  NextPlanetApsis,
  Observer,
  PairLongitude,
  Search,
  SearchAltitude,
  SearchGlobalSolarEclipse,
  SearchHourAngle,
  SearchLocalSolarEclipse,
  SearchLunarApsis,
  SearchLunarEclipse,
  SearchMaxElongation,
  SearchMoonPhase,
  SearchMoonQuarter,
  SearchPlanetApsis,
  SearchRelativeLongitude,
  SearchRiseSet,
  Seasons,
} from 'astronomy-engine';
import { BODY_META } from './body-data.js';
import { parseIsoInstant } from './iso-time.js';
import { CONSTELLATION_GENITIVES, GREEK_LETTER_NAMES, STAR_CATALOG } from './star-catalog.js';
import type {
  BodyName,
  CatalogStar,
  EclipsePhase,
  EventBodyName,
  EventName,
  EventRecord,
  FindEventsOptions,
  ListVisibleResult,
  MoonPhaseResult,
  ObserverInput,
  PairBodyName,
  QuarterEvent,
  QuarterName,
  RiseSetEvent,
  RiseSetSearch,
  SkyCondition,
  SkyPosition,
  TwilightPair,
  TwilightSet,
  VisibleBody,
} from './types.js';

/**
 * astronomy-engine's high-accuracy span, as inclusive UTC calendar years. `resolveTime()`
 * rejects an instant outside it, and every event search stops at its end.
 */
export const SUPPORTED_SPAN = { firstYear: 1900, lastYear: 2100 } as const;

/** First instant past the supported span; no event at or after it is returned. */
const SPAN_END = new Date(Date.UTC(SUPPORTED_SPAN.lastYear + 1, 0, 1));

/** Whether an event instant falls inside the supported span. */
const withinSpan = (date: Date): boolean => date < SPAN_END;

/** Kilometers per astronomical unit (astronomy-engine's KM_PER_AU). */
const KM_PER_AU = 149597870.69098932;

/** Minutes per day, for turning the engine's semi-durations into day offsets. */
const MINUTES_PER_DAY = 1440;

/**
 * Angular distance from the Sun, in degrees, inside which a body is reported lost in the
 * Sun's glare — a conventional naked-eye cutoff, inside which the planets are rarely seen
 * even from a twilit horizon.
 */
const GLARE_ELONGATION_DEG = 15;

/** Twilight depth boundaries in degrees of Sun altitude. */
const CIVIL_DEG = -6;
const NAUTICAL_DEG = -12;
const ASTRONOMICAL_DEG = -18;

/**
 * Forward window (days) for a single rise/set search. Two days captures the next
 * event at any normal latitude while flagging genuinely circumpolar bodies (whose
 * next rise/set is months away) as null — the explanatory-note path.
 */
const RISE_SET_WINDOW_DAYS = 2;

/** The step past a cycle's last event that the next cycle's search resumes from. */
const RESUME_STEP_MS = 1000;

/**
 * Shorter than any body's culmination-to-lower-culmination interval: half a sidereal day is
 * 11.97 h, the Sun's and Moon's are longer, and no planet's retrograde motion shortens one by
 * an hour. A rise or set this soon after a culmination is inside that culmination's day.
 */
const MIN_HALF_DAY_MS = 11 * 3_600_000;

/** The next rise, set, and culmination searched forward from one cursor. */
interface Crossings {
  /** The body is above the horizon at the cursor: the next set precedes the next rise. */
  alreadyUp: boolean;
  culmination: HourAngleEvent;
  rise: AstroTime | null;
  set: AstroTime | null;
}

/** One rise/set cycle before its twilight and local times are attached. */
interface DayCycle {
  /** Where the night this cycle carries is searched from: its rise, its culmination, or its cursor. */
  nightFrom: Date;
  note: string | undefined;
  /** The cursor the next cycle is searched from. */
  resume: () => Date;
  rise: AstroTime | null;
  set: AstroTime | null;
  transit: HourAngleEvent | null;
}

/** Longest synodic month, rounded up — the widest a new-moon look-back needs to be. */
const MAX_SYNODIC_MONTH_DAYS = 29.9;

/** Mean synodic month, for deriving an age from the phase longitude. */
const MEAN_SYNODIC_MONTH_DAYS = 29.530588;

/** The eight planets Earth can be in conjunction or opposition with. */
const PLANETS = [
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
] as const satisfies readonly EventBodyName[];

/** Inner planets — the only ones with a greatest elongation, and the only ones with two conjunctions. */
const INNER_PLANETS = new Set<EventBodyName>(['mercury', 'venus']);

/** Superior planets — the only ones that reach opposition. */
const SUPERIOR_PLANETS = new Set<EventBodyName>(PLANETS.filter((p) => !INNER_PLANETS.has(p)));

/**
 * Upper bound on how fast each pairable body's ecliptic longitude, seen from Earth's
 * center, changes — in degrees per day, either direction. Each is its 1900–2100 maximum
 * rounded up with a margin (Moon 15.40, Mercury 2.20, Venus 1.26, Mars 0.79, Jupiter
 * 0.242, Saturn 0.130, Uranus 0.063, Neptune 0.038, Pluto 0.041). Two bodies' longitude
 * offset can change no faster than the sum of their two bounds, which is what lets the
 * conjunction scan step over a stretch where the offset cannot reach zero.
 */
const MAX_LONGITUDE_RATE_DEG_PER_DAY: Record<PairBodyName, number> = {
  moon: 16.5,
  mercury: 2.5,
  venus: 1.5,
  mars: 1,
  jupiter: 0.3,
  saturn: 0.15,
  uranus: 0.08,
  neptune: 0.05,
  pluto: 0.05,
};

/**
 * Shortest step of the conjunction scan, in days. Consecutive conjunctions of one pair
 * are never closer than about 1.5 days in the supported span (Mercury–Venus), so a step
 * this short holds at most one.
 */
const PAIR_SCAN_MIN_STEP_DAYS = 1;

/** Whether a body can be one half of a two-body conjunction. */
const isPairBody = (body: EventBodyName): body is PairBodyName =>
  Object.hasOwn(MAX_LONGITUDE_RATE_DEG_PER_DAY, body);

/** Map a wire body name to the engine's Body enum. */
const BODY_ENUM: Record<EventBodyName, Body> = {
  sun: Body.Sun,
  moon: Body.Moon,
  earth: Body.Earth,
  mercury: Body.Mercury,
  venus: Body.Venus,
  mars: Body.Mars,
  jupiter: Body.Jupiter,
  saturn: Body.Saturn,
  uranus: Body.Uranus,
  neptune: Body.Neptune,
  pluto: Body.Pluto,
};

/** The eight DefineStar slots the engine exposes for user-defined stars. */
const STAR_SLOTS: Body[] = [
  Body.Star1,
  Body.Star2,
  Body.Star3,
  Body.Star4,
  Body.Star5,
  Body.Star6,
  Body.Star7,
  Body.Star8,
];

/** Options for the position computation when targeting a catalog star. */
interface StarTarget {
  meta: CatalogStar;
  slot: Body;
}

export class EphemerisService {
  /** Lower-cased common name → catalog entry, built once at construction. */
  private readonly starIndex: Map<string, CatalogStar>;
  /** Lower-cased designation → catalog entry, for Bayer-name lookups. */
  private readonly designationIndex: Map<string, CatalogStar>;

  constructor() {
    this.starIndex = new Map();
    this.designationIndex = new Map();
    for (const star of STAR_CATALOG) {
      this.starIndex.set(star.name.toLowerCase(), star);
      this.designationIndex.set(star.designation.toLowerCase(), star);
    }
  }

  // ---- Time + timezone helpers --------------------------------------------

  /**
   * Parse an optional ISO 8601 instant (defaults to now) into a JS Date,
   * validating against astronomy-engine's high-accuracy span (≈1900–2100).
   * Throws `invalidParams` with reason `invalid_time` when the string is not a
   * strict ISO 8601 instant or names a day that does not exist, and with reason
   * `time_out_of_range` outside the span.
   *
   * `invalid_time` carries its recovery hint inline: a throw-site hint wins over the one
   * a calling tool declares for the same reason in `errors[]`, so every caller hands the
   * client that same hint. `time_out_of_range` carries none: the next move depends on the
   * calling tool — which input field it exposes (`time` or `start`), and for satellite
   * passes the element set's epoch window — so the framework fills that tool's declared
   * recovery instead.
   */
  resolveTime(time?: string): Date {
    const date = time ? parseIsoInstant(time) : new Date();
    if (date === undefined) {
      throw invalidParams(
        `Invalid time "${time}". Expected an ISO 8601 instant naming a real calendar date, e.g. 2024-04-08T18:00:00Z.`,
        {
          reason: 'invalid_time',
          recovery: {
            hint: 'Pass the timestamp as an ISO 8601 UTC instant with a real calendar date, e.g. 2024-01-01T00:00:00Z, then retry.',
          },
        },
      );
    }
    const year = date.getUTCFullYear();
    const { firstYear, lastYear } = SUPPORTED_SPAN;
    if (year < firstYear || year > lastYear) {
      throw invalidParams(
        `Time ${date.toISOString()} is outside the high-accuracy span (${firstYear}–${lastYear}).`,
        { reason: 'time_out_of_range' },
      );
    }
    return date;
  }

  /**
   * Validate an IANA timezone (or fall back to undefined). Throws `invalidParams`
   * with reason `invalid_timezone` when the zone is unknown to the runtime.
   */
  resolveTimezone(timezone?: string): string | undefined {
    if (!timezone) return;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      return timezone;
    } catch {
      throw invalidParams(
        `Unknown timezone "${timezone}". Use an IANA zone, e.g. America/Los_Angeles.`,
        {
          reason: 'invalid_timezone',
          recovery: { hint: 'Pass a valid IANA timezone like America/Los_Angeles or UTC.' },
        },
      );
    }
  }

  /** Format a Date as an ISO 8601 string carrying the observer-local offset. */
  formatLocal(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    let hour = get('hour');
    if (hour === '24') hour = '00';
    const local = `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
    const offset = this.tzOffset(date, timezone);
    return `${local}${offset}`;
  }

  /** Compute the signed UTC offset string (e.g. "-07:00") for a zone at an instant. */
  private tzOffset(date: Date, timezone: string): string {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    const name = dtf.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value;
    if (name && /GMT[+-]/.test(name)) {
      const raw = name.replace('GMT', '');
      if (raw === '' || raw === '+0') return '+00:00';
      // Normalize "GMT-7" → "-07:00", "GMT-07:00" stays.
      const match = raw.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
      if (match?.[1] && match[2]) {
        const sign = match[1];
        const hh = match[2].padStart(2, '0');
        const mm = match[3] ?? '00';
        return `${sign}${hh}:${mm}`;
      }
    }
    return '+00:00';
  }

  // ---- Star resolution -----------------------------------------------------

  /**
   * Resolve a star name or Bayer designation (case- and spacing-insensitive) to a catalog
   * entry. A designation may spell the Greek letter out or write it as a symbol, and give
   * the constellation as its genitive or IAU abbreviation — `Alpha Canis Majoris`,
   * `Alpha CMa`, `α CMa`, and `α Canis Majoris` all resolve to Sirius. A miss throws
   * `star_not_found` listing every catalog star, in the message and as `catalog_stars`.
   */
  lookupStar(name: string): CatalogStar {
    const words = name.trim().toLowerCase().split(/\s+/);
    const hit =
      this.starIndex.get(words.join(' ')) ?? this.designationIndex.get(canonicalDesignation(words));
    if (!hit) {
      const catalogStars = STAR_CATALOG.map((s) => s.name);
      throw notFound(
        `Star "${name}" is not in the bundled catalog. It holds these ${catalogStars.length} stars: ${catalogStars.join(', ')}.`,
        {
          reason: 'star_not_found',
          recovery: {
            hint: 'Pick a star from the catalog this error lists, by common name or Bayer designation (e.g. "Sirius", "Alpha CMa", "α Canis Majoris"). A star outside the catalog cannot be located.',
          },
          catalog_stars: catalogStars,
        },
      );
    }
    return hit;
  }

  /** Allocate a DefineStar slot for one star and load its J2000 coordinates. */
  private defineStarTarget(star: CatalogStar, slotIndex = 0): StarTarget {
    const slot = STAR_SLOTS[slotIndex % STAR_SLOTS.length] ?? Body.Star1;
    DefineStar(slot, star.raHours, star.decDegrees, star.distanceLightYears);
    return { slot, meta: star };
  }

  // ---- Core position -------------------------------------------------------

  /**
   * Apparent topocentric position of a body (or catalog star) at one instant.
   * `bodyOrStar` is a BodyName for solar-system bodies, or a StarTarget when the
   * caller resolved a catalog star into a DefineStar slot.
   */
  position(
    target: { kind: 'body'; body: BodyName } | { kind: 'star'; star: StarTarget },
    observer: ObserverInput,
    date: Date,
    timezone?: string,
  ): SkyPosition {
    const obs = this.toObserver(observer);
    const time = MakeTime(date);
    const engineBody = target.kind === 'body' ? BODY_ENUM[target.body] : target.star.slot;
    const label = target.kind === 'body' ? target.body : target.star.meta.name;

    const eq = Equator(engineBody, time, obs, true, true);
    const hor = Horizon(time, obs, eq.ra, eq.dec, 'normal');
    // Constellation and ecliptic conversion expect J2000 (EQJ) coordinates.
    const eqj = Equator(engineBody, time, obs, false, false);
    const con = Constellation(eqj.ra, eqj.dec);
    const ecl = Ecliptic(eqj.vec);

    let magnitude: number | null = null;
    let angularDiameter: number | null = null;
    let phaseAngle: number | null = null;
    let illuminated: number | null = null;

    if (target.kind === 'body') {
      const radiusKm = BODY_META[target.body].meanRadiusKm;
      angularDiameter = angularDiameterArcsec(radiusKm, eq.dist);
      // Illumination is defined for the Sun, Moon, and planets — not Earth.
      try {
        const illum = Illumination(engineBody, time);
        magnitude = illum.mag;
        phaseAngle = illum.phase_angle;
        illuminated = illum.phase_fraction;
      } catch {
        // Leave magnitude/phase null when the engine can't compute them.
      }
    } else {
      magnitude = target.star.meta.magnitude;
    }

    const pos: SkyPosition = {
      body: label,
      timeUtc: time.toString(),
      equatorial: {
        raHours: eq.ra,
        decDegrees: eq.dec,
        distanceAu: eq.dist,
      },
      horizontal: {
        altitudeDegrees: hor.altitude,
        azimuthDegrees: hor.azimuth,
        aboveHorizon: hor.altitude > 0,
      },
      ecliptic: {
        longitudeDegrees: ecl.elon,
        latitudeDegrees: ecl.elat,
      },
      magnitude,
      angularDiameterArcsec: angularDiameter,
      phaseAngleDegrees: phaseAngle,
      illuminatedFraction: illuminated,
      // Defined for every target here — the engine rejects only Body.Earth, never a position() target.
      sunElongationDegrees: AngleFromSun(engineBody, time),
      constellation: { abbreviation: con.symbol, name: con.name },
    };
    if (timezone) pos.timeLocal = this.formatLocal(date, timezone);
    return pos;
  }

  // ---- Rise / set / transit + twilight ------------------------------------

  /** Rise/set/transit cycles for a body, searching forward from `start` — the cycles alone. */
  riseSet(
    body: BodyName,
    observer: ObserverInput,
    start: Date,
    count: number,
    timezone?: string,
  ): RiseSetEvent[] {
    return this.riseSetSearch(body, observer, start, count, timezone).events;
  }

  /**
   * Rise/set/transit cycles for a body, searching forward from `start`, plus where the search
   * stopped and — for the Sun when `start` falls at night — the night already under way.
   *
   * A cycle is one of the body's days: a culmination with the rise before it and the set after
   * it. A day with neither — the Sun's polar night or midnight sun, a day the Moon spends wholly
   * below or above the horizon — is a cycle of its own, never folded into a neighbour, so
   * consecutive cycles cover consecutive days. A Sun cycle also carries the night after its day,
   * which ends where the next cycle's day begins, so each night falls in exactly one cycle.
   */
  riseSetSearch(
    body: BodyName,
    observer: ObserverInput,
    start: Date,
    count: number,
    timezone?: string,
  ): RiseSetSearch {
    const obs = this.toObserver(observer);
    const target = BODY_ENUM[body];
    const isSun = body === 'sun';
    /**
     * The next rise from a cursor, searched once per cursor: a Sun cycle that closes with a set
     * looks ahead for the following sunrise to place its resume point, and the cycle resumed
     * there opens with that same search.
     */
    const rises = new Map<number, AstroTime | null>();
    const riseFrom = (cursor: Date): AstroTime | null => {
      const key = cursor.getTime();
      if (!rises.has(key)) {
        rises.set(key, SearchRiseSet(target, obs, +1, cursor, RISE_SET_WINDOW_DAYS));
      }
      return rises.get(key) ?? null;
    };
    const cycleAt = (cursor: Date, crossings = this.crossingsFrom(target, obs, cursor, riseFrom)) =>
      this.dayCycle(target, obs, cursor, crossings, isSun, riseFrom);

    const opening = this.crossingsFrom(target, obs, start, riseFrom);
    const firstRise = opening.alreadyUp ? null : opening.rise;
    const sunsetBefore =
      isSun && firstRise ? SearchRiseSet(Body.Sun, obs, -1, start, -RISE_SET_WINDOW_DAYS) : null;

    let cycle =
      (isSun ? this.restOfDarkDay(obs, start, opening, sunsetBefore) : undefined) ??
      cycleAt(start, opening);
    const opener = cycle;
    const cycles = [cycle];
    let resumeAt = cycle.resume();
    while (cycles.length < count) {
      cycle = cycleAt(resumeAt);
      cycles.push(cycle);
      resumeAt = cycle.resume();
    }

    /**
     * A Sun cycle's night runs from its own day to the start of the next cycle's: dusk after its
     * set (or, with no set, after its culmination) and dawn before the next cycle's rise or
     * culmination. The search stops there, so a depth this night never reaches is null rather
     * than a later night's time. The last cycle's night ends where the cycle a continuation from
     * `resumeAt` opens with begins, so a series served across calls splits its cycles' nights
     * exactly as one search does. `nightInProgress` is the exception: a continuation that
     * resumes past a set starts at night, so it reports again the night the last cycle carried.
     */
    const nightEnds = isSun
      ? [...cycles.slice(1).map((c) => c.nightFrom), cycleAt(resumeAt).nightFrom]
      : [];

    const events = cycles.map((c, i) => {
      const event: RiseSetEvent = {
        riseUtc: c.rise ? c.rise.toString() : null,
        setUtc: c.set ? c.set.toString() : null,
        transitUtc: c.transit ? c.transit.time.toString() : null,
        transitAltitudeDegrees: c.transit ? c.transit.hor.altitude : null,
      };
      if (c.note) event.note = c.note;
      const nightEnd = nightEnds[i];
      if (nightEnd) event.twilight = this.twilight(obs, c.nightFrom, nightEnd, timezone);
      if (timezone) {
        if (c.rise) event.riseLocal = this.formatLocal(c.rise.date, timezone);
        if (c.set) event.setLocal = this.formatLocal(c.set.date, timezone);
        if (c.transit) event.transitLocal = this.formatLocal(c.transit.time.date, timezone);
      }
      return event;
    });

    const search: RiseSetSearch = { events, resumeAt };
    /**
     * A search that opens with a rise means the Sun was below the horizon at `start`, so the
     * cycles begin at the next sunrise and their twilight is the night after it. The night under
     * way is reported on its own, from the sunset that began it to where the first cycle's night
     * begins — that sunrise, or the culmination of a day the Sun does not rise on; times in it
     * before `start` have passed but stay, so null keeps meaning only "this night never reaches
     * the depth". The sunset counts only when it follows the Sun's last culmination before
     * `start`. A sunset before that culmination began an earlier night: a day the Sun did not
     * rise on has come between, and the night under way began at its culmination, not at a
     * sunset. That night is omitted, as is one with no sunset in the look-back window (the end of
     * a polar night) or no sunrise in the forward window (its beginning); before that day's lower
     * culmination the rest-of-day first cycle carries it instead.
     */
    if (
      firstRise &&
      sunsetBefore &&
      sunsetBefore.date > SearchHourAngle(Body.Sun, obs, 0, start, -1).time.date
    ) {
      search.nightInProgress = this.twilight(obs, sunsetBefore.date, opener.nightFrom, timezone);
    }
    return search;
  }

  /** The next rise, set, and culmination searched forward from one cursor. */
  private crossingsFrom(
    target: Body,
    obs: Observer,
    cursor: Date,
    riseFrom: (cursor: Date) => AstroTime | null,
  ): Crossings {
    const rise = riseFrom(cursor);
    const set = SearchRiseSet(target, obs, -1, cursor, RISE_SET_WINDOW_DAYS);
    return {
      rise,
      set,
      /**
       * Both searches run forward from the cursor, so when the body is already up the next set
       * arrives before the next rise and the two belong to different cycles — pairing them
       * reports a set hours before its own rise. The interval in progress is the one the caller
       * is standing in, and its rise is behind the cursor where a forward-only search cannot
       * reach it, so that interval is reported as a partial cycle naming the imminent set.
       * Beginning at the next complete cycle instead would be chronologically tidy and quietly
       * drop tonight's set, which is the event a caller asking during the day most needs.
       */
      alreadyUp: set !== null && (rise === null || set.date < rise.date),
      culmination: SearchHourAngle(target, obs, 0, cursor, +1),
    };
  }

  /**
   * The cycle that opens at `cursor`: the day of the next culmination, or — when the body is
   * already up — the interval in progress.
   */
  private dayCycle(
    target: Body,
    obs: Observer,
    cursor: Date,
    crossings: Crossings,
    isSun: boolean,
    riseFrom: (cursor: Date) => AstroTime | null,
  ): DayCycle {
    const { alreadyUp, culmination } = crossings;
    const noon = culmination.time;
    const pastMidnight = () => this.pastLowerCulmination(target, obs, noon);
    const next = alreadyUp ? crossings.set : crossings.rise;

    /**
     * No crossing inside the search window, or the first one belongs to a later day: the body
     * neither rises nor sets on this culmination's day. That day is a cycle of its own — taking
     * the later day's crossing here instead folded this day into it and dropped it. Its night is
     * the one after its culmination, where a set would have put it.
     */
    if (next === null || this.inLaterDay(target, obs, noon, next, alreadyUp ? 'set' : 'rise')) {
      return {
        rise: null,
        set: null,
        transit: culmination,
        note:
          culmination.hor.altitude > 0
            ? 'Circumpolar — never sets at this latitude/date.'
            : 'Never rises above the horizon at this latitude/date.',
        nightFrom: noon.date,
        resume: pastMidnight,
      };
    }

    const rise = alreadyUp ? null : crossings.rise;
    const set =
      crossings.set && (alreadyUp || !this.inLaterDay(target, obs, noon, crossings.set, 'set'))
        ? crossings.set
        : null;
    /**
     * The meridian crossing is found regardless of altitude, so the next one after the cursor
     * can belong to a neighbouring cycle — before this cycle's rise, or after its set. Report it
     * only when it falls inside the interval it is attached to.
     */
    const inside =
      (rise === null || noon.date > rise.date) && (set === null || noon.date < set.date);
    return {
      rise,
      set,
      transit: inside ? culmination : null,
      note:
        rise === null
          ? 'Already above the horizon when this cycle opens — no rise in this cycle.'
          : set === null
            ? 'Does not set before the next rise — circumpolar window.'
            : undefined,
      nightFrom: rise?.date ?? cursor,
      resume: set ? () => this.pastSet(target, obs, set, isSun, riseFrom) : pastMidnight,
    };
  }

  /**
   * The rest of a dark day, as the first cycle of a Sun search: `start` falls after the day's
   * culmination, the Sun is below the horizon, and nothing else would carry the night that
   * follows — a polar-night afternoon, or the evening of the last sunset before a polar night.
   * Neither has a sunrise ahead that opens the next cycle within a day, so without this cycle
   * the night under way falls between the cycles. Its night runs from the day's culmination,
   * so a dusk `start` has already passed is kept, as `nightInProgress` keeps passed times. A
   * rise before the day's lower culmination means the day is not dark for its rest — near the
   * pole at an equinox the Sun can rise and set again after a culmination below the horizon —
   * so the ordinary cycle from `start` reports them instead.
   */
  private restOfDarkDay(
    obs: Observer,
    start: Date,
    crossings: Crossings,
    sunsetBefore: AstroTime | null,
  ): DayCycle | undefined {
    const { alreadyUp, rise, culmination } = crossings;
    if (alreadyUp || (rise === null && culmination.hor.altitude > 0)) return;
    const midnight = SearchHourAngle(Body.Sun, obs, 12, start, +1).time;
    // A lower culmination before the next culmination means `start` is past this day's.
    if (midnight.date > culmination.time.date) return;
    if (rise !== null && rise.date < midnight.date) return;
    const noon = SearchHourAngle(Body.Sun, obs, 0, start, -1).time;
    // An ordinary evening: the sunrise ahead opens the next cycle and nightInProgress carries this night.
    if (rise !== null && sunsetBefore !== null && sunsetBefore.date > noon.date) return;
    return {
      rise: null,
      set: null,
      transit: null,
      note: 'Below the horizon for the rest of a day whose culmination precedes the search start: no rise, set, or transit remains, and the twilight is the night that follows it.',
      nightFrom: noon.date,
      resume: () => new Date(midnight.date.getTime() + RESUME_STEP_MS),
    };
  }

  /**
   * Whether a rise or set found after a culmination belongs to a later day than that
   * culmination's. A rise opens the day whose culmination follows it, so one past this day's
   * lower culmination opens a later day; a set closes the day whose culmination precedes it,
   * so only one past the next culmination does.
   */
  private inLaterDay(
    target: Body,
    obs: Observer,
    noon: AstroTime,
    crossing: AstroTime,
    kind: 'rise' | 'set',
  ): boolean {
    if (crossing.date.getTime() - noon.date.getTime() < MIN_HALF_DAY_MS) return false;
    const midnight = SearchHourAngle(target, obs, 12, noon, +1).time;
    if (crossing.date <= midnight.date) return false;
    return (
      kind === 'rise' || crossing.date > SearchHourAngle(target, obs, 0, midnight, +1).time.date
    );
  }

  /**
   * Resume just past a cycle's set, so the next search finds the following rise and the set
   * that closes it. Advancing a whole day from the rise instead overshot the next day's set
   * for any body that rises earlier each day, dropping a full cycle from a multi-count call.
   * A sunset with no sunrise in the window after it is the last before a polar night: resuming
   * past that day's lower culmination keeps a continuation from opening on the same evening,
   * which `restOfDarkDay` would report again as the rest of that day.
   */
  private pastSet(
    target: Body,
    obs: Observer,
    set: AstroTime,
    isSun: boolean,
    riseFrom: (cursor: Date) => AstroTime | null,
  ): Date {
    const next = new Date(set.date.getTime() + RESUME_STEP_MS);
    return isSun && riseFrom(next) === null ? this.pastLowerCulmination(target, obs, next) : next;
  }

  /**
   * Resume just past the lower culmination after `from`, where a cycle with no set ends: the
   * next culmination is then the next day's, and any rise on that day still lies ahead.
   * Stepping a fixed 24 h instead drifts against the culminations — the Moon's come about 50
   * minutes later each day, a planet's about 4 minutes earlier — so one culmination came back
   * in two cycles, or one was stepped over.
   */
  private pastLowerCulmination(target: Body, obs: Observer, from: AstroTime | Date): Date {
    const midnight = SearchHourAngle(target, obs, 12, from, +1).time;
    return new Date(midnight.date.getTime() + RESUME_STEP_MS);
  }

  /**
   * Civil/nautical/astronomical dawn+dusk pairs for the Sun, searched forward from `start` and
   * stopping at `until` — the sunrise, or the culmination of a day without one, that ends the
   * night the pairs belong to — so a depth that night never reaches comes back null.
   */
  private twilight(obs: Observer, start: Date, until: Date, timezone?: string): TwilightSet {
    const limitDays = (until.getTime() - start.getTime()) / 86_400_000;
    const pair = (altitude: number): TwilightPair => {
      // Dawn = Sun ascending (+1) through the altitude; dusk = descending (-1).
      const dawn = SearchAltitude(Body.Sun, obs, +1, start, limitDays, altitude);
      const dusk = SearchAltitude(Body.Sun, obs, -1, start, limitDays, altitude);
      const out: TwilightPair = {
        dawnUtc: dawn ? dawn.toString() : null,
        duskUtc: dusk ? dusk.toString() : null,
      };
      if (timezone) {
        out.dawnLocal = dawn ? this.formatLocal(dawn.date, timezone) : null;
        out.duskLocal = dusk ? this.formatLocal(dusk.date, timezone) : null;
      }
      return out;
    };
    return {
      civil: pair(CIVIL_DEG),
      nautical: pair(NAUTICAL_DEG),
      astronomical: pair(ASTRONOMICAL_DEG),
    };
  }

  // ---- Moon phase ----------------------------------------------------------

  /** Moon phase, illumination, age, and the next four quarter phases. */
  moonPhase(date: Date, timezone?: string): MoonPhaseResult {
    const time = MakeTime(date);
    const phaseLongitude = MoonPhase(time);
    const illum = Illumination(Body.Moon, time);

    // Age = days since the previous new moon. New moon is phase longitude 0; search
    // backward by stepping to the prior new-moon longitude crossing.
    const ageDays = this.moonAgeDays(time);

    const quarters: QuarterEvent[] = [];
    let mq = SearchMoonQuarter(time.date);
    for (let i = 0; i < 4; i++) {
      const q: QuarterEvent = {
        quarter: quarterName(mq.quarter),
        timeUtc: mq.time.toString(),
      };
      if (timezone) q.timeLocal = this.formatLocal(mq.time.date, timezone);
      quarters.push(q);
      mq = NextMoonQuarter(mq);
    }

    const result: MoonPhaseResult = {
      timeUtc: time.toString(),
      phaseLongitudeDegrees: phaseLongitude,
      illuminatedFraction: illum.phase_fraction,
      phaseName: phaseNameFromLongitude(phaseLongitude),
      ageDays,
      nextQuarters: quarters,
    };
    if (timezone) result.timeLocal = this.formatLocal(date, timezone);
    return result;
  }

  /** Days since the most recent new moon (synodic age). */
  private moonAgeDays(time: ReturnType<typeof MakeTime>): number {
    // SearchMoonPhase scans forward and returns the FIRST crossing in its window, so
    // one search over the look-back window yields the new moon *before* the most
    // recent one whenever the age is under ~1.5 days. A window one synodic month long
    // holds at most two new moons, so search again past the first and measure from
    // the later of the two that is still in the past.
    const window = MAX_SYNODIC_MONTH_DAYS + 1;
    const first = SearchMoonPhase(0, time.AddDays(-MAX_SYNODIC_MONTH_DAYS).date, window);
    if (!first || first.ut > time.ut) {
      // Fallback: derive the age from the phase longitude if the search overshoots.
      return (MoonPhase(time) / 360) * MEAN_SYNODIC_MONTH_DAYS;
    }
    const second = SearchMoonPhase(0, first.AddDays(1).date, window);
    const latest = second && second.ut <= time.ut ? second : first;
    return time.ut - latest.ut;
  }

  // ---- Events --------------------------------------------------------------

  /**
   * Search forward for the next `count` occurrences of an event class. Every search stops
   * at the end of the supported span, which is the only reason fewer than `count` come back.
   * An observer adds local circumstances to either eclipse class, and for solar eclipses it
   * switches the search from global to observer-local. `body2` turns a conjunction with
   * the Sun into a conjunction of two bodies, and is rejected on every other class.
   */
  findEvents(event: EventName, opts: FindEventsOptions): EventRecord[] {
    if (opts.body2 !== undefined && event !== 'conjunction') {
      throw invalidBodyPair(`body2 applies only to the conjunction event, not "${event}".`);
    }
    switch (event) {
      case 'equinox':
      case 'solstice':
        return this.seasonEvents(event, opts.start, opts.count, opts.timezone);
      case 'moon_quarter':
        return this.moonQuarterEvents(opts.start, opts.count, opts.timezone);
      case 'lunar_eclipse':
        return this.lunarEclipseEvents(opts.start, opts.count, opts.observer, opts.timezone);
      case 'solar_eclipse':
        return this.solarEclipseEvents(opts.start, opts.count, opts.observer, opts.timezone);
      case 'opposition':
      case 'conjunction':
        if (opts.body2 !== undefined) {
          return this.pairConjunctionEvents(
            ...resolvePair(opts.body, opts.body2),
            opts.start,
            opts.count,
            opts.timezone,
          );
        }
        return this.relativeLongitudeEvents(
          event,
          resolveBody(event, opts.body),
          opts.start,
          opts.count,
          opts.timezone,
        );
      case 'max_elongation':
        return this.maxElongationEvents(
          resolveBody(event, opts.body),
          opts.start,
          opts.count,
          opts.timezone,
        );
      case 'perigee_apogee':
        return this.apsisEvents(
          resolveBody(event, opts.body),
          opts.start,
          opts.count,
          opts.timezone,
        );
    }
  }

  private seasonEvents(
    event: 'equinox' | 'solstice',
    start: Date,
    count: number,
    timezone?: string,
  ): EventRecord[] {
    const out: EventRecord[] = [];
    for (
      let year = start.getUTCFullYear();
      year <= SUPPORTED_SPAN.lastYear && out.length < count;
      year++
    ) {
      const s = Seasons(year);
      const candidates: Array<{ which: NonNullable<EventRecord['which']>; time: Date }> =
        event === 'equinox'
          ? [
              { which: 'march', time: s.mar_equinox.date },
              { which: 'september', time: s.sep_equinox.date },
            ]
          : [
              { which: 'june', time: s.jun_solstice.date },
              { which: 'december', time: s.dec_solstice.date },
            ];
      for (const c of candidates) {
        if (c.time >= start && out.length < count) {
          const rec: EventRecord = { event, timeUtc: c.time.toISOString(), which: c.which };
          if (timezone) rec.timeLocal = this.formatLocal(c.time, timezone);
          out.push(rec);
        }
      }
    }
    return out;
  }

  private moonQuarterEvents(start: Date, count: number, timezone?: string): EventRecord[] {
    const out: EventRecord[] = [];
    let mq = SearchMoonQuarter(start);
    for (let i = 0; i < count && withinSpan(mq.time.date); i++) {
      const rec: EventRecord = {
        event: 'moon_quarter',
        timeUtc: mq.time.toString(),
        quarter: quarterName(mq.quarter),
      };
      if (timezone) rec.timeLocal = this.formatLocal(mq.time.date, timezone);
      out.push(rec);
      mq = NextMoonQuarter(mq);
    }
    return out;
  }

  /**
   * Lunar eclipses. The contact times are geocentric — the same instants everywhere — so
   * an observer changes nothing but adds local circumstances: the Moon's altitude at each
   * contact, and whether it is up for any of them.
   */
  private lunarEclipseEvents(
    start: Date,
    count: number,
    observer?: ObserverInput,
    timezone?: string,
  ): EventRecord[] {
    const obs = observer ? this.toObserver(observer) : undefined;
    const out: EventRecord[] = [];
    let ecl: LunarEclipseInfo = SearchLunarEclipse(start);
    for (let i = 0; i < count && withinSpan(ecl.peak.date); i++) {
      const peak = ecl.peak;
      /**
       * The contact one semi-duration before (-1) or after (+1) the peak. A phase this
       * eclipse never reaches has a zero semi-duration and no contact.
       */
      const contact = (sign: -1 | 1, semiDurationMinutes: number) =>
        semiDurationMinutes > 0
          ? peak.AddDays((sign * semiDurationMinutes) / MINUTES_PER_DAY)
          : undefined;
      const contacts: EclipseContacts<AstroTime> = [
        ['penumbral_begin', contact(-1, ecl.sd_penum)],
        ['partial_begin', contact(-1, ecl.sd_partial)],
        ['total_begin', contact(-1, ecl.sd_total)],
        ['peak', peak],
        ['total_end', contact(1, ecl.sd_total)],
        ['partial_end', contact(1, ecl.sd_partial)],
        ['penumbral_end', contact(1, ecl.sd_penum)],
      ];
      const rec: EventRecord = {
        event: 'lunar_eclipse',
        timeUtc: peak.toString(),
        kind: ecl.kind,
        obscuration: ecl.obscuration,
        contacts: contactTimes(contacts),
        ...(obs
          ? localCircumstances(
              contacts.map(([phase, time]) => [
                phase,
                time && this.altitudeDegrees(Body.Moon, obs, time),
              ]),
            )
          : {}),
      };
      if (timezone) rec.timeLocal = this.formatLocal(peak.date, timezone);
      out.push(rec);
      ecl = NextLunarEclipse(peak);
    }
    return out;
  }

  /**
   * Solar eclipses. With an observer the search is local — `SearchLocalSolarEclipse` only
   * returns eclipses with the Sun up at first or last contact — and each record carries
   * the Sun's altitude at every contact. Without one it is global: kind, peak time,
   * obscuration, and where on Earth a total or annular eclipse is greatest.
   */
  private solarEclipseEvents(
    start: Date,
    count: number,
    observer?: ObserverInput,
    timezone?: string,
  ): EventRecord[] {
    const out: EventRecord[] = [];
    if (observer) {
      const obs = this.toObserver(observer);
      let ecl: LocalSolarEclipseInfo = SearchLocalSolarEclipse(start, obs);
      for (let i = 0; i < count && withinSpan(ecl.peak.time.date); i++) {
        const peakTime = ecl.peak.time;
        const contacts: EclipseContacts<EclipseEvent> = [
          ['partial_begin', ecl.partial_begin],
          ['total_begin', ecl.total_begin],
          ['peak', ecl.peak],
          ['total_end', ecl.total_end],
          ['partial_end', ecl.partial_end],
        ];
        const rec: EventRecord = {
          event: 'solar_eclipse',
          timeUtc: peakTime.toString(),
          kind: ecl.kind,
          obscuration: ecl.obscuration,
          contacts: contactTimes(contacts.map(([phase, contact]) => [phase, contact?.time])),
          ...localCircumstances(contacts.map(([phase, contact]) => [phase, contact?.altitude])),
        };
        if (timezone) rec.timeLocal = this.formatLocal(peakTime.date, timezone);
        out.push(rec);
        ecl = NextLocalSolarEclipse(peakTime, obs);
      }
    } else {
      let ecl = SearchGlobalSolarEclipse(start);
      for (let i = 0; i < count && withinSpan(ecl.peak.date); i++) {
        const rec: EventRecord = {
          event: 'solar_eclipse',
          timeUtc: ecl.peak.toString(),
          kind: ecl.kind,
          obscuration: ecl.obscuration ?? null,
          contacts: { peak_utc: ecl.peak.toString() },
        };
        // The engine leaves both undefined for a partial eclipse, whose axis misses Earth.
        if (ecl.latitude !== undefined && ecl.longitude !== undefined) {
          rec.peakLatitudeDegrees = ecl.latitude;
          rec.peakLongitudeDegrees = ecl.longitude;
        }
        if (timezone) rec.timeLocal = this.formatLocal(ecl.peak.date, timezone);
        out.push(rec);
        ecl = NextGlobalSolarEclipse(ecl.peak);
      }
    }
    return out;
  }

  private relativeLongitudeEvents(
    event: 'opposition' | 'conjunction',
    body: EventBodyName,
    start: Date,
    count: number,
    timezone?: string,
  ): EventRecord[] {
    // SearchRelativeLongitude takes the body's ecliptic longitude relative to Earth's
    // as seen from the Sun: 0 puts them on the same side (opposition for a superior
    // planet, inferior conjunction for an inner one) and 180 puts them across the Sun
    // from each other (conjunction). Mercury and Venus reach both conjunctions each
    // synodic period, so interleave the two searches and take whichever comes first.
    const targets: Array<{ relativeLongitude: number; kind?: 'inferior' | 'superior' }> =
      event === 'opposition'
        ? [{ relativeLongitude: 0 }]
        : INNER_PLANETS.has(body)
          ? [
              { relativeLongitude: 0, kind: 'inferior' },
              { relativeLongitude: 180, kind: 'superior' },
            ]
          : [{ relativeLongitude: 180 }];

    /** Earliest occurrence at or after `from` across the target longitudes. */
    const nextOccurrence = (from: Date) =>
      targets
        .map((target) => ({
          kind: target.kind,
          time: SearchRelativeLongitude(BODY_ENUM[body], target.relativeLongitude, from),
        }))
        .reduce((earliest, candidate) =>
          candidate.time.ut < earliest.time.ut ? candidate : earliest,
        );

    const out: EventRecord[] = [];
    let cursor = start;
    for (let i = 0; i < count; i++) {
      const next = nextOccurrence(cursor);
      if (!withinSpan(next.time.date)) break;
      const rec: EventRecord = { event, timeUtc: next.time.toString(), body };
      if (next.kind) rec.conjunctionKind = next.kind;
      if (timezone) rec.timeLocal = this.formatLocal(next.time.date, timezone);
      out.push(rec);
      // Step past this event by a few days to find the next.
      cursor = next.time.AddDays(5).date;
    }
    return out;
  }

  /**
   * Conjunctions of two bodies: the instants they share an ecliptic longitude seen from
   * Earth's center. The longitude offset is sampled forward and each zero crossing refined
   * with `Search`. Each step lasts as long as the offset cannot reach zero at the pair's
   * fastest combined motion, and never less than `PAIR_SCAN_MIN_STEP_DAYS`, so a step holds
   * at most one conjunction.
   */
  private pairConjunctionEvents(
    body: PairBodyName,
    body2: PairBodyName,
    start: Date,
    count: number,
    timezone?: string,
  ): EventRecord[] {
    const [b1, b2] = [BODY_ENUM[body], BODY_ENUM[body2]];
    const maxRate = MAX_LONGITUDE_RATE_DEG_PER_DAY[body] + MAX_LONGITUDE_RATE_DEG_PER_DAY[body2];
    /** `body`'s longitude minus `body2`'s in (−180°, 180°]: 0 at conjunction, ±180 opposite. */
    const offset = (t: AstroTime) => {
      const d = PairLongitude(b1, b2, t);
      return d > 180 ? d - 360 : d;
    };

    const end = MakeTime(SPAN_END);
    const out: EventRecord[] = [];
    let t1 = MakeTime(start);
    let f1 = offset(t1);
    while (out.length < count && t1.ut < end.ut) {
      const t2 = t1.AddDays(Math.max(PAIR_SCAN_MIN_STEP_DAYS, Math.abs(f1) / maxRate));
      const f2 = offset(t2);
      // A sign change smaller than 180° passes through 0; a larger one is the wrap at ±180°.
      if (f1 < 0 !== f2 < 0 && Math.abs(f1 - f2) < 180) {
        const rising = f1 < 0;
        const time = Search((t) => (rising ? offset(t) : -offset(t)), t1, t2);
        if (!time) throw new Error(`Conjunction search found no crossing between ${t1} and ${t2}.`);
        if (!withinSpan(time.date)) break;
        const rec: EventRecord = {
          event: 'conjunction',
          timeUtc: time.toString(),
          body,
          body2,
          separationDegrees: AngleBetween(GeoVector(b1, time, true), GeoVector(b2, time, true)),
        };
        if (timezone) rec.timeLocal = this.formatLocal(time.date, timezone);
        out.push(rec);
      }
      t1 = t2;
      f1 = f2;
    }
    return out;
  }

  private maxElongationEvents(
    body: EventBodyName,
    start: Date,
    count: number,
    timezone?: string,
  ): EventRecord[] {
    const out: EventRecord[] = [];
    let cursor = start;
    for (let i = 0; i < count; i++) {
      const e = SearchMaxElongation(BODY_ENUM[body], cursor);
      if (!withinSpan(e.time.date)) break;
      const rec: EventRecord = {
        event: 'max_elongation',
        timeUtc: e.time.toString(),
        body,
        elongationDegrees: e.elongation,
        visibility: e.visibility === 'morning' ? 'morning' : 'evening',
      };
      if (timezone) rec.timeLocal = this.formatLocal(e.time.date, timezone);
      out.push(rec);
      cursor = e.time.AddDays(20).date;
    }
    return out;
  }

  private apsisEvents(
    body: EventBodyName,
    start: Date,
    count: number,
    timezone?: string,
  ): EventRecord[] {
    // The Moon orbits Earth (perigee/apogee); every other supported body — Earth
    // included — orbits the Sun, so its apsides are perihelion/aphelion.
    const out: EventRecord[] = [];
    const isMoon = body === 'moon';
    let apsis: Apsis = isMoon ? SearchLunarApsis(start) : SearchPlanetApsis(BODY_ENUM[body], start);
    for (let i = 0; i < count && withinSpan(apsis.time.date); i++) {
      const near = apsis.kind === ApsisKind.Pericenter;
      const apsisKind: EventRecord['apsisKind'] = isMoon
        ? near
          ? 'perigee'
          : 'apogee'
        : near
          ? 'perihelion'
          : 'aphelion';
      const rec: EventRecord = {
        event: 'perigee_apogee',
        timeUtc: apsis.time.toString(),
        body,
        apsisKind,
        distanceKm: apsis.dist_km,
        distanceAu: apsis.dist_au,
      };
      if (timezone) rec.timeLocal = this.formatLocal(apsis.time.date, timezone);
      out.push(rec);
      apsis = isMoon ? NextLunarApsis(apsis) : NextPlanetApsis(BODY_ENUM[body], apsis);
    }
    return out;
  }

  // ---- list_visible --------------------------------------------------------

  /** Iterate naked-eye bodies (+ optional catalog stars), filter above-horizon, rank. */
  listVisible(
    observer: ObserverInput,
    date: Date,
    opts: { minAltitude: number; includeStars: boolean; timezone?: string },
  ): ListVisibleResult {
    const obs = this.toObserver(observer);
    const time = MakeTime(date);

    // Sun-altitude gate first — drives the sky condition.
    const sunEq = Equator(Body.Sun, time, obs, true, true);
    const sunHor = Horizon(time, obs, sunEq.ra, sunEq.dec, 'normal');
    const sunAlt = sunHor.altitude;
    const skyCondition = skyConditionFromSunAltitude(sunAlt);

    const candidates: SkyPosition[] = [];

    // Naked-eye solar-system bodies only — the tool advertises a naked-eye surface,
    // so skip telescopic bodies (Uranus, Neptune, Pluto are marked nakedEye:false).
    // The Sun is nakedEye:true, so daytime answers stay honest.
    for (const body of Object.keys(BODY_META) as BodyName[]) {
      if (!BODY_META[body].nakedEye) continue;
      const pos = this.position({ kind: 'body', body }, observer, date, opts.timezone);
      if (pos.horizontal.altitudeDegrees >= opts.minAltitude) candidates.push(pos);
    }

    if (opts.includeStars) {
      // Allocate slots from the catalog up to the eight available; for the rest,
      // reuse slot 0 sequentially since each position() call is independent.
      let slotIndex = 0;
      for (const star of STAR_CATALOG) {
        const target = this.defineStarTarget(star, slotIndex % STAR_SLOTS.length);
        slotIndex += 1;
        const pos = this.position({ kind: 'star', star: target }, observer, date, opts.timezone);
        if (pos.horizontal.altitudeDegrees >= opts.minAltitude) candidates.push(pos);
      }
    }

    // Rank brightest-and-highest first: sort by magnitude ascending (brighter = lower),
    // breaking ties by altitude descending. Null magnitudes sort last.
    candidates.sort((a, b) => {
      const am = a.magnitude ?? 99;
      const bm = b.magnitude ?? 99;
      if (am !== bm) return am - bm;
      return b.horizontal.altitudeDegrees - a.horizontal.altitudeDegrees;
    });

    const bodies: VisibleBody[] = candidates.map((pos, idx) => ({
      ...pos,
      rank: idx + 1,
      visibilityNote: visibilityNote(pos, skyCondition),
    }));

    return { bodies, skyCondition, sunAltitudeDegrees: sunAlt };
  }

  /** Resolve a single named star into a DefineStar slot for get_sky_position. */
  resolveStarTarget(name: string): StarTarget {
    return this.defineStarTarget(this.lookupStar(name), 0);
  }

  // ---- Internal ------------------------------------------------------------

  private toObserver(o: ObserverInput): Observer {
    return new Observer(o.latitude, o.longitude, o.elevation);
  }

  /**
   * Apparent topocentric altitude of a body, refraction-corrected — the same computation
   * `position()` reports and astronomy-engine uses for a local solar eclipse's contacts.
   */
  private altitudeDegrees(body: Body, obs: Observer, time: AstroTime): number {
    const eq = Equator(body, time, obs, true, true);
    return Horizon(time, obs, eq.ra, eq.dec, 'normal').altitude;
  }
}

// --- Pure helpers (module-level, no service state) -------------------------

/** Angular diameter in arcseconds from a body radius (km) and distance (AU). */
function angularDiameterArcsec(radiusKm: number, distanceAu: number): number {
  const distanceKm = distanceAu * KM_PER_AU;
  const radians = 2 * Math.atan(radiusKm / distanceKm);
  return radians * (180 / Math.PI) * 3600;
}

/** Lower-cased Greek letter symbol → spelled-out name, e.g. `α` → `alpha`. */
const GREEK_LETTERS = new Map(
  Object.entries(GREEK_LETTER_NAMES).map(([symbol, spelled]) => [symbol, spelled.toLowerCase()]),
);

/** Lower-cased IAU abbreviation → lower-cased genitive, e.g. `cma` → `canis majoris`. */
const GENITIVES = new Map(
  Object.entries(CONSTELLATION_GENITIVES).map(([abbr, genitive]) => [
    abbr.toLowerCase(),
    genitive.toLowerCase(),
  ]),
);

/**
 * Rewrite a lower-cased, whitespace-split Bayer designation into the catalog's own form
 * (`<letter name> <constellation genitive>`): a Greek symbol becomes its name, an IAU
 * abbreviation its genitive. Anything else passes through, so an input that is not a
 * designation simply misses the index.
 */
function canonicalDesignation([letter = '', ...constellation]: string[]): string {
  const rest = constellation.join(' ');
  return `${GREEK_LETTERS.get(letter) ?? letter} ${GENITIVES.get(rest) ?? rest}`;
}

/** Map a MoonQuarter index (0..3) to a quarter name. */
function quarterName(index: number): QuarterName {
  switch (index) {
    case 0:
      return 'new';
    case 1:
      return 'first_quarter';
    case 2:
      return 'full';
    default:
      return 'last_quarter';
  }
}

/** Human phase name from the Moon–Sun longitude difference (0=new, 90=first, 180=full, 270=last). */
function phaseNameFromLongitude(longitude: number): string {
  const a = ((longitude % 360) + 360) % 360;
  if (a < 22.5 || a >= 337.5) return 'New Moon';
  if (a < 67.5) return 'Waxing Crescent';
  if (a < 112.5) return 'First Quarter';
  if (a < 157.5) return 'Waxing Gibbous';
  if (a < 202.5) return 'Full Moon';
  if (a < 247.5) return 'Waning Gibbous';
  if (a < 292.5) return 'Last Quarter';
  return 'Waning Crescent';
}

/**
 * Sky-condition gate from the Sun's altitude in degrees, by the standard twilight
 * bands: above the horizon is daylight; 0 to −6° civil, −6 to −12° nautical,
 * −12 to −18° astronomical twilight; below −18° the sky is dark.
 */
function skyConditionFromSunAltitude(sunAlt: number): SkyCondition {
  if (sunAlt > 0) return 'daylight';
  if (sunAlt > CIVIL_DEG) return 'civil_twilight';
  if (sunAlt > NAUTICAL_DEG) return 'nautical_twilight';
  if (sunAlt > ASTRONOMICAL_DEG) return 'astronomical_twilight';
  return 'dark';
}

/** Compass octant label from an azimuth in degrees (0=N, 90=E, 180=S, 270=W). */
function compassOctant(azimuth: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const normalized = (((azimuth % 360) + 360) % 360) / 45;
  const idx = Math.round(normalized) % 8;
  return dirs[idx] ?? 'N';
}

/** Brightness adjective from apparent magnitude. */
function brightnessAdjective(mag: number | null): string {
  if (mag === null) return '';
  if (mag <= -2) return 'very bright';
  if (mag <= 1) return 'bright';
  if (mag <= 3) return 'easily visible';
  if (mag <= 5) return 'faint';
  return 'very faint';
}

/**
 * Deterministic, server-computed visibility headline — real values only. The brightness
 * adjective describes a body against a dark sky, so a condition that hides the body replaces
 * it: daylight, or sitting within `GLARE_ELONGATION_DEG` of the Sun. A civil-twilight sky dims
 * the view without hiding a bright body, so it follows the adjective as a caveat. The Sun is
 * exempt from all of it. The Moon and a negative-magnitude Venus are naked-eye objects in a
 * blue sky, so they skip the sky-condition caveats — but not glare, since beside the Sun's
 * disc neither can be seen.
 */
function visibilityNote(pos: SkyPosition, sky: SkyCondition): string {
  const alt = pos.horizontal.altitudeDegrees;
  const octant = compassOctant(pos.horizontal.azimuthDegrees);
  const magPart = pos.magnitude !== null ? `mag ${pos.magnitude.toFixed(1)}, ` : '';
  const altPhrase =
    alt < 0
      ? `${Math.abs(alt).toFixed(0)}° below the ${octant} horizon`
      : `${alt.toFixed(0)}° above the ${octant} horizon`;
  const name = pos.body.charAt(0).toUpperCase() + pos.body.slice(1);
  const headline = `${name}, ${magPart}${altPhrase}`;

  const isSun = pos.body === 'sun';
  const seenInDaylight =
    isSun ||
    pos.body === 'moon' ||
    (pos.body === 'venus' && pos.magnitude !== null && pos.magnitude < 0);
  const inDaylight = !seenInDaylight && sky === 'daylight';
  const inGlare = !isSun && pos.sunElongationDegrees < GLARE_ELONGATION_DEG;
  const adjective = inDaylight || inGlare ? '' : brightnessAdjective(pos.magnitude);
  const terms = [
    adjective,
    inDaylight ? 'daylight, not naked-eye visible' : '',
    !seenInDaylight && sky === 'civil_twilight' ? 'civil twilight, sky still bright' : '',
    inGlare ? `${pos.sunElongationDegrees.toFixed(0)}° from the Sun, lost in glare` : '',
  ].filter(Boolean);
  return terms.length > 0 ? `${headline} — ${terms.join('; ')}` : headline;
}

/**
 * An eclipse's contacts in chronological order, each paired with a per-contact value —
 * undefined for a phase the eclipse never reaches.
 */
type EclipseContacts<T> = ReadonlyArray<readonly [EclipsePhase, T | undefined]>;

/** Contact times as ISO 8601 UTC keyed `<phase>_utc`, null for a phase that does not occur. */
function contactTimes(contacts: EclipseContacts<AstroTime>): Record<string, string | null> {
  return Object.fromEntries(
    contacts.map(([phase, time]) => [`${phase}_utc`, time ? time.toString() : null]),
  );
}

/**
 * Local circumstances from the eclipsed body's altitude at each contact: the altitudes
 * keyed by phase (null where a phase does not occur), and the one visibility rule both
 * eclipse classes share — visible when the body is above the horizon at any contact.
 */
function localCircumstances(
  altitudes: EclipseContacts<number>,
): Pick<EventRecord, 'contactAltitudesDegrees' | 'localVisible'> {
  return {
    contactAltitudesDegrees: Object.fromEntries(
      altitudes.map(([phase, altitude]) => [phase, altitude ?? null]),
    ),
    localVisible: altitudes.some(([, altitude]) => altitude !== undefined && altitude > 0),
  };
}

/** The event classes that target a specific body. */
type BodyEventName = 'opposition' | 'conjunction' | 'max_elongation' | 'perigee_apogee';

/**
 * Which bodies each body-relative event class is defined for, and the hint that
 * names the alternatives. Gating here keeps astronomy-engine from being handed a
 * body it cannot search — it throws raw internal messages for those.
 */
const EVENT_BODIES: Record<BodyEventName, { bodies: ReadonlySet<EventBodyName>; hint: string }> = {
  opposition: {
    bodies: SUPERIOR_PLANETS,
    hint: 'Use a superior planet — mars, jupiter, saturn, uranus, neptune, or pluto. Mercury and Venus orbit inside Earth and never reach opposition; try conjunction or max_elongation for them.',
  },
  conjunction: {
    bodies: new Set<EventBodyName>(PLANETS),
    hint: 'Use a planet — mercury through pluto. Without body2, conjunction measures a planet against the Sun, so the Sun, Moon, and Earth have none; for the Moon meeting a planet, add that planet as body2.',
  },
  max_elongation: {
    bodies: INNER_PLANETS,
    hint: 'Use body "mercury" or "venus" for max_elongation. Greatest elongation is the widest a body gets from the Sun in the sky, so only a planet orbiting inside Earth reaches one.',
  },
  perigee_apogee: {
    bodies: new Set<EventBodyName>(['moon', 'earth', ...PLANETS]),
    hint: 'Use "moon" for lunar perigee/apogee, or "earth" or a planet for heliocentric perihelion/aphelion. The Sun sits at the focus of those orbits and has no apsis.',
  },
};

/**
 * Resolve the target body of a body-relative event: require one, and reject a body
 * the event class is not defined for. Throws with the `body_required` or
 * `body_not_supported` contract reason.
 */
function resolveBody(event: BodyEventName, body: EventBodyName | undefined): EventBodyName {
  if (!body) throw bodyRequired(event);
  const spec = EVENT_BODIES[event];
  if (!spec.bodies.has(body)) {
    throw invalidParams(`The "${event}" event is not defined for ${body}.`, {
      reason: 'body_not_supported',
      recovery: { hint: spec.hint },
    });
  }
  return body;
}

/** A body-relative event searched without its target body — the `body_required` reason. */
function bodyRequired(event: BodyEventName) {
  return invalidParams(`The "${event}" event requires a target body.`, {
    reason: 'body_required',
    recovery: { hint: 'Add the target body (e.g. "mars" or "jupiter") and retry.' },
  });
}

/**
 * A `body2` the search cannot pair — the `invalid_body_pair` reason. The hint is written
 * here, with no ctx to resolve it from, so astronomy_find_events declares the same string.
 */
function invalidBodyPair(message: string) {
  return invalidParams(message, {
    reason: 'invalid_body_pair',
    recovery: {
      hint: 'body2 applies only to event "conjunction" and pairs two different bodies among the Moon and the planets (mercury through pluto). For a planet\'s conjunction with the Sun, pass the planet as body and omit body2; for the Moon\'s, search moon_quarter for the new moon.',
    },
  });
}

/**
 * Resolve the two bodies of a two-body conjunction: require `body`, and reject one that
 * cannot be paired (the Sun or Earth) or a pair of the same body twice. Throws with the
 * `body_required` or `invalid_body_pair` contract reason.
 */
function resolvePair(
  body: EventBodyName | undefined,
  body2: PairBodyName,
): [PairBodyName, PairBodyName] {
  if (!body) throw bodyRequired('conjunction');
  if (!isPairBody(body)) {
    throw invalidBodyPair(
      `A two-body conjunction pairs the Moon and the planets; body "${body}" is not one of them.`,
    );
  }
  if (body === body2) {
    throw invalidBodyPair(
      `body and body2 are both "${body}"; a conjunction needs two different bodies.`,
    );
  }
  return [body, body2];
}

// --- Init / accessor pattern ------------------------------------------------

let _service: EphemerisService | undefined;

/** Initialize the ephemeris service. Pure compute — no config or storage needed. */
export function initEphemerisService(): void {
  _service = new EphemerisService();
}

/** Accessor — throws if not initialized in setup(). */
export function getEphemerisService(): EphemerisService {
  if (!_service) {
    throw new Error('EphemerisService not initialized — call initEphemerisService() in setup()');
  }
  return _service;
}
