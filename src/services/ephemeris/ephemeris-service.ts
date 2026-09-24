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
  Horizon,
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
  ListVisibleResult,
  MoonPhaseResult,
  ObserverInput,
  QuarterEvent,
  QuarterName,
  RiseSetEvent,
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
   * Both throws carry their recovery hint inline: this method takes no `ctx`, so
   * `ctx.recoveryFor()` is unavailable and the hint has to be written at the throw
   * site to reach `data.recovery.hint` and the `Recovery:` line mirrored into
   * `content[]`.
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
        {
          reason: 'time_out_of_range',
          recovery: { hint: `Use a date between ${firstYear} and ${lastYear}.` },
        },
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

  /** Rise/set/transit cycles for a body, searching forward from `start`. */
  riseSet(
    body: BodyName,
    observer: ObserverInput,
    start: Date,
    count: number,
    timezone?: string,
  ): RiseSetEvent[] {
    const obs = this.toObserver(observer);
    const events: RiseSetEvent[] = [];
    let cursor = start;

    for (let i = 0; i < count; i++) {
      const rise = SearchRiseSet(BODY_ENUM[body], obs, +1, cursor, RISE_SET_WINDOW_DAYS);
      const set = SearchRiseSet(BODY_ENUM[body], obs, -1, cursor, RISE_SET_WINDOW_DAYS);
      /**
       * Both searches run forward from the cursor, so when the body is already up the next
       * set arrives before the next rise and the two belong to different cycles — pairing
       * them reports a set hours before its own rise. The interval in progress is the one
       * the caller is standing in, and its rise is behind the cursor where a forward-only
       * search cannot reach it, so report that interval as a partial cycle naming the
       * imminent set. Beginning at the next complete cycle instead would be chronologically
       * tidy and quietly drop tonight's set, which is the event a caller asking during the
       * day most needs.
       */
      const alreadyUp = set !== null && (rise === null || set.date < rise.date);
      const cycleRise = alreadyUp ? null : rise;

      let transitUtc: string | null = null;
      let transitAlt: number | null = null;
      try {
        const transit = SearchHourAngle(BODY_ENUM[body], obs, 0, cursor, +1);
        /**
         * The meridian crossing is found regardless of altitude, so the next one after the
         * cursor can belong to a neighbouring cycle — before this cycle's rise, or after
         * its set. Report it only when it falls inside the interval it is attached to.
         */
        const at = transit.time.date;
        if ((cycleRise === null || at > cycleRise.date) && (set === null || at < set.date)) {
          transitUtc = transit.time.toString();
          transitAlt = transit.hor.altitude;
        }
      } catch {
        transitUtc = null;
      }

      const event: RiseSetEvent = {
        riseUtc: cycleRise ? cycleRise.toString() : null,
        setUtc: set ? set.toString() : null,
        transitUtc,
        transitAltitudeDegrees: transitAlt,
      };

      if (cycleRise === null && set === null) {
        // Circumpolar or never-rises: distinguish by transit altitude.
        event.note =
          transitAlt !== null && transitAlt > 0
            ? 'Circumpolar — never sets at this latitude/date.'
            : 'Never rises above the horizon at this latitude/date.';
      } else if (cycleRise === null) {
        event.note = 'Already above the horizon at the search start — no rise in this cycle.';
      } else if (set === null) {
        event.note = 'Does not set before the next rise — circumpolar window.';
      }

      if (body === 'sun') {
        /**
         * Anchor the pair to this cycle's own rise, not the resume cursor: the cursor sits
         * just past the previous set, which is still short of that evening's dusk, so a
         * cursor-anchored search hands the next cycle the previous evening's twilight while
         * its rise and set have already moved on a day.
         */
        event.twilight = this.twilight(obs, cycleRise?.date ?? cursor, timezone);
      }

      if (timezone) {
        if (cycleRise) event.riseLocal = this.formatLocal(cycleRise.date, timezone);
        if (set) event.setLocal = this.formatLocal(set.date, timezone);
        if (transitUtc) event.transitLocal = this.formatLocal(new Date(transitUtc), timezone);
      }

      events.push(event);

      /**
       * Resume just past this cycle's set, so the next search finds the following rise and
       * the set that closes it. Advancing a whole day from the rise instead overshot the
       * next day's set for any body that rises earlier each day, dropping a full cycle from
       * a multi-count call. With no set to resume from the body is circumpolar for this
       * window, where a day is the only meaningful step.
       */
      cursor = set
        ? new Date(set.date.getTime() + 1000)
        : new Date(cursor.getTime() + 24 * 3600 * 1000);
    }

    return events;
  }

  /** Civil/nautical/astronomical dawn+dusk pairs for the Sun on the search day. */
  private twilight(obs: Observer, start: Date, timezone?: string): TwilightSet {
    const pair = (altitude: number): TwilightPair => {
      // Dawn = Sun ascending (+1) through the altitude; dusk = descending (-1).
      const dawn = SearchAltitude(Body.Sun, obs, +1, start, 2, altitude);
      const dusk = SearchAltitude(Body.Sun, obs, -1, start, 2, altitude);
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
   * switches the search from global to observer-local.
   */
  findEvents(
    event: EventName,
    opts: {
      start: Date;
      count: number;
      body?: EventBodyName;
      observer?: ObserverInput;
      timezone?: string;
    },
  ): EventRecord[] {
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
    hint: 'Use a planet — mercury through pluto. Conjunction measures a planet against the Sun, so the Sun, Moon, and Earth have none.',
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
  if (!body) {
    throw invalidParams(`The "${event}" event requires a target body.`, {
      reason: 'body_required',
      recovery: { hint: 'Add the target body (e.g. "mars" or "jupiter") and retry.' },
    });
  }
  const spec = EVENT_BODIES[event];
  if (!spec.bodies.has(body)) {
    throw invalidParams(`The "${event}" event is not defined for ${body}.`, {
      reason: 'body_not_supported',
      recovery: { hint: spec.hint },
    });
  }
  return body;
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
