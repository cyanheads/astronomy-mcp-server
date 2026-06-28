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
  type Apsis,
  ApsisKind,
  Body,
  Constellation,
  DefineStar,
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
import { STAR_CATALOG } from './star-catalog.js';
import type {
  BodyName,
  CatalogStar,
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

/** Kilometers per astronomical unit (astronomy-engine's KM_PER_AU). */
const KM_PER_AU = 149597870.69098932;

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

/** Inner planets eligible for greatest-elongation. */
const INNER_PLANETS = new Set<BodyName>(['mercury', 'venus']);

/** Map a wire body name to the engine's Body enum. */
const BODY_ENUM: Record<BodyName, Body> = {
  sun: Body.Sun,
  moon: Body.Moon,
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
   * Throws `invalidParams` with reason `time_out_of_range` outside it.
   */
  resolveTime(time?: string): Date {
    const date = time ? new Date(time) : new Date();
    if (Number.isNaN(date.getTime())) {
      throw invalidParams(
        `Invalid time "${time}". Expected an ISO 8601 instant, e.g. 2024-04-08T18:00:00Z.`,
        {
          reason: 'invalid_time',
        },
      );
    }
    const year = date.getUTCFullYear();
    if (year < 1900 || year > 2100) {
      throw invalidParams(
        `Time ${date.toISOString()} is outside the high-accuracy span (1900–2100).`,
        { reason: 'time_out_of_range', recovery: { hint: 'Use a date between 1900 and 2100.' } },
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

  /** Resolve a star name/designation (case-insensitive) to a catalog entry, or throw. */
  lookupStar(name: string): CatalogStar {
    const key = name.trim().toLowerCase();
    const hit = this.starIndex.get(key) ?? this.designationIndex.get(key);
    if (!hit) {
      throw notFound(`Star "${name}" is not in the bundled catalog.`, {
        reason: 'star_not_found',
        recovery: {
          hint: 'Check the spelling or use a common name / Bayer designation, e.g. "Sirius" or "Polaris".',
        },
      });
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
      let transitUtc: string | null = null;
      let transitAlt: number | null = null;
      try {
        const transit = SearchHourAngle(BODY_ENUM[body], obs, 0, cursor, +1);
        transitUtc = transit.time.toString();
        transitAlt = transit.hor.altitude;
      } catch {
        transitUtc = null;
      }

      const event: RiseSetEvent = {
        riseUtc: rise ? rise.toString() : null,
        setUtc: set ? set.toString() : null,
        transitUtc,
        transitAltitudeDegrees: transitAlt,
      };

      if (rise === null && set === null) {
        // Circumpolar or never-rises: distinguish by transit altitude.
        event.note =
          transitAlt !== null && transitAlt > 0
            ? 'Circumpolar — never sets at this latitude/date.'
            : 'Never rises above the horizon at this latitude/date.';
      } else if (rise === null) {
        event.note = 'Already above the horizon at the search start — no rise in this cycle.';
      } else if (set === null) {
        event.note = 'Does not set before the next rise — circumpolar window.';
      }

      if (body === 'sun') {
        event.twilight = this.twilight(obs, cursor, timezone);
      }

      if (timezone) {
        if (rise) event.riseLocal = this.formatLocal(rise.date, timezone);
        if (set) event.setLocal = this.formatLocal(set.date, timezone);
        if (transitUtc) event.transitLocal = this.formatLocal(new Date(transitUtc), timezone);
      }

      events.push(event);

      // Advance the cursor past this cycle to find the next one.
      const advanceFrom = rise ?? set ?? (transitUtc ? MakeTime(new Date(transitUtc)) : null);
      cursor = advanceFrom
        ? advanceFrom.AddDays(1).date
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
    const phaseAngle = MoonPhase(time);
    const illum = Illumination(Body.Moon, time);

    // Age = days since the previous new moon. New moon is phase-angle 0; search
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
      phaseAngleDegrees: phaseAngle,
      illuminatedFraction: illum.phase_fraction,
      phaseName: phaseNameFromAngle(phaseAngle),
      ageDays,
      nextQuarters: quarters,
    };
    if (timezone) result.timeLocal = this.formatLocal(date, timezone);
    return result;
  }

  /** Days since the previous new moon (synodic age). */
  private moonAgeDays(time: ReturnType<typeof MakeTime>): number {
    // Search backward up to ~31 days for the most recent new-moon (longitude 0).
    const prevNew = SearchMoonPhase(0, time.AddDays(-31).date, 35);
    if (!prevNew || prevNew.ut > time.ut) {
      // Fallback: derive age from the phase angle if the search overshoots.
      return (MoonPhase(time) / 360) * 29.530588;
    }
    return time.ut - prevNew.ut;
  }

  // ---- Events --------------------------------------------------------------

  /** Search forward for the next `count` occurrences of an event class. */
  findEvents(
    event: EventName,
    opts: {
      start: Date;
      count: number;
      body?: BodyName;
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
        return this.lunarEclipseEvents(opts.start, opts.count, opts.timezone);
      case 'solar_eclipse':
        return this.solarEclipseEvents(opts.start, opts.count, opts.observer, opts.timezone);
      case 'opposition':
      case 'conjunction':
        return this.relativeLongitudeEvents(
          event,
          requireBody(opts.body, event),
          opts.start,
          opts.count,
          opts.timezone,
        );
      case 'max_elongation':
        return this.maxElongationEvents(
          requireBody(opts.body, event),
          opts.start,
          opts.count,
          opts.timezone,
        );
      case 'perigee_apogee':
        return this.apsisEvents(
          requireBody(opts.body, event),
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
    let year = start.getUTCFullYear();
    while (out.length < count) {
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
      year += 1;
      if (year > 2100) break;
    }
    return out;
  }

  private moonQuarterEvents(start: Date, count: number, timezone?: string): EventRecord[] {
    const out: EventRecord[] = [];
    let mq = SearchMoonQuarter(start);
    for (let i = 0; i < count; i++) {
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

  private lunarEclipseEvents(start: Date, count: number, timezone?: string): EventRecord[] {
    const out: EventRecord[] = [];
    let ecl: LunarEclipseInfo = SearchLunarEclipse(start);
    for (let i = 0; i < count; i++) {
      const peak = ecl.peak;
      const rec: EventRecord = {
        event: 'lunar_eclipse',
        timeUtc: peak.toString(),
        kind: ecl.kind,
        obscuration: ecl.obscuration,
        contacts: {
          penumbral_begin_utc: minutesBefore(peak, ecl.sd_penum),
          partial_begin_utc: ecl.sd_partial > 0 ? minutesBefore(peak, ecl.sd_partial) : null,
          total_begin_utc: ecl.sd_total > 0 ? minutesBefore(peak, ecl.sd_total) : null,
          peak_utc: peak.toString(),
          total_end_utc: ecl.sd_total > 0 ? minutesAfter(peak, ecl.sd_total) : null,
          partial_end_utc: ecl.sd_partial > 0 ? minutesAfter(peak, ecl.sd_partial) : null,
          penumbral_end_utc: minutesAfter(peak, ecl.sd_penum),
        },
      };
      if (timezone) rec.timeLocal = this.formatLocal(peak.date, timezone);
      out.push(rec);
      ecl = NextLunarEclipse(peak);
    }
    return out;
  }

  private solarEclipseEvents(
    start: Date,
    count: number,
    observer?: ObserverInput,
    timezone?: string,
  ): EventRecord[] {
    const out: EventRecord[] = [];
    if (observer) {
      // Observer supplied → local circumstances via SearchLocalSolarEclipse.
      const obs = this.toObserver(observer);
      let ecl: LocalSolarEclipseInfo = SearchLocalSolarEclipse(start, obs);
      for (let i = 0; i < count; i++) {
        const peakTime = ecl.peak.time;
        const localVisible = ecl.peak.altitude > 0;
        const rec: EventRecord = {
          event: 'solar_eclipse',
          timeUtc: peakTime.toString(),
          kind: ecl.kind,
          obscuration: ecl.obscuration,
          localVisible,
          contacts: {
            partial_begin_utc: ecl.partial_begin.time.toString(),
            total_begin_utc: ecl.total_begin ? ecl.total_begin.time.toString() : null,
            peak_utc: peakTime.toString(),
            total_end_utc: ecl.total_end ? ecl.total_end.time.toString() : null,
            partial_end_utc: ecl.partial_end.time.toString(),
          },
        };
        if (timezone) rec.timeLocal = this.formatLocal(peakTime.date, timezone);
        out.push(rec);
        ecl = NextLocalSolarEclipse(peakTime, obs);
      }
    } else {
      // No observer → global solar eclipse circumstances.
      let ecl = SearchGlobalSolarEclipse(start);
      for (let i = 0; i < count; i++) {
        const rec: EventRecord = {
          event: 'solar_eclipse',
          timeUtc: ecl.peak.toString(),
          kind: ecl.kind,
          obscuration: ecl.obscuration ?? null,
          localVisible: false,
          contacts: { peak_utc: ecl.peak.toString() },
        };
        if (timezone) rec.timeLocal = this.formatLocal(ecl.peak.date, timezone);
        out.push(rec);
        ecl = NextGlobalSolarEclipse(ecl.peak);
      }
    }
    return out;
  }

  private relativeLongitudeEvents(
    event: 'opposition' | 'conjunction',
    body: BodyName,
    start: Date,
    count: number,
    timezone?: string,
  ): EventRecord[] {
    const out: EventRecord[] = [];
    const targetLon = event === 'opposition' ? 180 : 0;
    let cursor = start;
    for (let i = 0; i < count; i++) {
      const t = SearchRelativeLongitude(BODY_ENUM[body], targetLon, cursor);
      const rec: EventRecord = { event, timeUtc: t.toString(), body };
      if (timezone) rec.timeLocal = this.formatLocal(t.date, timezone);
      out.push(rec);
      // Step past this event by a few days to find the next.
      cursor = t.AddDays(5).date;
    }
    return out;
  }

  private maxElongationEvents(
    body: BodyName,
    start: Date,
    count: number,
    timezone?: string,
  ): EventRecord[] {
    if (!INNER_PLANETS.has(body)) {
      throw invalidParams(`max_elongation applies only to Mercury and Venus, not ${body}.`, {
        reason: 'body_not_supported',
        recovery: { hint: 'Use body "mercury" or "venus" for max_elongation.' },
      });
    }
    const out: EventRecord[] = [];
    let cursor = start;
    for (let i = 0; i < count; i++) {
      const e = SearchMaxElongation(BODY_ENUM[body], cursor);
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
    body: BodyName,
    start: Date,
    count: number,
    timezone?: string,
  ): EventRecord[] {
    const out: EventRecord[] = [];
    const isMoon = body === 'moon';
    let apsis: Apsis = isMoon ? SearchLunarApsis(start) : SearchPlanetApsis(BODY_ENUM[body], start);
    for (let i = 0; i < count; i++) {
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
      visibilityNote: visibilityNote(pos),
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
}

// --- Pure helpers (module-level, no service state) -------------------------

/** Angular diameter in arcseconds from a body radius (km) and distance (AU). */
function angularDiameterArcsec(radiusKm: number, distanceAu: number): number {
  const distanceKm = distanceAu * KM_PER_AU;
  const radians = 2 * Math.atan(radiusKm / distanceKm);
  return radians * (180 / Math.PI) * 3600;
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

/** Human phase name from the Moon's phase angle (0=new, 90=first, 180=full, 270=last). */
function phaseNameFromAngle(angle: number): string {
  const a = ((angle % 360) + 360) % 360;
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

/** Deterministic, server-computed visibility headline — real values only. */
function visibilityNote(pos: SkyPosition): string {
  const alt = pos.horizontal.altitudeDegrees;
  const octant = compassOctant(pos.horizontal.azimuthDegrees);
  const magPart = pos.magnitude !== null ? `mag ${pos.magnitude.toFixed(1)}, ` : '';
  const adjective = brightnessAdjective(pos.magnitude);
  const adjPart = adjective ? ` — ${adjective}` : '';
  const altPhrase =
    alt < 0
      ? `${Math.abs(alt).toFixed(0)}° below the ${octant} horizon`
      : `${alt.toFixed(0)}° above the ${octant} horizon`;
  const name = pos.body.charAt(0).toUpperCase() + pos.body.slice(1);
  return `${name}, ${magPart}${altPhrase}${adjPart}`;
}

/** ISO 8601 time `minutes` before an AstroTime peak. */
function minutesBefore(peak: ReturnType<typeof MakeTime>, minutes: number): string {
  return peak.AddDays(-minutes / 1440).toString();
}

/** ISO 8601 time `minutes` after an AstroTime peak. */
function minutesAfter(peak: ReturnType<typeof MakeTime>, minutes: number): string {
  return peak.AddDays(minutes / 1440).toString();
}

/** Require a body for body-specific event classes; throw with the contract reason. */
function requireBody(body: BodyName | undefined, event: EventName): BodyName {
  if (!body) {
    throw invalidParams(`The "${event}" event requires a target body.`, {
      reason: 'body_required',
      recovery: { hint: 'Add the target body (e.g. "mars" or "jupiter") and retry.' },
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
