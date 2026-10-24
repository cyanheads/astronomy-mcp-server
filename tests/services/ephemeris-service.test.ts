/**
 * @fileoverview Determinism / golden-value tests for the EphemerisService. The core
 *   is pure computation over astronomy-engine, so known astronomical events anchor
 *   correctness: the 2024-04-08 total solar eclipse, a known full moon, the 2024
 *   March equinox, and a known sunrise. These are the determinism payoff — same
 *   inputs, byte-identical, verifiable against published values.
 * @module tests/services/ephemeris-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AngleBetween,
  Atmosphere,
  Body,
  Equator,
  GeoVector,
  Horizon,
  Observer,
  PairLongitude,
  SearchAltitude,
  SearchHourAngle,
  SearchRiseSet,
} from 'astronomy-engine';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findEventsTool } from '@/mcp-server/tools/definitions/find-events.tool.js';
import { EphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { STAR_CATALOG } from '@/services/ephemeris/star-catalog.js';
import type {
  EventBodyName,
  EventName,
  EventRecord,
  PairBodyName,
  RiseSetEvent,
} from '@/services/ephemeris/types.js';
import { captureThrown } from '../helpers/capture-thrown.js';

let svc: EphemerisService;

beforeAll(() => {
  svc = new EphemerisService();
});

/** Dallas, TX — inside the 2024-04-08 path of totality. */
const DALLAS = { latitude: 32.7767, longitude: -96.797, elevation: 131 };
/** Seattle, WA. */
const SEATTLE = { latitude: 47.6062, longitude: -122.3321, elevation: 56 };
/** Rome — the 2026-08-12 partial solar eclipse peaks there just after sunset. */
const ROME = { latitude: 41.9, longitude: 12.5, elevation: 0 };

describe('moonPhase', () => {
  it('reports a full moon near 2024-04-23T23:49Z', () => {
    const result = svc.moonPhase(new Date('2024-04-23T23:49:00Z'));
    expect(result.phaseName).toBe('Full Moon');
    expect(result.illuminatedFraction).toBeGreaterThan(0.99);
    // The Moon–Sun ecliptic-longitude difference is near 180° at full moon.
    expect(Math.abs(result.phaseLongitudeDegrees - 180)).toBeLessThan(3);
    expect(result.nextQuarters).toHaveLength(4);
  });

  it('reports the longitude difference, the inverse of the Sun-Moon-observer phase angle', () => {
    // The 2026-09-26 full moon. The longitude difference reads 180 at full; the phase angle
    // position() reports reads near 0 at the same instant. One field name meaning both was
    // the defect, so the two are pinned side by side.
    const instant = new Date('2026-09-26T16:49:32Z');
    const phase = svc.moonPhase(instant);
    expect(phase.phaseLongitudeDegrees).toBeCloseTo(180, 3);
    expect(phase.phaseName).toBe('Full Moon');
    expect(phase).not.toHaveProperty('phaseAngleDegrees');
    const pos = svc.position(
      { kind: 'body', body: 'moon' },
      { latitude: 0, longitude: 0, elevation: 0 },
      instant,
    );
    expect(pos.phaseAngleDegrees).toBeLessThan(5);
  });

  it('reports a new moon near 2024-04-08T18:21Z (the eclipse new moon)', () => {
    const result = svc.moonPhase(new Date('2024-04-08T18:21:00Z'));
    expect(result.phaseName).toBe('New Moon');
    expect(result.illuminatedFraction).toBeLessThan(0.01);
    // This instant is a few seconds *before* the 2024-04-08 new moon, so the age is
    // measured from the 2024-03-10 one and lands at the top of the synodic month.
    expect(result.ageDays).toBeCloseTo(29.39, 1);
  });

  it('measures age from the most recent new moon within hours of it', () => {
    // The 2026-03-19T01:24:06Z new moon, six hours on. A forward search over a
    // 31-day look-back window returns the *previous* new moon here, which reported
    // ~29.81 days — an age past the length of a synodic month, next to a 0.1%
    // illuminated "New Moon".
    const result = svc.moonPhase(new Date('2026-03-19T07:30:00Z'));
    expect(result.phaseName).toBe('New Moon');
    expect(result.ageDays).toBeCloseTo(0.254, 2);
  });

  it('keeps the age inside one synodic month across a full lunation', () => {
    // Half-day steps from just after a new moon through the next one. The age must
    // rise monotonically and reset, never exceeding the longest synodic month.
    const newMoon = Date.parse('2026-03-19T01:24:06Z');
    let previous = -1;
    let resets = 0;
    for (let halfDays = 1; halfDays <= 62; halfDays++) {
      const age = svc.moonPhase(new Date(newMoon + halfDays * 12 * 3600 * 1000)).ageDays;
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(29.9);
      if (age < previous) resets++;
      previous = age;
    }
    // Exactly one new moon falls inside a 31-day sweep.
    expect(resets).toBe(1);
  });

  it('returns the four quarter phases in chronological order', () => {
    const result = svc.moonPhase(new Date('2024-06-01T00:00:00Z'));
    const times = result.nextQuarters.map((q) => new Date(q.timeUtc).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1] as number);
    }
  });
});

describe('findEvents — equinox/solstice', () => {
  it('finds the 2024 March equinox near 2024-03-20T03:06Z', () => {
    const events = svc.findEvents('equinox', { start: new Date('2024-01-01T00:00:00Z'), count: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.which).toBe('march');
    const t = new Date(events[0]!.timeUtc);
    // Published: 2024-03-20 03:06 UTC. Allow a few minutes of tolerance.
    expect(t.getUTCFullYear()).toBe(2024);
    expect(t.getUTCMonth()).toBe(2); // March (0-indexed)
    expect(t.getUTCDate()).toBe(20);
    expect(Math.abs(t.getUTCHours() - 3)).toBeLessThanOrEqual(1);
  });

  it('finds the 2024 June solstice near 2024-06-20T20:51Z', () => {
    const events = svc.findEvents('solstice', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
    });
    expect(events[0]?.which).toBe('june');
    const t = new Date(events[0]!.timeUtc);
    expect(t.getUTCMonth()).toBe(5); // June
    expect(t.getUTCDate()).toBe(20);
  });
});

describe('findEvents — eclipse peak start boundary', () => {
  it.each([
    { event: 'solar_eclipse' as const, peak: '1900-05-28T14:53:50' },
    { event: 'lunar_eclipse' as const, peak: '1900-06-13T03:27:40' },
  ])('keeps $event in range at the earliest accepted start', ({ event, peak }) => {
    const events = svc.findEvents(event, { start: new Date('1900-01-01T00:00:00Z'), count: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.timeUtc.slice(0, 19)).toBe(peak);
  });
  const cases: Array<{
    event: 'solar_eclipse' | 'lunar_eclipse';
    observer?: typeof DALLAS;
    peak: string;
  }> = [
    {
      event: 'solar_eclipse',
      observer: { latitude: 32.78, longitude: -96.8, elevation: 0 },
      peak: '2024-04-08T18:42:37.121Z',
    },
    { event: 'solar_eclipse', peak: '2024-04-08T18:17:19.495Z' },
    { event: 'lunar_eclipse', peak: '2025-03-14T06:58:42.343Z' },
  ];

  it.each(cases)(
    'includes $event immediately before $peak and excludes it immediately after',
    ({ event, observer, peak }) => {
      const peakMs = Date.parse(peak);
      const before = svc.findEvents(event, {
        start: new Date(peakMs - 1000),
        count: 2,
        ...(observer ? { observer } : {}),
      });
      expect(before).toHaveLength(2);
      expect(Math.abs(Date.parse(before[0]!.timeUtc) - peakMs)).toBeLessThan(1000);
      const after = svc.findEvents(event, {
        start: new Date(peakMs + 1000),
        count: 2,
        ...(observer ? { observer } : {}),
      });
      expect(after).toHaveLength(2);
      expect(after[0]!.timeUtc).toBe(before[1]!.timeUtc);
      expect(Date.parse(after[1]!.timeUtc)).toBeGreaterThan(Date.parse(after[0]!.timeUtc));
    },
  );
});

describe('findEvents — solar eclipse (local circumstances)', () => {
  it('finds the 2024-04-08 total solar eclipse, visible from Dallas', () => {
    const events = svc.findEvents('solar_eclipse', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
      observer: DALLAS,
    });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    const t = new Date(e.timeUtc);
    expect(t.getUTCFullYear()).toBe(2024);
    expect(t.getUTCMonth()).toBe(3); // April
    expect(t.getUTCDate()).toBe(8);
    expect(e.kind).toBe('total');
    expect(e.localVisible).toBe(true);
    expect(e.contacts?.peak_utc).toBeTruthy();
  });

  it('reports the Sun altitude at every contact of a total eclipse, all above the horizon', () => {
    const [e] = svc.findEvents('solar_eclipse', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
      observer: DALLAS,
    });
    const altitudes = e!.contactAltitudesDegrees!;
    expect(Object.keys(altitudes)).toEqual([
      'partial_begin',
      'total_begin',
      'peak',
      'total_end',
      'partial_end',
    ]);
    for (const [phase, altitude] of Object.entries(altitudes)) {
      expect(altitude, `${phase} altitude`).not.toBeNull();
      expect(altitude!, `${phase} altitude`).toBeGreaterThan(50);
      expect(altitude!, `${phase} altitude`).toBeLessThan(90);
    }
  });

  /**
   * The 2026-08-12 partial from Rome begins with the Sun 6.7° up and ends 10.1° below the
   * horizon, peaking just after sunset — about 42 minutes of a deep partial eclipse are
   * observable. Peak-only visibility answered "no" to "can I see it from here?".
   */
  it('marks the 2026-08-12 sunset partial from Rome visible, with each contact altitude', () => {
    const [e] = svc.findEvents('solar_eclipse', {
      start: new Date('2026-01-01T00:00:00Z'),
      count: 1,
      observer: ROME,
    });
    expect(e!.timeUtc.startsWith('2026-08-12')).toBe(true);
    expect(e!.kind).toBe('partial');
    expect(e!.localVisible).toBe(true);
    const altitudes = e!.contactAltitudesDegrees!;
    expect(altitudes.partial_begin).toBeCloseTo(6.7, 1);
    expect(altitudes.total_begin).toBeNull();
    expect(altitudes.peak).toBeCloseTo(-1.9, 1);
    expect(altitudes.total_end).toBeNull();
    expect(altitudes.partial_end).toBeCloseTo(-10.1, 1);
    // Contacts stay time-only and keep their `_utc` keys.
    expect(e!.contacts).toEqual({
      partial_begin_utc: expect.stringMatching(/^2026-08-12T17:32/),
      total_begin_utc: null,
      peak_utc: e!.timeUtc,
      total_end_utc: null,
      partial_end_utc: expect.stringMatching(/^2026-08-12T19:13/),
    });
  });
});

describe('findEvents — solar eclipse (global, no observer)', () => {
  it('returns the peak location of total and annular eclipses and no local visibility', () => {
    const events = svc.findEvents('solar_eclipse', {
      start: new Date('2026-08-01T00:00:00Z'),
      count: 2,
    });
    expect(events.map((e) => [e.kind, e.timeUtc.slice(0, 10)])).toEqual([
      ['total', '2026-08-12'],
      ['annular', '2027-02-06'],
    ]);
    expect(events[0]!.peakLatitudeDegrees).toBeCloseTo(65.2, 1);
    expect(events[0]!.peakLongitudeDegrees).toBeCloseTo(-25.2, 1);
    expect(events[1]!.peakLatitudeDegrees).toBeCloseTo(-31.3, 1);
    expect(events[1]!.peakLongitudeDegrees).toBeCloseTo(-48.5, 1);
    for (const e of events) {
      // A global eclipse has no observer to be visible or invisible to.
      expect(e.localVisible).toBeUndefined();
      expect(e.contactAltitudesDegrees).toBeUndefined();
      expect(e.contacts).toEqual({ peak_utc: e.timeUtc });
    }
  });

  it('finds the 2024-04-08 eclipse without an observer', () => {
    const [e] = svc.findEvents('solar_eclipse', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
    });
    expect(e!.timeUtc.startsWith('2024-04-08')).toBe(true);
    expect(e!.localVisible).toBeUndefined();
  });

  it('omits the peak location and obscuration for a partial eclipse, whose axis misses Earth', () => {
    const [e] = svc.findEvents('solar_eclipse', {
      start: new Date('2025-03-01T00:00:00Z'),
      count: 1,
    });
    expect(e!.kind).toBe('partial');
    expect(e!.timeUtc.startsWith('2025-03-29')).toBe(true);
    expect(e!.obscuration).toBeNull();
    expect(e!.peakLatitudeDegrees).toBeUndefined();
    expect(e!.peakLongitudeDegrees).toBeUndefined();
  });
});

describe('findEvents — lunar eclipse', () => {
  it('finds a lunar eclipse with penumbral contact times bracketing the peak', () => {
    const events = svc.findEvents('lunar_eclipse', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
    });
    const e = events[0]!;
    expect(['penumbral', 'partial', 'total']).toContain(e.kind);
    const peak = new Date(e.contacts!.peak_utc as string).getTime();
    const penumbralBegin = new Date(e.contacts!.penumbral_begin_utc as string).getTime();
    const penumbralEnd = new Date(e.contacts!.penumbral_end_utc as string).getTime();
    expect(penumbralBegin).toBeLessThan(peak);
    expect(penumbralEnd).toBeGreaterThan(peak);
  });

  it('stays geocentric without an observer: no local visibility, no altitudes', () => {
    const [e] = svc.findEvents('lunar_eclipse', {
      start: new Date('2025-01-01T00:00:00Z'),
      count: 1,
    });
    expect(e!.localVisible).toBeUndefined();
    expect(e!.contactAltitudesDegrees).toBeUndefined();
  });

  it('reports the Moon altitude at all seven contacts of the 2025-03-14 total eclipse from Seattle', () => {
    const [e] = svc.findEvents('lunar_eclipse', {
      start: new Date('2025-01-01T00:00:00Z'),
      count: 1,
      observer: SEATTLE,
    });
    expect(e!.kind).toBe('total');
    expect(e!.timeUtc.startsWith('2025-03-14')).toBe(true);
    expect(e!.localVisible).toBe(true);
    const altitudes = e!.contactAltitudesDegrees!;
    expect(Object.keys(altitudes)).toEqual([
      'penumbral_begin',
      'partial_begin',
      'total_begin',
      'peak',
      'total_end',
      'partial_end',
      'penumbral_end',
    ]);
    // Each altitude is the Moon's apparent (refracted, topocentric) altitude at that contact's
    // instant — the same number astronomy_get_sky_position reports for the Moon then, to
    // within the millisecond the contact string is rounded to.
    for (const [phase, altitude] of Object.entries(altitudes)) {
      const at = e!.contacts![`${phase}_utc`]!;
      const moon = svc.position({ kind: 'body', body: 'moon' }, SEATTLE, new Date(at));
      expect(altitude, `${phase} altitude`).toBeCloseTo(moon.horizontal.altitudeDegrees, 4);
      expect(altitude!, `${phase} altitude`).toBeGreaterThan(0);
    }
  });

  it('nulls the altitude of each phase a partial lunar eclipse does not reach', () => {
    const [e] = svc.findEvents('lunar_eclipse', {
      start: new Date('2026-08-01T00:00:00Z'),
      count: 1,
      observer: SEATTLE,
    });
    expect(e!.kind).toBe('partial');
    const altitudes = e!.contactAltitudesDegrees!;
    expect(altitudes.total_begin).toBeNull();
    expect(altitudes.total_end).toBeNull();
    for (const phase of [
      'penumbral_begin',
      'partial_begin',
      'peak',
      'partial_end',
      'penumbral_end',
    ] as const) {
      expect(typeof altitudes[phase], `${phase} altitude`).toBe('number');
    }
  });

  it('marks an eclipse that happens entirely during the local day not visible', () => {
    // The 2025-09-07 total eclipse peaks at 18:11 UTC — late morning in Seattle, with
    // the Moon below the horizon from the first penumbral contact to the last.
    const [e] = svc.findEvents('lunar_eclipse', {
      start: new Date('2025-09-01T00:00:00Z'),
      count: 1,
      observer: SEATTLE,
    });
    expect(e!.timeUtc.startsWith('2025-09-07')).toBe(true);
    expect(e!.localVisible).toBe(false);
    for (const [phase, altitude] of Object.entries(e!.contactAltitudesDegrees!)) {
      expect(altitude!, `${phase} altitude`).toBeLessThan(0);
    }
  });
});

/**
 * Every search stops at the end of the supported span (the close of 2100) rather than
 * returning events the start-time gate would have rejected. One case per search
 * mechanism: equinox/solstice share one, as do opposition/conjunction.
 */
describe('findEvents — stops at the end of the supported span', () => {
  const SPAN_END = Date.parse('2101-01-01T00:00:00Z');
  const cases: Array<{
    name: string;
    event: EventName;
    start: string;
    count: number;
    body?: EventBodyName;
    observer?: typeof ROME;
    expected: number;
  }> = [
    { name: 'seasons', event: 'solstice', start: '2100-01-01T00:00:00Z', count: 5, expected: 2 },
    {
      name: 'moon quarters',
      event: 'moon_quarter',
      start: '2100-12-20T00:00:00Z',
      count: 3,
      expected: 2,
    },
    {
      name: 'lunar eclipses',
      event: 'lunar_eclipse',
      start: '2100-01-01T00:00:00Z',
      count: 4,
      expected: 2,
    },
    {
      name: 'lunar eclipses with an observer',
      event: 'lunar_eclipse',
      start: '2100-01-01T00:00:00Z',
      count: 4,
      observer: ROME,
      expected: 2,
    },
    {
      name: 'global solar eclipses',
      event: 'solar_eclipse',
      start: '2100-01-01T00:00:00Z',
      count: 4,
      expected: 2,
    },
    {
      name: 'local solar eclipses',
      event: 'solar_eclipse',
      start: '2100-01-01T00:00:00Z',
      count: 2,
      observer: ROME,
      expected: 0,
    },
    {
      name: 'relative longitude (opposition/conjunction)',
      event: 'opposition',
      body: 'mars',
      start: '2099-12-01T00:00:00Z',
      count: 5,
      expected: 0,
    },
    {
      name: 'greatest elongation',
      event: 'max_elongation',
      body: 'mercury',
      start: '2100-09-01T00:00:00Z',
      count: 5,
      expected: 2,
    },
    {
      name: 'lunar apsides',
      event: 'perigee_apogee',
      body: 'moon',
      start: '2100-12-20T00:00:00Z',
      count: 2,
      expected: 1,
    },
    {
      name: 'planetary apsides',
      event: 'perigee_apogee',
      body: 'earth',
      start: '2100-06-01T00:00:00Z',
      count: 2,
      expected: 1,
    },
  ];

  it.each(cases)('$name: returns $expected of $count', (c) => {
    const events = svc.findEvents(c.event, {
      start: new Date(c.start),
      count: c.count,
      ...(c.body ? { body: c.body } : {}),
      ...(c.observer ? { observer: c.observer } : {}),
    });
    expect(events).toHaveLength(c.expected);
    for (const e of events) expect(Date.parse(e.timeUtc)).toBeLessThan(SPAN_END);
  });
});

/**
 * Geocentric elongation of a body from the Sun, in degrees [0, 180]. At opposition
 * it is ~180°, at conjunction ~0° — the observable that tells the two events apart
 * regardless of which relative longitude the engine was asked for.
 */
function elongationFromSun(body: 'mars' | 'jupiter' | 'venus', timeUtc: string): number {
  const at = new Date(timeUtc);
  const origin = { latitude: 0, longitude: 0, elevation: 0 };
  const target = svc.position({ kind: 'body', body }, origin, at).ecliptic.longitudeDegrees;
  const sun = svc.position({ kind: 'body', body: 'sun' }, origin, at).ecliptic.longitudeDegrees;
  return Math.abs(((target - sun + 540) % 360) - 180);
}

/**
 * Earth-to-body distance in AU. Elongation is ~0° at both of an inner planet's
 * conjunctions, so distance is the only observable that separates them: the planet
 * is on the near side of the Sun at inferior conjunction and the far side at
 * superior. This is what pins the `conjunctionKind` labels to physical reality.
 */
function geocentricDistanceAu(body: 'venus' | 'mercury', timeUtc: string): number {
  const origin = { latitude: 0, longitude: 0, elevation: 0 };
  return svc.position({ kind: 'body', body }, origin, new Date(timeUtc)).equatorial.distanceAu;
}

describe('findEvents — body-relative', () => {
  it('finds a Jupiter opposition with the planet opposite the Sun', () => {
    const events = svc.findEvents('opposition', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
      body: 'jupiter',
    });
    expect(events[0]?.event).toBe('opposition');
    expect(events[0]?.body).toBe('jupiter');
    // Published: Jupiter's 2024 opposition is 2024-12-07.
    expect(events[0]!.timeUtc.slice(0, 10)).toBe('2024-12-07');
    expect(elongationFromSun('jupiter', events[0]!.timeUtc)).toBeCloseTo(180, 1);
  });

  it('puts a superior planet opposite the Sun at opposition and behind it at conjunction', () => {
    // The two searches were inverted: opposition returned the solar-conjunction date
    // and vice versa, silently, for every planet. Elongation is the discriminator —
    // ~180° at opposition, ~0° at conjunction.
    const start = new Date('2026-01-01T00:00:00Z');
    const opposition = svc.findEvents('opposition', { start, count: 1, body: 'mars' })[0]!;
    const conjunction = svc.findEvents('conjunction', { start, count: 1, body: 'mars' })[0]!;

    expect(opposition.timeUtc.slice(0, 10)).toBe('2027-02-19');
    expect(conjunction.timeUtc.slice(0, 10)).toBe('2026-01-09');
    expect(elongationFromSun('mars', opposition.timeUtc)).toBeCloseTo(180, 1);
    expect(elongationFromSun('mars', conjunction.timeUtc)).toBeCloseTo(0, 1);
  });

  it('returns both conjunctions of an inner planet in chronological order', () => {
    // Mercury and Venus pass in front of the Sun (inferior) and behind it (superior).
    // Searching only one relative longitude skips whichever comes first.
    const events = svc.findEvents('conjunction', {
      start: new Date('2026-06-01T00:00:00Z'),
      count: 3,
      body: 'venus',
    });
    expect(events.map((e) => e.conjunctionKind)).toEqual(['inferior', 'superior', 'inferior']);
    expect(events[0]!.timeUtc.slice(0, 10)).toBe('2026-10-24');
    for (let i = 1; i < events.length; i++) {
      expect(Date.parse(events[i]!.timeUtc)).toBeGreaterThan(Date.parse(events[i - 1]!.timeUtc));
    }
    // Both kinds put Venus at the Sun's longitude; only the near/far side differs.
    expect(elongationFromSun('venus', events[0]!.timeUtc)).toBeCloseTo(0, 1);
    // Which is why distance, not elongation, is what fixes the labels: Venus sits
    // ~0.27 AU away on the near side and ~1.73 AU away on the far side.
    expect(geocentricDistanceAu('venus', events[0]!.timeUtc)).toBeLessThan(0.5);
    expect(geocentricDistanceAu('venus', events[1]!.timeUtc)).toBeGreaterThan(1.5);
    expect(geocentricDistanceAu('venus', events[2]!.timeUtc)).toBeLessThan(0.5);
  });

  it('labels a Mercury conjunction by which side of the Sun it passes', () => {
    const events = svc.findEvents('conjunction', {
      start: new Date('2026-06-01T00:00:00Z'),
      count: 2,
      body: 'mercury',
    });
    expect(events.map((e) => e.conjunctionKind)).toEqual(['inferior', 'superior']);
    expect(geocentricDistanceAu('mercury', events[0]!.timeUtc)).toBeLessThan(0.9);
    expect(geocentricDistanceAu('mercury', events[1]!.timeUtc)).toBeGreaterThan(1.2);
  });

  it('omits conjunction_kind for a superior planet, which has only one conjunction', () => {
    const events = svc.findEvents('conjunction', {
      start: new Date('2026-01-01T00:00:00Z'),
      count: 1,
      body: 'jupiter',
    });
    expect(events[0]?.conjunctionKind).toBeUndefined();
  });

  it('finds a Venus greatest elongation with a morning/evening apparition', () => {
    const events = svc.findEvents('max_elongation', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
      body: 'venus',
    });
    expect(events[0]?.elongationDegrees).toBeGreaterThan(0);
    expect(['morning', 'evening']).toContain(events[0]?.visibility);
  });

  it('finds the Moon perigee with a distance under 370,000 km', () => {
    const events = svc.findEvents('perigee_apogee', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 2,
      body: 'moon',
    });
    const perigee = events.find((e) => e.apsisKind === 'perigee');
    expect(perigee).toBeDefined();
    expect(perigee!.distanceKm).toBeLessThan(370000);
  });

  it("finds Earth's perihelion and aphelion", () => {
    const events = svc.findEvents('perigee_apogee', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 2,
      body: 'earth',
    });
    expect(events.map((e) => e.apsisKind)).toEqual(['perihelion', 'aphelion']);
    // Published: 2024 perihelion 2024-01-03, aphelion 2024-07-05.
    expect(events[0]!.timeUtc.slice(0, 10)).toBe('2024-01-03');
    expect(events[1]!.timeUtc.slice(0, 10)).toBe('2024-07-05');
    // Earth's orbital eccentricity puts the apsides at ~0.983 and ~1.017 AU.
    expect(events[0]!.distanceAu).toBeCloseTo(0.9833, 3);
    expect(events[1]!.distanceAu).toBeCloseTo(1.0167, 3);
    expect(events[0]!.body).toBe('earth');
  });

  it('serializes a conjunction with the Sun with no two-body fields, field order pinned', () => {
    const inner = svc.findEvents('conjunction', {
      start: new Date('2026-06-01T00:00:00Z'),
      count: 3,
      body: 'venus',
      timezone: 'America/Los_Angeles',
    });
    expect(JSON.stringify(inner)).toBe(
      '[{"event":"conjunction","timeUtc":"2026-10-24T03:33:23.331Z","body":"venus","conjunctionKind":"inferior","timeLocal":"2026-10-23T20:33:23-07:00"},{"event":"conjunction","timeUtc":"2027-08-11T23:42:40.820Z","body":"venus","conjunctionKind":"superior","timeLocal":"2027-08-11T16:42:40-07:00"},{"event":"conjunction","timeUtc":"2028-06-01T09:53:51.660Z","body":"venus","conjunctionKind":"inferior","timeLocal":"2028-06-01T02:53:51-07:00"}]',
    );
    const outer = svc.findEvents('conjunction', {
      start: new Date('2026-01-01T00:00:00Z'),
      count: 2,
      body: 'saturn',
    });
    expect(JSON.stringify(outer)).toBe(
      '[{"event":"conjunction","timeUtc":"2026-03-25T08:54:30.738Z","body":"saturn"},{"event":"conjunction","timeUtc":"2027-04-07T17:17:02.159Z","body":"saturn"}]',
    );
  });
});

/** Milliseconds between an event's instant and a reference instant. */
const offsetMs = (timeUtc: string, reference: string) =>
  Math.abs(Date.parse(timeUtc) - Date.parse(reference));

/**
 * Ecliptic longitude of body1 minus body2 as seen from Earth's center, wrapped to
 * (−180°, 180°] — read straight from astronomy-engine, independent of the service's scan.
 */
function longitudeOffset(b1: Body, b2: Body, timeUtc: string): number {
  const d = PairLongitude(b1, b2, new Date(timeUtc));
  return d > 180 ? d - 360 : d;
}

/**
 * The same conjunctions, one for one. Each instant is refined to within a second of the
 * true one from whichever bracket the scan found it in, so a search from another start can
 * land up to two seconds away.
 */
function expectSameEvents(actual: EventRecord[], expected: EventRecord[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((e, i) => {
    const want = expected[i]!;
    expect([e.event, e.body, e.body2]).toEqual([want.event, want.body, want.body2]);
    expect(offsetMs(e.timeUtc, want.timeUtc), `#${i + 1}`).toBeLessThan(2000);
    expect(e.separationDegrees).toBeCloseTo(want.separationDegrees!, 4);
  });
}

/**
 * Two-body conjunctions: the instant the pair share an ecliptic longitude as seen from
 * Earth's center. Reference instants are JPL Horizons longitude crossings.
 */
describe('findEvents — two-body conjunctions', () => {
  const FROM = new Date('2026-10-15T00:00:00Z');

  it('finds Venus–Jupiter on 2027-08-26 at 0.495° apart', () => {
    const [e, ...rest] = svc.findEvents('conjunction', {
      start: FROM,
      count: 1,
      body: 'venus',
      body2: 'jupiter',
    });
    expect(rest).toEqual([]);
    expect(e?.event).toBe('conjunction');
    expect(e?.body).toBe('venus');
    expect(e?.body2).toBe('jupiter');
    expect(offsetMs(e!.timeUtc, '2027-08-26T02:59:41Z')).toBeLessThanOrEqual(120_000);
    expect(Math.abs(e!.separationDegrees! - 0.495)).toBeLessThanOrEqual(0.005);
    // The Sun-conjunction label belongs to the one-body search only.
    expect(e).not.toHaveProperty('conjunctionKind');
  });

  it('finds Moon–Saturn on 2026-10-24 at 6.08° apart', () => {
    const [e] = svc.findEvents('conjunction', {
      start: FROM,
      count: 1,
      body: 'moon',
      body2: 'saturn',
    });
    expect(offsetMs(e!.timeUtc, '2026-10-24T13:05:52Z')).toBeLessThanOrEqual(120_000);
    expect(Math.abs(e!.separationDegrees! - 6.08)).toBeLessThanOrEqual(0.005);
  });

  it('echoes the pair in the order given and finds the same instants either way', () => {
    const forward = svc.findEvents('conjunction', {
      start: FROM,
      count: 3,
      body: 'moon',
      body2: 'venus',
    });
    const reversed = svc.findEvents('conjunction', {
      start: FROM,
      count: 3,
      body: 'venus',
      body2: 'moon',
    });
    expect(reversed.map((e) => [e.body, e.body2])).toEqual([
      ['venus', 'moon'],
      ['venus', 'moon'],
      ['venus', 'moon'],
    ]);
    reversed.forEach((e, i) => {
      expect(offsetMs(e.timeUtc, forward[i]!.timeUtc)).toBeLessThanOrEqual(2000);
    });
  });

  it('puts both bodies at one ecliptic longitude at every event, and reports their separation then', () => {
    const events = svc.findEvents('conjunction', {
      start: FROM,
      count: 4,
      body: 'mars',
      body2: 'saturn',
      timezone: 'Asia/Tokyo',
    });
    expect(events).toHaveLength(4);
    for (const e of events) {
      expect(Math.abs(longitudeOffset(Body.Mars, Body.Saturn, e.timeUtc))).toBeLessThan(1e-3);
      const t = new Date(e.timeUtc);
      // timeUtc is rounded to the millisecond, so the recomputed angle matches closely, not exactly.
      expect(e.separationDegrees).toBeCloseTo(
        AngleBetween(GeoVector(Body.Mars, t, true), GeoVector(Body.Saturn, t, true)),
        6,
      );
      expect(e.timeLocal).toMatch(/\+09:00$/);
    }
  });

  it('stops a slow pair at the end of the supported span', () => {
    const jupiterSaturn = svc.findEvents('conjunction', {
      start: FROM,
      count: 5,
      body: 'jupiter',
      body2: 'saturn',
    });
    expect(jupiterSaturn.map((e) => e.timeUtc.slice(0, 10))).toEqual([
      '2040-10-31',
      '2060-04-07',
      '2080-03-15',
      '2100-09-18',
    ]);
    expect(
      svc.findEvents('conjunction', { start: FROM, count: 1, body: 'uranus', body2: 'neptune' }),
    ).toEqual([]);
  });

  /**
   * Conjunctions 1900–2100 for every planet pair, counted by a fixed 0.25-day scan of the
   * longitude offset. Mercury pairs are the ones a coarse scan undercounts: Mercury–Venus
   * reads 485 at a 10-day step and 493 at 5 days.
   */
  const PLANET_PAIR_COUNTS: Array<[PairBodyName, PairBodyName, number]> = [
    ['mercury', 'venus', 497],
    ['mercury', 'mars', 313],
    ['mercury', 'jupiter', 258],
    ['mercury', 'saturn', 257],
    ['mercury', 'uranus', 256],
    ['mercury', 'neptune', 252],
    ['mercury', 'pluto', 256],
    ['venus', 'mars', 168],
    ['venus', 'jupiter', 204],
    ['venus', 'saturn', 210],
    ['venus', 'uranus', 210],
    ['venus', 'neptune', 214],
    ['venus', 'pluto', 214],
    ['mars', 'jupiter', 92],
    ['mars', 'saturn', 102],
    ['mars', 'uranus', 114],
    ['mars', 'neptune', 110],
    ['mars', 'pluto', 108],
    ['jupiter', 'saturn', 15],
    ['jupiter', 'uranus', 33],
    ['jupiter', 'neptune', 26],
    ['jupiter', 'pluto', 20],
    ['saturn', 'uranus', 8],
    ['saturn', 'neptune', 10],
    ['saturn', 'pluto', 10],
    ['uranus', 'neptune', 3],
    ['uranus', 'pluto', 3],
    ['neptune', 'pluto', 0],
  ];

  it.each(PLANET_PAIR_COUNTS)(
    'finds every %s–%s conjunction of 1900–2100 (%i)',
    (body, body2, expected) => {
      const events = svc.findEvents('conjunction', {
        start: new Date('1900-01-01T00:00:00Z'),
        count: 1000,
        body,
        body2,
      });
      expect(events).toHaveLength(expected);
      for (let i = 1; i < events.length; i++) {
        expect(Date.parse(events[i]!.timeUtc)).toBeGreaterThan(Date.parse(events[i - 1]!.timeUtc));
      }
    },
  );

  it('finds every Moon–Mercury conjunction of 1900–2100', () => {
    const events = svc.findEvents('conjunction', {
      start: new Date('1900-01-01T00:00:00Z'),
      count: 3000,
      body: 'moon',
      body2: 'mercury',
    });
    expect(events).toHaveLength(2485);
  });

  it.each([
    ['mercury', 'venus'],
    ['moon', 'saturn'],
    ['venus', 'jupiter'],
  ] as const)(
    'resumes %s–%s an hour past the last event without repeating or skipping one',
    (body, body2) => {
      const start = new Date('1950-01-01T00:00:00Z');
      const uncapped = svc.findEvents('conjunction', { start, count: 40, body, body2 });
      const first = svc.findEvents('conjunction', { start, count: 20, body, body2 });
      const resumeAt = new Date(Date.parse(first.at(-1)!.timeUtc) + 3_600_000);
      const rest = svc.findEvents('conjunction', { start: resumeAt, count: 20, body, body2 });
      expect(rest[0]?.body2).toBe(body2);
      expectSameEvents([...first, ...rest], uncapped);
    },
  );

  it('resumes between the two closest conjunctions of any pair, a day and a half apart', () => {
    // Mercury–Venus in December 2069 is the tightest spacing of any pair in the span.
    const start = new Date('2069-12-01T00:00:00Z');
    const both = svc.findEvents('conjunction', {
      start,
      count: 2,
      body: 'mercury',
      body2: 'venus',
    });
    const gapDays = (Date.parse(both[1]!.timeUtc) - Date.parse(both[0]!.timeUtc)) / 86_400_000;
    expect(gapDays).toBeLessThan(2);
    const resumeAt = new Date(Date.parse(both[0]!.timeUtc) + 3_600_000);
    expectSameEvents(
      svc.findEvents('conjunction', { start: resumeAt, count: 1, body: 'mercury', body2: 'venus' }),
      [both[1]!],
    );
  });
});

describe('position', () => {
  it('places the Sun above the horizon at local noon and below at midnight in Seattle', () => {
    // 2024-06-21 ~20:00 UTC ≈ 13:00 local (PDT) — Sun should be high.
    const noon = svc.position(
      { kind: 'body', body: 'sun' },
      SEATTLE,
      new Date('2024-06-21T20:00:00Z'),
    );
    expect(noon.horizontal.altitudeDegrees).toBeGreaterThan(40);
    expect(noon.horizontal.aboveHorizon).toBe(true);

    // 2024-06-21 ~09:00 UTC ≈ 02:00 local — Sun should be below the horizon.
    const midnight = svc.position(
      { kind: 'body', body: 'sun' },
      SEATTLE,
      new Date('2024-06-21T09:00:00Z'),
    );
    expect(midnight.horizontal.altitudeDegrees).toBeLessThan(0);
    expect(midnight.horizontal.aboveHorizon).toBe(false);
  });

  it('computes a non-null magnitude and angular diameter for the Moon', () => {
    const pos = svc.position(
      { kind: 'body', body: 'moon' },
      SEATTLE,
      new Date('2024-04-23T08:00:00Z'),
    );
    expect(pos.magnitude).not.toBeNull();
    expect(pos.angularDiameterArcsec).not.toBeNull();
    // The Moon's angular diameter is ~1800 arcsec (~0.5°).
    expect(pos.angularDiameterArcsec!).toBeGreaterThan(1600);
    expect(pos.angularDiameterArcsec!).toBeLessThan(2100);
    expect(pos.constellation.abbreviation).toMatch(/^[A-Z][a-z]{2}$/);
  });

  it('resolves a catalog star (Sirius) and reports its catalog magnitude', () => {
    const target = svc.resolveStarTarget('Sirius');
    const pos = svc.position(
      { kind: 'star', star: target },
      SEATTLE,
      new Date('2024-01-15T04:00:00Z'),
    );
    expect(pos.body).toBe('Sirius');
    expect(pos.magnitude).toBeCloseTo(-1.46, 1);
    // Sirius is in Canis Major.
    expect(pos.constellation.abbreviation).toBe('CMa');
  });

  it('reports each target_s angular distance from the Sun', () => {
    // Seattle, 13:00 local on 2026-09-23: Mercury sits ~20° from the Sun.
    const instant = new Date('2026-09-23T20:00:00Z');
    const at = (body: 'sun' | 'mercury' | 'mars' | 'moon') =>
      svc.position({ kind: 'body', body }, SEATTLE, instant).sunElongationDegrees;
    expect(at('sun')).toBe(0);
    expect(at('mercury')).toBeCloseTo(19.9, 1);
    expect(at('mars')).toBeCloseTo(63.4, 1);
    expect(at('moon')).toBeCloseTo(145.3, 1);
    // A catalog star in a DefineStar slot has a real elongation too.
    const sirius = svc.position(
      { kind: 'star', star: svc.resolveStarTarget('Sirius') },
      SEATTLE,
      instant,
    );
    expect(sirius.sunElongationDegrees).toBeGreaterThan(0);
    expect(sirius.sunElongationDegrees).toBeLessThanOrEqual(180);
  });

  it('attaches a local time when a timezone is supplied', () => {
    const pos = svc.position(
      { kind: 'body', body: 'mars' },
      SEATTLE,
      new Date('2024-08-01T12:00:00Z'),
      'America/Los_Angeles',
    );
    expect(pos.timeLocal).toBeTruthy();
    expect(pos.timeLocal).toMatch(/-07:00$/); // PDT in August
  });
});

describe('riseSet', () => {
  it('retains ordinary Moon crossings at observer elevation', () => {
    const observer = { latitude: 47.6062, longitude: -122.3321, elevation: 2400 };
    const start = new Date('2026-09-07T12:00:00Z');
    const engineObserver = new Observer(observer.latitude, observer.longitude, observer.elevation);
    const event = svc.riseSet('moon', observer, start, 1)[0]!;
    expect(event.riseUtc).toBeNull();
    expect(event.setUtc).toBe(SearchRiseSet(Body.Moon, engineObserver, -1, start, 2)!.toString());
  });

  it('keeps the short below-horizon interval between genuine Moon crossings', () => {
    const events = svc.riseSet(
      'moon',
      { latitude: 68, longitude: 18.96, elevation: 0 },
      new Date('2026-09-07T12:00:00Z'),
      3,
    );
    expect(events[0]?.setUtc?.slice(0, 19)).toBe('2026-09-07T19:58:25');
    expect(events[1]?.riseUtc?.slice(0, 19)).toBe('2026-09-07T20:09:30');
  });

  it('does not admit an ascending Mars root as a set', () => {
    const events = svc.riseSet(
      'mars',
      { latitude: 70, longitude: 18.96, elevation: 0 },
      new Date('2028-01-07T11:57:45.137Z'),
      8,
    );
    expect(events[0]?.setUtc?.slice(0, 19)).toBe('2028-01-07T12:03:05');
    expect(new Set(events.map((event) => event.setUtc?.slice(0, 10))).size).toBe(8);
  });

  it.each([
    { body: 'moon', latitude: 68, root: '2026-09-07T19:58:25.249Z', kind: 'set' },
    { body: 'moon', latitude: 68, root: '2026-09-07T20:09:30.990Z', kind: 'rise' },
    { body: 'mars', latitude: 70, root: '2028-01-07T11:57:45.126Z', kind: 'rise' },
    { body: 'mars', latitude: 70, root: '2028-01-07T12:03:05.839Z', kind: 'set' },
    { body: 'mars', latitude: 70.00124875738454, root: '2028-01-07T12:00:25.029Z', kind: 'rise' },
    { body: 'mars', latitude: 70.00124875738454, root: '2028-01-07T12:00:25.937Z', kind: 'set' },
  ] as const)(
    'certifies $body crossings immediately around a shallow $kind',
    ({ body, latitude, root, kind }) => {
      const observer = { latitude, longitude: 18.96, elevation: 0 };
      const obs = new Observer(latitude, observer.longitude, 0);
      const target = body === 'moon' ? Body.Moon : Body.Mars;
      const residual = (ms: number) => {
        const date = new Date(ms);
        const eq = Equator(target, date, obs, true, true);
        const radius =
          body === 'moon'
            ? (Math.asin(1738.1 / (149597870.69098932 * eq.dist)) * 180) / Math.PI
            : 0;
        return (
          Horizon(date, obs, eq.ra, eq.dec).altitude +
          radius +
          (34 / 60) * Atmosphere(obs.height).density
        );
      };
      for (const offset of [-200, 200]) {
        const start = new Date(Date.parse(root) + offset);
        const search = svc.riseSetSearch(body, observer, start, 3);
        const first = search.events[0]!;
        if (kind === 'rise' && offset < 0)
          expect(Math.abs(Date.parse(first.riseUtc!) - Date.parse(root))).toBeLessThan(100);
        if (kind === 'set' && offset < 0)
          expect(Math.abs(Date.parse(first.setUtc!) - Date.parse(root))).toBeLessThan(100);
        if ((kind === 'rise' && offset > 0) || (kind === 'set' && offset < 0))
          expect(first.riseUtc).toBeNull();
        for (const event of search.events) {
          for (const [stamp, sign] of [
            [event.riseUtc, 1],
            [event.setUtc, -1],
          ] as const) {
            if (!stamp) continue;
            const ms = Date.parse(stamp);
            expect(ms).toBeGreaterThanOrEqual(start.getTime());
            expect(sign * residual(ms - 100), stamp).toBeLessThan(0);
            expect(sign * residual(ms + 100), stamp).toBeGreaterThan(0);
          }
          if (event.transitUtc && event.riseUtc)
            expect(Date.parse(event.transitUtc)).toBeGreaterThan(Date.parse(event.riseUtc));
          if (event.transitUtc && event.setUtc)
            expect(Date.parse(event.transitUtc)).toBeLessThan(Date.parse(event.setUtc));
        }
        const continued = svc.riseSetSearch(body, observer, search.resumeAt, 2);
        const whole = svc.riseSetSearch(body, observer, start, 5);
        expect([...search.events, ...continued.events]).toEqual(whole.events);
      }
    },
  );
  it('computes a sunrise before a sunset for Seattle on the summer solstice', () => {
    // 09:00Z is 02:00 local, while the Sun is still down, so this cycle is a complete
    // rise-then-set. The original 00:00Z start is 17:00 local with the Sun already up,
    // where the returned pair was tomorrow's rise beside tonight's set — the test passed
    // while contradicting its own name. The already-up case is covered on its own below.
    const events = svc.riseSet('sun', SEATTLE, new Date('2024-06-21T09:00:00Z'), 1);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.riseUtc).toBeTruthy();
    expect(e.setUtc).toBeTruthy();
    expect(Date.parse(e.riseUtc as string)).toBeLessThan(Date.parse(e.setUtc as string));
    // Seattle sunrise on the solstice is ~05:11 local (12:11 UTC); set ~21:11 local (04:11 UTC next day).
    const rise = new Date(e.riseUtc as string);
    expect(rise.getUTCHours()).toBeGreaterThanOrEqual(11);
    expect(rise.getUTCHours()).toBeLessThanOrEqual(13);
    // The Sun branch carries twilight.
    expect(e.twilight).toBeDefined();
    expect(e.twilight?.astronomical).toBeDefined();
  });

  /**
   * 20:00Z is 13:00 local in Seattle, with the Sun well up. Searching for the next rise
   * and the next set independently from that instant pairs tonight's set with tomorrow's
   * rise, so the cycle reads as a set nine and a half hours before its own rise.
   */
  const SUN_UP_START = new Date('2026-08-11T20:00:00Z');

  it('reports the interval in progress rather than pairing tonight_s set with tomorrow_s rise', () => {
    const [cycle] = svc.riseSet('sun', SEATTLE, SUN_UP_START, 1);
    // The rise that opened this interval is behind `start`, and riseSet only searches
    // forward, so the honest answer is a partial cycle that names the imminent set.
    expect(cycle?.riseUtc).toBeNull();
    expect(cycle?.setUtc).toBeTruthy();
    expect(cycle?.note).toMatch(/[Aa]lready above the horizon/);
    // Tonight's set, not tomorrow's: within a day of the start rather than beyond it.
    const set = Date.parse(cycle?.setUtc as string);
    expect(set).toBeGreaterThan(SUN_UP_START.getTime());
    expect(set - SUN_UP_START.getTime()).toBeLessThan(24 * 3600 * 1000);
  });

  it('never reports a set before its own rise, for any body or cycle', () => {
    for (const body of ['sun', 'moon', 'mars'] as const) {
      for (const start of [SUN_UP_START, new Date('2026-08-11T09:00:00Z')]) {
        for (const cycle of svc.riseSet(body, SEATTLE, start, 4)) {
          if (!cycle.riseUtc || !cycle.setUtc) continue;
          expect(
            Date.parse(cycle.setUtc),
            `${body} from ${start.toISOString()}: set ${cycle.setUtc} precedes rise ${cycle.riseUtc}`,
          ).toBeGreaterThan(Date.parse(cycle.riseUtc));
        }
      }
    }
  });

  it('advances one cycle at a time instead of skipping a day', () => {
    // The cursor used to advance a full day past the cycle's rise, which lands beyond the
    // following day's set — so a multi-count call silently dropped an entire day's set.
    const sets = svc
      .riseSet('sun', SEATTLE, SUN_UP_START, 4)
      .map((c) => c.setUtc)
      .filter((s): s is string => s !== null)
      .map((s) => Date.parse(s));
    expect(sets.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < sets.length; i++) {
      const gapHours = ((sets[i] as number) - (sets[i - 1] as number)) / 3600000;
      expect(gapHours, `sets ${i - 1}->${i} are ${gapHours.toFixed(1)}h apart`).toBeLessThan(30);
    }
  });

  it('keeps the transit inside the cycle it is reported with', () => {
    for (const cycle of svc.riseSet('sun', SEATTLE, SUN_UP_START, 3)) {
      if (!cycle.transitUtc) continue;
      const transit = Date.parse(cycle.transitUtc);
      if (cycle.riseUtc) expect(transit).toBeGreaterThan(Date.parse(cycle.riseUtc));
      if (cycle.setUtc) expect(transit).toBeLessThan(Date.parse(cycle.setUtc));
    }
  });

  it('anchors each cycle_s twilight to that cycle_s own evening', () => {
    // The twilight pair used to be searched from the resume cursor, which sits between
    // sunset and civil dusk — so the following cycle came back carrying the previous
    // evening's twilight while its own rise and set had moved on a day.
    for (const cycle of svc.riseSet('sun', SEATTLE, SUN_UP_START, 3)) {
      const dusk = cycle.twilight?.civil.duskUtc;
      if (!dusk || !cycle.setUtc) continue;
      const afterSetMinutes = (Date.parse(dusk) - Date.parse(cycle.setUtc)) / 60000;
      expect(
        afterSetMinutes,
        `civil dusk ${dusk} should follow this cycle's set ${cycle.setUtc}`,
      ).toBeGreaterThan(0);
      expect(afterSetMinutes).toBeLessThan(120);
    }
  });

  /**
   * Each cycle's twilight covers the night after its set: dusk that evening, dawn the next
   * morning. The dawn beside a cycle's sunrise is therefore a day later than that sunrise,
   * and the dawn before the sunrise belongs to the previous cycle's pair. The tool and
   * README document that pairing; this pins it so the documentation cannot drift from it.
   */
  it('pairs each cycle_s dusk with the following morning_s dawn', () => {
    // 07:00Z is 00:00 local in Seattle, before the 2026-09-23 sunrise.
    const cycles = svc.riseSet(
      'sun',
      SEATTLE,
      new Date('2026-09-23T07:00:00Z'),
      3,
      'America/Los_Angeles',
    );
    expect(cycles).toHaveLength(3);
    for (const [i, cycle] of cycles.entries()) {
      const rise = Date.parse(cycle.riseUtc as string);
      const set = Date.parse(cycle.setUtc as string);
      for (const depth of ['civil', 'nautical', 'astronomical'] as const) {
        const pair = cycle.twilight![depth];
        const dusk = Date.parse(pair.duskUtc as string);
        const dawn = Date.parse(pair.dawnUtc as string);
        const label = `cycle ${i} ${depth}`;
        // Dusk falls on the evening of this cycle's set, dawn after it — never before the rise.
        expect(dusk, label).toBeGreaterThan(set);
        expect(dawn, label).toBeGreaterThan(dusk);
        expect(dawn - rise, label).toBeGreaterThan(20 * 3600 * 1000);
        // The dawn opens the next cycle's day: it precedes that cycle's rise within hours.
        const next = cycles[i + 1];
        if (next) {
          const lead = Date.parse(next.riseUtc as string) - dawn;
          expect(lead, label).toBeGreaterThan(0);
          expect(lead, label).toBeLessThan(3 * 3600 * 1000);
        }
      }
    }
    // The measured repro: rise and set on 23 September local, civil dawn on the 24th.
    const civil = cycles[0]!.twilight!.civil;
    expect(cycles[0]!.riseLocal?.slice(0, 10)).toBe('2026-09-23');
    expect(civil.duskLocal?.slice(0, 10)).toBe('2026-09-23');
    expect(civil.dawnLocal?.slice(0, 10)).toBe('2026-09-24');
  });

  /**
   * A mid-latitude September series, pinned whole: each cycle's rise and set, the twilight
   * of nights that reach every depth, and the instant a continuation resumes from — one
   * second past the last set.
   */
  it('pins a mid-latitude series: rise, set, full twilight, and resume point', () => {
    const sun = svc.riseSetSearch('sun', SEATTLE, new Date('2026-09-23T07:00:00Z'), 3);
    expect(sun.events.map((e) => [e.riseUtc?.slice(0, 16), e.setUtc?.slice(0, 16)])).toEqual([
      ['2026-09-23T13:57', '2026-09-24T02:04'],
      ['2026-09-24T13:59', '2026-09-25T02:02'],
      ['2026-09-25T14:00', '2026-09-26T02:00'],
    ]);
    expect(sun.events[0]?.twilight).toEqual({
      civil: { dawnUtc: '2026-09-24T13:28:21.001Z', duskUtc: '2026-09-24T02:35:14.652Z' },
      nautical: { dawnUtc: '2026-09-24T12:52:14.597Z', duskUtc: '2026-09-24T03:11:17.352Z' },
      astronomical: { dawnUtc: '2026-09-24T12:15:07.007Z', duskUtc: '2026-09-24T03:48:21.931Z' },
    });
    expect(sun.events[1]?.twilight).toEqual({
      civil: { dawnUtc: '2026-09-25T13:29:43.351Z', duskUtc: '2026-09-25T02:33:10.620Z' },
      nautical: { dawnUtc: '2026-09-25T12:53:40.430Z', duskUtc: '2026-09-25T03:09:09.762Z' },
      astronomical: { dawnUtc: '2026-09-25T12:16:39.748Z', duskUtc: '2026-09-25T03:46:07.375Z' },
    });
    expect(sun.resumeAt.toISOString()).toBe('2026-09-26T02:00:28.150Z');
    const moon = svc.riseSetSearch('moon', SEATTLE, new Date('2026-10-15T04:00:00Z'), 2);
    expect(moon.resumeAt.toISOString()).toBe('2026-10-17T04:44:07.461Z');
  });

  /** London — astronomical twilight returns in late July after its midsummer absence. */
  const LONDON = { latitude: 51.5, longitude: -0.12, elevation: 0 };

  it('nulls a depth the cycle_s night never reaches instead of borrowing a later night_s', () => {
    const [cycle] = svc.riseSet('sun', LONDON, new Date('2026-07-20T00:00:00Z'), 1);
    expect(cycle?.setUtc).toBe('2026-07-20T20:05:45.758Z');
    // The Sun gets no deeper than −18° that night; the next night's dusk and dawn fall
    // 27.6 h and 28.4 h after this set, past the next sunrise that bounds this night.
    expect(cycle?.twilight?.astronomical).toEqual({ dawnUtc: null, duskUtc: null });
  });

  it('keeps every twilight time between its cycle_s set and the next rise', () => {
    const sites = {
      London: LONDON,
      Paris: { latitude: 48.86, longitude: 2.35, elevation: 0 },
      Helsinki: { latitude: 60.17, longitude: 24.94, elevation: 0 },
    };
    for (const [name, site] of Object.entries(sites)) {
      const cycles = svc.riseSet('sun', site, new Date('2026-04-15T12:00:00Z'), 141);
      for (const [i, cycle] of cycles.slice(0, -1).entries()) {
        const set = Date.parse(cycle.setUtc as string);
        const nextRise = Date.parse(cycles[i + 1]!.riseUtc as string);
        for (const depth of ['civil', 'nautical', 'astronomical'] as const) {
          for (const at of [cycle.twilight![depth].duskUtc, cycle.twilight![depth].dawnUtc]) {
            if (at === null) continue;
            const label = `${name} set ${cycle.setUtc} ${depth} ${at}`;
            expect(Date.parse(at), label).toBeGreaterThan(set);
            expect(Date.parse(at), label).toBeLessThan(nextRise);
          }
        }
      }
    }
  });

  /**
   * After sunset the first cycle opens at the next sunrise, so its twilight is the night
   * after that — the night under way at `start` is carried separately.
   */
  describe('the night in progress', () => {
    const TZ = 'America/Los_Angeles';
    /** HH:MM local of an ISO local timestamp, with its calendar date. */
    const hhmm = (local: string | null | undefined) => local?.slice(0, 16);

    it('reports the night under way after sunset, every depth bounded by that night', () => {
      // 19:00 local, after the 18:22 sunset and inside nautical twilight.
      const search = svc.riseSetSearch('sun', SEATTLE, new Date('2026-10-15T02:00:00Z'), 1, TZ);
      const night = search.nightInProgress!;
      expect(hhmm(night.civil.duskLocal)).toBe('2026-10-14T18:53');
      expect(hhmm(night.civil.dawnLocal)).toBe('2026-10-15T06:57');
      expect(hhmm(night.nautical.duskLocal)).toBe('2026-10-14T19:29');
      expect(hhmm(night.nautical.dawnLocal)).toBe('2026-10-15T06:21');
      expect(hhmm(night.astronomical.duskLocal)).toBe('2026-10-14T20:04');
      expect(hhmm(night.astronomical.dawnLocal)).toBe('2026-10-15T05:45');
      // The cycles are untouched: the first still opens at the next sunrise.
      expect(search.events).toHaveLength(1);
      expect(hhmm(search.events[0]?.riseLocal)).toBe('2026-10-15T07:28');
    });

    it('reports the same night from a pre-dawn start, including dawns already passed', () => {
      const evening = svc.riseSetSearch('sun', SEATTLE, new Date('2026-10-15T02:00:00Z'), 1, TZ);
      const predawn = svc.riseSetSearch('sun', SEATTLE, new Date('2026-10-15T13:30:00Z'), 1, TZ);
      expect(predawn.nightInProgress).toEqual(evening.nightInProgress);
      // 06:30 local: astronomical and nautical dawn precede the start and are still there.
      expect(hhmm(predawn.nightInProgress?.astronomical.dawnLocal)).toBe('2026-10-15T05:45');
      expect(hhmm(predawn.nightInProgress?.nautical.dawnLocal)).toBe('2026-10-15T06:21');
    });

    it('is absent while the Sun is up', () => {
      expect(svc.riseSetSearch('sun', SEATTLE, SUN_UP_START, 1).nightInProgress).toBeUndefined();
    });

    it('distinguishes a polar morning night from midnight sun without horizon crossings', () => {
      const observer = { latitude: 89, longitude: 0, elevation: 0 };
      const midnightSun = svc.riseSetSearch('sun', observer, new Date('2027-06-21T06:00:00Z'), 1);
      expect(midnightSun.nightInProgress).toBeUndefined();
      const dark = svc.riseSetSearch('sun', observer, new Date('2027-12-21T06:00:00Z'), 1);
      expect(dark.nightInProgress).toEqual({
        civil: { dawnUtc: null, duskUtc: null },
        nautical: { dawnUtc: null, duskUtc: null },
        astronomical: { dawnUtc: null, duskUtc: null },
      });
    });

    it('bounds the preceding night by a first day with no sunrise', () => {
      const observer = { latitude: 69.65, longitude: 18.96, elevation: 0 };
      const search = svc.riseSetSearch('sun', observer, new Date('2026-12-10T06:00:00Z'), 1);
      expect(search.events[0]?.riseUtc).toBeNull();
      expect(search.nightInProgress?.civil).toEqual({
        dawnUtc: '2026-12-10T08:14:44.187Z',
        duskUtc: '2026-12-09T13:00:09.733Z',
      });
      expect(search.events[0]?.twilight?.civil.duskUtc).toBe('2026-12-10T12:58:42.578Z');
    });

    it('nulls a depth that night never reaches', () => {
      const { nightInProgress } = svc.riseSetSearch(
        'sun',
        LONDON,
        new Date('2026-06-21T22:30:00Z'),
        1,
      );
      expect(nightInProgress).toEqual({
        civil: { dawnUtc: '2026-06-22T02:55:35.269Z', duskUtc: '2026-06-21T21:09:13.924Z' },
        nautical: { dawnUtc: '2026-06-22T01:40:59.682Z', duskUtc: '2026-06-21T22:23:49.497Z' },
        astronomical: { dawnUtc: null, duskUtc: null },
      });
    });

    it('reports the preceding polar night without a sunset in the look-back window', () => {
      // Tromsø the morning the polar night ends: a sunrise lies ahead, but no sunset behind.
      const tromso = { latitude: 69.65, longitude: 18.96, elevation: 0 };
      const search = svc.riseSetSearch('sun', tromso, new Date('2027-01-15T06:00:00Z'), 1);
      expect(search.events[0]?.riseUtc).toBe('2027-01-15T10:34:40.655Z');
      expect(search.nightInProgress?.civil).toEqual({
        duskUtc: '2027-01-14T13:46:24.184Z',
        dawnUtc: '2027-01-15T07:57:48.572Z',
      });
    });

    /**
     * Where the polar night lasts a day or two, the sunset inside the two-day look-back can
     * precede a day the Sun never rose on. That sunset began an earlier night, which ended
     * before `start`, so it is not the night under way.
     */
    it('is absent after the culmination of a day the Sun never rose on', () => {
      // 67.4° N on the afternoon of 2026-12-21, a day without a sunrise: the first cycle is
      // the rest of that day and carries its night; the sunset of the 20th is behind it.
      const north = svc.riseSetSearch(
        'sun',
        { latitude: 67.4, longitude: 18.96, elevation: 0 },
        new Date('2026-12-21T15:42:11.858Z'),
        4,
      );
      expect(north.nightInProgress).toBeUndefined();
      expect(north.events[0]?.transitUtc).toBeNull();
      expect(north.events[0]?.twilight?.civil.duskUtc).toBe('2026-12-21T13:29:35.001Z');
    });

    it('reports the preceding night before the first sunrise after a day the Sun never rose on', () => {
      // 67.39° S before dawn on 2027-06-22: the 21st had no sunrise, and the sunset of the
      // 20th began the night that ended on the 21st.
      const south = svc.riseSetSearch(
        'sun',
        { latitude: -67.39, longitude: -68.13, elevation: 0 },
        new Date('2027-06-22T06:34:32.666Z'),
        3,
      );
      expect(south.nightInProgress).toEqual({
        civil: { duskUtc: '2027-06-21T19:21:49.002Z', dawnUtc: '2027-06-22T13:47:00.278Z' },
        nautical: { duskUtc: '2027-06-21T20:46:58.639Z', dawnUtc: '2027-06-22T12:21:51.870Z' },
        astronomical: { duskUtc: '2027-06-21T21:56:23.615Z', dawnUtc: '2027-06-22T11:12:27.358Z' },
      });
      expect(south.events[0]?.riseUtc).toBe('2027-06-22T16:30:26.788Z');
    });

    it('is never computed for a body other than the Sun', () => {
      for (const body of ['moon', 'mars'] as const) {
        const search = svc.riseSetSearch(body, SEATTLE, new Date('2026-10-15T04:00:00Z'), 2);
        expect(search.nightInProgress).toBeUndefined();
        expect(search.events).toHaveLength(2);
      }
    });
  });

  it('reports the Sun as circumpolar at the North Pole in June', () => {
    const events = svc.riseSet(
      'sun',
      { latitude: 89.9, longitude: 0, elevation: 0 },
      new Date('2024-06-21T00:00:00Z'),
      1,
    );
    const e = events[0]!;
    expect(e.riseUtc).toBeNull();
    expect(e.setUtc).toBeNull();
    expect(e.note).toMatch(/[Cc]ircumpolar/);
  });

  /**
   * A cycle is one of the body's days. A day with no rise or no set — polar night, midnight
   * sun, a day the Moon spends wholly below the horizon — is a cycle of its own, and a Sun
   * cycle carries the night after its day, so consecutive cycles cover consecutive days and
   * each night lands in exactly one cycle, across any number of continuation calls.
   */
  describe('polar days', () => {
    const TROMSO = { latitude: 69.65, longitude: 18.96, elevation: 0 };
    const SVALBARD = { latitude: 78.22, longitude: 15.65, elevation: 0 };
    const minute = (iso: string | null | undefined) => iso?.slice(0, 16) ?? null;
    const dayOf = (iso: string | null | undefined) => iso?.slice(0, 10) ?? null;
    const civil = (e: RiseSetEvent) => [e.twilight?.civil.duskUtc, e.twilight?.civil.dawnUtc];
    const ENGINE: Partial<Record<string, Body>> = {
      sun: Body.Sun,
      moon: Body.Moon,
      venus: Body.Venus,
    };

    /** Every upper culmination of a body from `from` up to (not including) `until`. */
    const culminationsBetween = (body: string, site: typeof TROMSO, from: Date, until: number) => {
      const obs = new Observer(site.latitude, site.longitude, site.elevation);
      const out: number[] = [];
      for (let at = from; ; ) {
        const next = SearchHourAngle(ENGINE[body]!, obs, 0, at, +1).time.date.getTime();
        if (next >= until) return out;
        out.push(next);
        at = new Date(next + 60_000);
      }
    };

    /** Every time the Sun's center descends through `altitude` between two instants. */
    const dusksBetween = (site: typeof TROMSO, altitude: number, from: Date, until: number) => {
      const obs = new Observer(site.latitude, site.longitude, site.elevation);
      const out: number[] = [];
      for (let at = from; at.getTime() < until; ) {
        const days = (until - at.getTime()) / 86_400_000;
        const dusk = SearchAltitude(Body.Sun, obs, -1, at, days, altitude);
        if (!dusk) return out;
        out.push(dusk.date.getTime());
        at = new Date(dusk.date.getTime() + 60_000);
      }
      return out;
    };

    it('gives the first never-rises day the night after its own culmination', () => {
      // The polar night begins at Tromsø on 2026-11-28.
      const [lastSunrise, firstDark] = svc.riseSet(
        'sun',
        TROMSO,
        new Date('2026-11-26T23:00:00Z'),
        2,
      );
      expect(dayOf(lastSunrise?.riseUtc)).toBe('2026-11-27');
      expect(civil(lastSunrise!)).toEqual(['2026-11-27T13:26:39.727Z', '2026-11-28T07:39:29.525Z']);
      expect(firstDark?.riseUtc).toBeNull();
      expect(minute(firstDark?.transitUtc)).toBe('2026-11-28T10:32');
      expect(firstDark?.note).toBe('Never rises above the horizon at this latitude/date.');
      // That day's own night — not the night of the 27th again.
      expect(civil(firstDark!)).toEqual(['2026-11-28T13:23:55.715Z', '2026-11-29T07:42:51.928Z']);
    });

    it('keeps the last never-rises day before the Sun returns', () => {
      // 2027-01-14 is the last day without a sunrise; it and the nights of the 13th and 14th
      // each get a cycle before the sunrise of the 15th opens the next.
      const cycles = svc.riseSet('sun', TROMSO, new Date('2027-01-12T12:00:00Z'), 4);
      expect(cycles.map((e) => dayOf(e.transitUtc))).toEqual([
        null,
        '2027-01-13',
        '2027-01-14',
        '2027-01-15',
      ]);
      expect(dayOf(cycles[3]?.riseUtc)).toBe('2027-01-15');
      expect(cycles.map((e) => dayOf(e.twilight?.civil.duskUtc))).toEqual([
        '2027-01-12',
        '2027-01-13',
        '2027-01-14',
        '2027-01-15',
      ]);
    });

    it('keeps the last midnight-sun day before the Sun sets again', () => {
      // The 24th has no sunset and the 25th's is its own cycle's, not the 24th's.
      const cycles = svc.riseSet('sun', TROMSO, new Date('2026-07-23T00:00:00Z'), 4);
      expect(cycles.map((e) => dayOf(e.transitUtc))).toEqual([
        '2026-07-23',
        '2026-07-24',
        '2026-07-25',
        '2026-07-26',
      ]);
      expect(cycles[1]?.setUtc).toBeNull();
      expect(cycles[2]?.setUtc).toBe('2026-07-25T22:36:24.735Z');
    });

    it('notes a cycle that opens with the Sun up the same way at every position', () => {
      // The midnight sun ends with the 2026-07-25 sunset: that cycle opens with the Sun
      // already up, as its second cycle here and as the first of a call started there.
      const start = new Date('2026-07-24T09:50:42.696Z');
      const firstSet = svc.riseSet('sun', TROMSO, start, 2)[1]!;
      expect(firstSet).toMatchObject({ riseUtc: null, setUtc: '2026-07-25T22:36:24.735Z' });
      const note = 'Already above the horizon when this cycle opens — no rise in this cycle.';
      expect(firstSet.note).toBe(note);
      const { resumeAt } = svc.riseSetSearch('sun', TROMSO, start, 1);
      const [paged] = svc.riseSet('sun', TROMSO, resumeAt, 1);
      expect(paged).toEqual(firstSet);
    });

    it('keeps a rise and set that follow the start on the day it falls in', () => {
      // 89.9° N near the March equinox: the Sun culminated below the horizon at 10:52Z, then
      // rises a second after `start` and sets again before the day's lower culmination.
      const [first] = svc.riseSet(
        'sun',
        { latitude: 89.9, longitude: 18.96, elevation: 0 },
        new Date('2027-03-18T12:10:26.779Z'),
        1,
      );
      expect(first?.riseUtc).toBe('2027-03-18T12:10:27.852Z');
      expect(first?.setUtc).toBe('2027-03-18T14:53:56.784Z');
    });

    it('opens a polar-night afternoon with the rest of that day and its night', () => {
      // 2026-12-10 at Tromsø: the Sun culminates below the horizon at 10:37Z.
      const [rest, next] = svc.riseSet('sun', TROMSO, new Date('2026-12-10T12:00:00Z'), 2);
      expect(rest).toMatchObject({
        riseUtc: null,
        setUtc: null,
        transitUtc: null,
        transitAltitudeDegrees: null,
      });
      expect(rest?.note).toBe(
        'Below the horizon for the rest of a day whose culmination precedes the search start: no rise, set, or transit remains, and the twilight is the night that follows it.',
      );
      expect(civil(rest!)).toEqual(['2026-12-10T12:58:42.578Z', '2026-12-11T08:16:59.773Z']);
      expect(minute(next?.transitUtc)).toBe('2026-12-11T10:37');
      expect(dayOf(next?.twilight?.civil.duskUtc)).toBe('2026-12-11');
      // Started after that dusk, the night keeps it rather than reading as one it never reaches.
      const [late] = svc.riseSet('sun', TROMSO, new Date('2026-12-10T20:00:00Z'), 1);
      expect(civil(late!)).toEqual(['2026-12-10T12:58:42.578Z', '2026-12-11T08:16:59.773Z']);
    });

    it('opens the evening of the last sunset with that night, and no night in progress', () => {
      // The Sun set at 10:42Z and does not rise within the forward window, so the night
      // under way has no defined end and is carried by the first cycle instead.
      const start = new Date('2026-11-27T15:00:00Z');
      const sunset = SearchRiseSet(Body.Sun, new Observer(69.65, 18.96, 0), -1, start, -2);
      expect(sunset?.date.toISOString().slice(0, 16)).toBe('2026-11-27T10:42');
      const search = svc.riseSetSearch('sun', TROMSO, start, 2);
      const [rest, firstDark] = search.events;
      expect(rest).toMatchObject({ riseUtc: null, setUtc: null, transitUtc: null });
      expect(civil(rest!)).toEqual(['2026-11-27T13:26:39.728Z', '2026-11-28T07:39:29.525Z']);
      expect(minute(firstDark?.transitUtc)).toBe('2026-11-28T10:32');
      expect(dayOf(firstDark?.twilight?.civil.duskUtc)).toBe('2026-11-28');
      expect(search.nightInProgress).toBeUndefined();
    });

    it('resumes past a polar-night boundary without repeating its night', () => {
      // The last sunrise day alone, then a continuation from where it stopped.
      const lastSunrise = svc.riseSetSearch('sun', TROMSO, new Date('2026-11-27T05:00:00Z'), 1);
      const [after] = svc.riseSet('sun', TROMSO, lastSunrise.resumeAt, 1);
      expect(dayOf(lastSunrise.events[0]?.twilight?.civil.duskUtc)).toBe('2026-11-27');
      expect(minute(after?.transitUtc)).toBe('2026-11-28T10:32');
      expect(dayOf(after?.twilight?.civil.duskUtc)).toBe('2026-11-28');
      // The rest of a dark day resumes at the next day, not at a second rest of the same one.
      const rest = svc.riseSetSearch('sun', TROMSO, new Date('2026-12-10T12:00:00Z'), 1);
      const [following] = svc.riseSet('sun', TROMSO, rest.resumeAt, 1);
      expect(minute(following?.transitUtc)).toBe('2026-12-11T10:37');
      expect(dayOf(following?.twilight?.civil.duskUtc)).toBe('2026-12-11');
    });

    it('reports every culmination once and every Sun night once across a polar year', () => {
      const walks = [
        { body: 'sun', site: TROMSO, start: '2026-07-01T09:00:00Z', count: 366 },
        { body: 'sun', site: SVALBARD, start: '2026-01-01T18:00:00Z', count: 366 },
        { body: 'moon', site: TROMSO, start: '2026-01-03T00:00:00Z', count: 200 },
        {
          body: 'moon',
          site: { latitude: 64, longitude: 18.96, elevation: 0 },
          start: '2026-01-03T00:00:00Z',
          count: 200,
        },
        { body: 'venus', site: TROMSO, start: '2026-01-03T07:13:00Z', count: 366 },
      ] as const;
      for (const { body, site, start, count } of walks) {
        const label = `${body} at ${site.latitude} from ${start}`;
        const cycles = svc.riseSet(body, site, new Date(start), count);
        expect(cycles, label).toHaveLength(count);
        const last = cycles.at(-1)!;
        const until = Date.parse(last.riseUtc ?? last.transitUtc ?? last.setUtc!);
        const transits = cycles.flatMap((e) => (e.transitUtc ? [Date.parse(e.transitUtc)] : []));
        // No culmination reported twice, none stepped over.
        const expected = culminationsBetween(
          body,
          site,
          new Date(start),
          transits.at(-1)! + 60_000,
        );
        const missing = expected.filter((t) => !transits.some((r) => Math.abs(r - t) < 120_000));
        expect(
          missing.map((t) => new Date(t).toISOString()),
          label,
        ).toEqual([]);
        expect(transits, label).toHaveLength(expected.length);
        if (body !== 'sun') continue;
        for (const [depth, altitude] of [
          ['civil', -6],
          ['nautical', -12],
          ['astronomical', -18],
        ] as const) {
          const dusks = cycles.flatMap((e) => {
            const d = e.twilight![depth].duskUtc;
            return d ? [Date.parse(d)] : [];
          });
          // No night in two cycles, and none dropped between them.
          expect(new Set(dusks).size, `${label} ${depth}`).toBe(dusks.length);
          const actual = dusksBetween(site, altitude, new Date(start), until);
          const dropped = actual.filter((t) => !dusks.some((r) => Math.abs(r - t) < 120_000));
          expect(
            dropped.map((t) => new Date(t).toISOString()),
            `${label} ${depth}`,
          ).toEqual([]);
          for (const e of cycles) {
            const { duskUtc, dawnUtc } = e.twilight![depth];
            if (duskUtc && dawnUtc) {
              expect(Date.parse(dawnUtc), label).toBeGreaterThan(Date.parse(duskUtc));
            }
          }
        }
      }
    });

    it('serves a paged series across polar transitions exactly as one search does', () => {
      const walks = [
        { body: 'sun', site: TROMSO, start: '2026-11-01T12:00:00Z', count: 100 },
        { body: 'sun', site: TROMSO, start: '2026-12-10T12:00:00Z', count: 70 },
        { body: 'sun', site: SVALBARD, start: '2026-04-01T00:00:00Z', count: 100 },
        { body: 'sun', site: SVALBARD, start: '2026-08-01T00:00:00Z', count: 100 },
        { body: 'moon', site: TROMSO, start: '2026-01-03T00:00:00Z', count: 100 },
      ] as const;
      for (const { body, site, start, count } of walks) {
        const label = `${body} at ${site.latitude} from ${start}`;
        const direct = svc.riseSet(body, site, new Date(start), count);
        const paged: RiseSetEvent[] = [];
        let cursor = new Date(start);
        let pages = 0;
        while (paged.length < count) {
          const page = svc.riseSetSearch(body, site, cursor, Math.min(31, count - paged.length));
          paged.push(...page.events);
          cursor = page.resumeAt;
          pages++;
        }
        expect(pages, label).toBeGreaterThanOrEqual(3);
        expect(paged, label).toEqual(direct);
      }
    });
  });
});

/**
 * A zoneless timestamp has no zone designator, so `new Date` reads it in the host's zone
 * and the same request resolves to a different instant on a differently-configured
 * deployment. The tools document their times as UTC, so UTC is what a zoneless value has
 * to mean — and the invariance across zones, not any single value, is the property.
 */
describe('resolveTime — zoneless timestamps resolve identically in every host zone', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  /** The instant `value` resolves to with the host configured for `tz`. */
  function resolvedUnder(tz: string, value: string): string {
    process.env.TZ = tz;
    return svc.resolveTime(value).toISOString();
  }

  it.each([
    ['T separator', '2026-06-30T12:00:00', '2026-06-30T12:00:00.000Z'],
    ['space separator', '2026-06-30 12:00:00', '2026-06-30T12:00:00.000Z'],
    ['no seconds', '2026-06-30T12:00', '2026-06-30T12:00:00.000Z'],
    ['fractional seconds', '2026-06-30T12:00:00.500', '2026-06-30T12:00:00.500Z'],
    ['date only', '2026-06-30', '2026-06-30T00:00:00.000Z'],
  ])('reads a %s form as UTC in either host zone', (_label, value, expected) => {
    expect(resolvedUnder('UTC', value)).toBe(expected);
    expect(resolvedUnder('America/Los_Angeles', value)).toBe(expected);
    expect(resolvedUnder('Asia/Tokyo', value)).toBe(expected);
  });

  it.each([
    ['Z', '2026-06-30T12:00:00Z', '2026-06-30T12:00:00.000Z'],
    ['positive offset', '2026-06-30T12:00:00+05:00', '2026-06-30T07:00:00.000Z'],
    ['negative offset', '2026-06-30T12:00:00-07:00', '2026-06-30T19:00:00.000Z'],
    ['offset without a colon', '2026-06-30T12:00:00+0500', '2026-06-30T07:00:00.000Z'],
  ])('leaves an explicit %s zone alone', (_label, value, expected) => {
    expect(resolvedUnder('UTC', value)).toBe(expected);
    expect(resolvedUnder('America/Los_Angeles', value)).toBe(expected);
  });

  it('still rejects an impossible calendar date in a non-UTC host zone', () => {
    // The zone normalization must not become a way past the #23 calendar check.
    process.env.TZ = 'America/Los_Angeles';
    expect(() => svc.resolveTime('2026-02-30T12:00:00')).toThrow(/Invalid time/);
    expect(() => svc.resolveTime('2026-06-31')).toThrow(/Invalid time/);
  });
});

describe('listVisible', () => {
  it('gates daytime: the Sun is up and the condition is daylight at Seattle noon', () => {
    const result = svc.listVisible(SEATTLE, new Date('2024-06-21T20:00:00Z'), {
      minAltitude: 0,
      includeStars: false,
    });
    expect(result.skyCondition).toBe('daylight');
    expect(result.sunAltitudeDegrees).toBeGreaterThan(0);
    // The Sun should be in the ranked list and ranked #1 (brightest).
    const sun = result.bodies.find((b) => b.body === 'sun');
    expect(sun).toBeDefined();
    expect(sun?.rank).toBe(1);
  });

  it('gates a dark sky after astronomical dusk and includes stars when asked', () => {
    // Deep night in winter Seattle.
    const result = svc.listVisible(SEATTLE, new Date('2024-01-15T11:00:00Z'), {
      minAltitude: 0,
      includeStars: true,
    });
    expect(['nautical_twilight', 'astronomical_twilight', 'dark']).toContain(result.skyCondition);
    // At least one catalog star should be above the horizon.
    const hasStar = result.bodies.some((b) => b.body === 'Sirius' || b.body === 'Polaris');
    expect(hasStar).toBe(true);
    // Every body carries a visibility note.
    for (const b of result.bodies) {
      expect(b.visibilityNote.length).toBeGreaterThan(0);
    }
  });

  it('ranks brighter objects ahead of fainter ones', () => {
    const result = svc.listVisible(SEATTLE, new Date('2024-01-15T11:00:00Z'), {
      minAltitude: 0,
      includeStars: true,
    });
    const withMag = result.bodies.filter((b) => b.magnitude !== null);
    for (let i = 1; i < withMag.length; i++) {
      expect(withMag[i]!.magnitude!).toBeGreaterThanOrEqual(withMag[i - 1]!.magnitude!);
    }
  });

  it('excludes non-naked-eye bodies (Uranus, Neptune, Pluto) from the default list', () => {
    // The tool advertises a naked-eye surface. This instant (the #4 repro) puts Neptune
    // and Pluto above the horizon, so their absence proves the nakedEye guard excludes
    // them rather than the altitude filter; naked-eye Saturn must still appear.
    const result = svc.listVisible(SEATTLE, new Date('2024-08-12T05:30:00Z'), {
      minAltitude: 0,
      includeStars: false,
    });
    const names = result.bodies.map((b) => b.body);
    expect(names).not.toContain('neptune');
    expect(names).not.toContain('pluto');
    expect(names).not.toContain('uranus');
    expect(names).toContain('saturn');
  });
});

/**
 * `visibility_note` is the at-a-glance headline, so it has to reflect the conditions. It
 * used to rank Mercury "bright" and Mars "easily visible" at 13:00 local with the Sun at
 * 42° and Mercury 20° from it — neither is a naked-eye object then.
 */
describe('listVisible — daylight- and glare-aware visibility notes', () => {
  /** The note for one body at one Seattle instant, with the sky condition that produced it. */
  const noteAt = (iso: string, body: string) => {
    const result = svc.listVisible(SEATTLE, new Date(iso), {
      minAltitude: 0,
      includeStars: true,
    });
    const hit = result.bodies.find((b) => b.body === body);
    expect(hit, `${body} above the horizon at ${iso}`).toBeDefined();
    return { note: hit!.visibilityNote, sky: result.skyCondition, pos: hit! };
  };

  /** The wording a body well clear of the Sun in a dark or twilight sky has always had. */
  const PLAIN_NOTE =
    /^[A-Z][\w ]*, mag -?\d+\.\d, \d+° (above|below) the [NESW]{1,2} horizon — (very bright|bright|easily visible|faint|very faint)$/;

  const DAYLIGHT = '2026-09-23T20:00:00Z';

  it('stops calling Mercury and Mars visible in daylight (the Seattle regression)', () => {
    for (const body of ['mercury', 'mars']) {
      const { note, sky } = noteAt(DAYLIGHT, body);
      expect(sky).toBe('daylight');
      expect(note).toContain('daylight, not naked-eye visible');
      expect(note).not.toMatch(/bright|easily visible|faint/);
    }
    // Mercury's ~20° elongation clears the glare threshold, so daylight is the reason given.
    expect(noteAt(DAYLIGHT, 'mercury').note).not.toContain('glare');
  });

  it('flags a daylight star as not naked-eye visible too', () => {
    expect(noteAt(DAYLIGHT, 'Arcturus').note).toContain('daylight, not naked-eye visible');
  });

  it('keeps the Sun and a negative-magnitude Venus bright in daylight', () => {
    const sun = noteAt(DAYLIGHT, 'sun');
    expect(sun.note).toMatch(/— very bright$/);
    const venus = noteAt(DAYLIGHT, 'venus');
    expect(venus.pos.magnitude!).toBeLessThan(0);
    expect(venus.note).toMatch(/— very bright$/);
    expect(venus.note).not.toContain('daylight');
  });

  it('keeps a daytime Moon well clear of the Sun bright', () => {
    const moon = noteAt('2026-01-01T00:00:00Z', 'moon');
    expect(moon.sky).toBe('daylight');
    expect(moon.pos.sunElongationDegrees).toBeGreaterThan(90);
    expect(moon.note).toMatch(/— very bright$/);
  });

  it('marks a body under 15° from the Sun as lost in glare', () => {
    // Mercury ~11.6° from the Sun, low in the morning civil twilight.
    const { note, sky, pos } = noteAt('2026-01-01T15:45:00Z', 'mercury');
    expect(sky).toBe('civil_twilight');
    expect(pos.sunElongationDegrees).toBeLessThan(15);
    expect(note).toContain(`${pos.sunElongationDegrees.toFixed(0)}° from the Sun, lost in glare`);
    expect(note).not.toMatch(/— (very bright|bright|easily visible|faint|very faint)/);
  });

  it('marks Venus lost in glare at superior conjunction, whatever its magnitude', () => {
    // 2026-01-01 Venus sits ~1.3° from the Sun. Its daylight exemption answers "can a
    // bright Venus be seen in a blue sky", not "can it be seen beside the Sun's disc".
    const { note, pos } = noteAt('2026-01-01T17:00:00Z', 'venus');
    expect(pos.magnitude!).toBeLessThan(0);
    expect(pos.sunElongationDegrees).toBeLessThan(2);
    expect(note).toContain('from the Sun, lost in glare');
    expect(note).not.toContain('very bright');
  });

  it('notes a civil-twilight sky while keeping the brightness', () => {
    const { note, sky, pos } = noteAt('2026-01-01T00:45:00Z', 'saturn');
    expect(sky).toBe('civil_twilight');
    expect(pos.sunElongationDegrees).toBeGreaterThan(15);
    expect(note).toMatch(/— easily visible; civil twilight, sky still bright$/);
  });

  it('keeps today_s wording in a dark sky and in deeper twilight', () => {
    for (const iso of ['2024-01-15T11:00:00Z', '2026-01-01T02:00:00Z']) {
      const result = svc.listVisible(SEATTLE, new Date(iso), {
        minAltitude: 0,
        includeStars: true,
      });
      expect(['nautical_twilight', 'astronomical_twilight', 'dark']).toContain(result.skyCondition);
      expect(result.bodies.length).toBeGreaterThan(5);
      for (const b of result.bodies) {
        expect(b.visibilityNote, `${iso} ${b.body}`).toMatch(PLAIN_NOTE);
      }
    }
  });
});

/**
 * Every catalog entry by its common name and by three spellings of its Bayer designation:
 * the Greek letter spelled out or as a symbol, the constellation as genitive or IAU
 * abbreviation. Written out rather than derived from the catalog, so the expectation is
 * independent of the normalization table it checks.
 */
const CATALOG_BAYER: ReadonlyArray<readonly [string, string, string]> = [
  ['Sirius', 'α', 'CMa'],
  ['Canopus', 'α', 'Car'],
  ['Rigil Kentaurus', 'α', 'Cen'],
  ['Arcturus', 'α', 'Boo'],
  ['Vega', 'α', 'Lyr'],
  ['Capella', 'α', 'Aur'],
  ['Rigel', 'β', 'Ori'],
  ['Procyon', 'α', 'CMi'],
  ['Achernar', 'α', 'Eri'],
  ['Betelgeuse', 'α', 'Ori'],
  ['Hadar', 'β', 'Cen'],
  ['Altair', 'α', 'Aql'],
  ['Acrux', 'α', 'Cru'],
  ['Aldebaran', 'α', 'Tau'],
  ['Antares', 'α', 'Sco'],
  ['Spica', 'α', 'Vir'],
  ['Pollux', 'β', 'Gem'],
  ['Fomalhaut', 'α', 'PsA'],
  ['Deneb', 'α', 'Cyg'],
  ['Mimosa', 'β', 'Cru'],
  ['Regulus', 'α', 'Leo'],
  ['Adhara', 'ε', 'CMa'],
  ['Castor', 'α', 'Gem'],
  ['Shaula', 'λ', 'Sco'],
  ['Bellatrix', 'γ', 'Ori'],
  ['Elnath', 'β', 'Tau'],
  ['Alnilam', 'ε', 'Ori'],
  ['Alnitak', 'ζ', 'Ori'],
  ['Alioth', 'ε', 'UMa'],
  ['Dubhe', 'α', 'UMa'],
  ['Mirfak', 'α', 'Per'],
  ['Polaris', 'α', 'UMi'],
];

const GREEK_NAME: Record<string, string> = {
  α: 'Alpha',
  β: 'Beta',
  γ: 'Gamma',
  ε: 'Epsilon',
  ζ: 'Zeta',
  λ: 'Lambda',
};

describe('lookupStar', () => {
  it('lists every catalog entry in the Bayer table', () => {
    expect(CATALOG_BAYER.map(([name]) => name).sort()).toEqual(
      STAR_CATALOG.map((s) => s.name).sort(),
    );
  });

  it.each(CATALOG_BAYER)('resolves %s by every Bayer spelling', (name, symbol, abbr) => {
    const star = STAR_CATALOG.find((s) => s.name === name)!;
    const genitive = star.designation.split(' ').slice(1).join(' ');
    const letter = GREEK_NAME[symbol]!;
    for (const form of [
      name,
      star.designation,
      `${letter} ${abbr}`,
      `${symbol} ${abbr}`,
      `${symbol} ${genitive}`,
      `${letter.toUpperCase()} ${abbr.toLowerCase()}`,
      `  ${symbol}   ${abbr}  `,
    ]) {
      expect(svc.lookupStar(form).name, form).toBe(name);
    }
  });

  it('tells CMa from CMi and UMa from UMi', () => {
    expect(svc.lookupStar('Alpha CMa').name).toBe('Sirius');
    expect(svc.lookupStar('Alpha CMi').name).toBe('Procyon');
    expect(svc.lookupStar('α UMa').name).toBe('Dubhe');
    expect(svc.lookupStar('α UMi').name).toBe('Polaris');
  });

  it.each(['Toliman', 'Alpha And', 'Delta CMa', 'CMa', 'Alpha', 'α', 'Sirius CMa'])(
    'keeps "%s" a miss',
    (name) => {
      const err = captureThrown(() => {
        svc.lookupStar(name);
      });
      expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err?.data?.reason).toBe('star_not_found');
    },
  );

  it('lists every catalog star on a miss, in the message and in data', () => {
    const err = captureThrown(() => {
      svc.lookupStar('Toliman');
    }) as (ReturnType<typeof captureThrown> & { data?: { catalog_stars?: string[] } }) | undefined;
    const names = STAR_CATALOG.map((s) => s.name);
    expect(err?.data?.catalog_stars).toEqual(names);
    for (const name of names) expect(err?.message).toContain(name);
    expect(err?.message).toContain(`${names.length}`);
  });
});

describe('input validation', () => {
  it('throws for a time outside the high-accuracy span', () => {
    expect(() => svc.resolveTime('1850-01-01T00:00:00Z')).toThrow(/1900/);
  });

  it('throws for an unknown timezone', () => {
    expect(() => svc.resolveTimezone('Mars/Olympus_Mons')).toThrow(/timezone/i);
  });

  it('throws for an unknown star name', () => {
    expect(() => svc.resolveStarTarget('Nonexistent Star')).toThrow(/catalog/i);
  });

  it('accepts a valid timezone and a default (now) time', () => {
    expect(svc.resolveTimezone('America/New_York')).toBe('America/New_York');
    expect(svc.resolveTimezone(undefined)).toBeUndefined();
    expect(svc.resolveTime()).toBeInstanceOf(Date);
  });

  it('throws time_out_of_range above the high-accuracy span (year > 2100)', () => {
    const err = captureThrown(() => {
      svc.resolveTime('2200-01-01T00:00:00Z');
    });
    expect(err?.data?.reason).toBe('time_out_of_range');
  });

  it('throws invalid_time (not time_out_of_range) for a malformed instant', () => {
    const err = captureThrown(() => {
      svc.resolveTime('the-ides-of-march');
    });
    expect(err?.data?.reason).toBe('invalid_time');
  });

  it('carries a recovery hint on the invalid_time error, not just a reason', () => {
    const err = captureThrown(() => {
      svc.resolveTime('the-ides-of-march');
    });
    expect(err?.data?.reason).toBe('invalid_time');
    expect(err?.data?.recovery?.hint).toBeTruthy();
    expect(err?.data?.recovery?.hint).toMatch(/ISO 8601/i);
  });

  /**
   * A day-of-month that does not exist still parses — both engines this project runs on
   * roll the overflow forward into the next month — so a parseability-only check answered
   * a different instant than the caller asked for.
   */
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2023-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
  ])('rejects the impossible calendar date %s with invalid_time', (time) => {
    const err = captureThrown(() => {
      svc.resolveTime(time);
    });
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_time');
    expect(err?.data?.recovery?.hint).toBeTruthy();
  });

  /**
   * 2000 is a leap year (divisible by 400) and 2100 is not (divisible by 100 but not 400).
   * A "divisible by 4" shortcut gets both wrong in opposite directions, so the accept case
   * and the 2100 reject case above have to be asserted together.
   */
  it.each(['2024-02-29T00:00:00Z', '2000-02-29T00:00:00Z'])(
    'accepts the real leap day %s',
    (time) => {
      expect(svc.resolveTime(time).toISOString()).toBe(new Date(time).toISOString());
    },
  );

  it('accepts an offset-bearing instant and resolves it to the right UTC moment', () => {
    // The written calendar day (30 June, local) is valid even though the UTC day it
    // resolves to can differ — validating the parsed UTC fields instead of the written
    // ones would reject legitimate offsets.
    expect(svc.resolveTime('2026-06-30T12:00:00+05:00').toISOString()).toBe(
      '2026-06-30T07:00:00.000Z',
    );
    expect(svc.resolveTime('2026-06-30T23:00:00-05:00').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
  });

  it('accepts date-only, year-month, and fractional-second instants', () => {
    expect(svc.resolveTime('2026-06-30').toISOString()).toBe('2026-06-30T00:00:00.000Z');
    expect(svc.resolveTime('2026-06').toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(svc.resolveTime('2026-06-30T12:00:00.123456Z').toISOString()).toBe(
      '2026-06-30T12:00:00.123Z',
    );
  });

  it.each(['August 11, 2026', 'Tue, 11 Aug 2026 00:00:00 GMT'])(
    'rejects the non-ISO date form "%s" with invalid_time',
    (time) => {
      const err = captureThrown(() => {
        svc.resolveTime(time);
      });
      expect(err?.data?.reason).toBe('invalid_time');
    },
  );

  it("leaves the time_out_of_range hint to the calling tool's contract", () => {
    const err = captureThrown(() => {
      svc.resolveTime('2200-01-01T00:00:00Z');
    });
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(err?.data?.recovery).toBeUndefined();
  });

  it('tags the unknown-timezone error with reason invalid_timezone', () => {
    const err = captureThrown(() => {
      svc.resolveTimezone('Mars/Olympus_Mons');
    });
    expect(err?.data?.reason).toBe('invalid_timezone');
  });

  it('tags the unknown-star error with reason star_not_found', () => {
    const err = captureThrown(() => {
      svc.resolveStarTarget('Nonexistent Star');
    });
    expect(err?.data?.reason).toBe('star_not_found');
  });
});

describe('findEvents — validation reasons', () => {
  it('throws body_not_supported for max_elongation of an outer planet', () => {
    const err = captureThrown(() => {
      svc.findEvents('max_elongation', {
        start: new Date('2024-01-01T00:00:00Z'),
        count: 1,
        body: 'jupiter',
      });
    });
    expect(err?.data?.reason).toBe('body_not_supported');
  });

  it('throws body_required when a conjunction is requested without a body', () => {
    const err = captureThrown(() => {
      svc.findEvents('conjunction', { start: new Date('2024-01-01T00:00:00Z'), count: 1 });
    });
    expect(err?.data?.reason).toBe('body_required');
  });

  it('finds a Mercury greatest elongation (the other inner planet)', () => {
    const events = svc.findEvents('max_elongation', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
      body: 'mercury',
    });
    expect(events[0]?.body).toBe('mercury');
    expect(events[0]?.elongationDegrees).toBeGreaterThan(0);
  });

  it('finds a conjunction for an inner planet', () => {
    const events = svc.findEvents('conjunction', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
      body: 'venus',
    });
    expect(events[0]?.event).toBe('conjunction');
    expect(events[0]?.body).toBe('venus');
    // Published: Venus's 2024 superior conjunction is 2024-06-04.
    expect(events[0]!.timeUtc.slice(0, 10)).toBe('2024-06-04');
    expect(events[0]?.conjunctionKind).toBe('superior');
  });

  // Bodies the engine cannot search for a given event class: SearchRelativeLongitude
  // rejects non-planets outright, and SearchPlanetApsis reads an internal planet
  // table that has no Sun entry. Both surfaced as raw internal errors.
  const unsupported: Array<[EventName, EventBodyName]> = [
    ['opposition', 'sun'],
    ['opposition', 'moon'],
    ['opposition', 'earth'],
    ['opposition', 'mercury'],
    ['opposition', 'venus'],
    ['conjunction', 'sun'],
    ['conjunction', 'moon'],
    ['conjunction', 'earth'],
    ['perigee_apogee', 'sun'],
    ['max_elongation', 'earth'],
  ];

  it.each(unsupported)('throws body_not_supported for %s of %s', (event, body) => {
    const err = captureThrown(() => {
      svc.findEvents(event, { start: new Date('2026-01-01T00:00:00Z'), count: 1, body });
    });
    expect(err?.data?.reason).toBe('body_not_supported');
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    // A recovery hint naming the valid bodies, and no engine internals in the message.
    expect(err?.data?.recovery?.hint?.length).toBeGreaterThan(0);
    expect(err?.message).not.toMatch(/OrbitalPeriod|relative longitude/i);
  });

  it('does not call a rejected max_elongation body an outer planet', () => {
    // find_events accepts earth, sun, and moon, none of which are outer planets, so
    // the hint has to explain the rule rather than name one class of rejected body.
    for (const body of ['earth', 'sun', 'moon'] as const) {
      const err = captureThrown(() => {
        svc.findEvents('max_elongation', {
          start: new Date('2026-01-01T00:00:00Z'),
          count: 1,
          body,
        });
      });
      expect(err?.data?.recovery?.hint).toMatch(/mercury/i);
      expect(err?.data?.recovery?.hint).not.toMatch(/outer planets/i);
    }
  });

  const notConjunction = (event: string) =>
    `body2 applies only to the conjunction event, not "${event}".`;
  const notPairable = (body: string) =>
    `A two-body conjunction pairs the Moon and the planets; body "${body}" is not one of them.`;

  it.each([
    ['opposition', 'mars', 'jupiter', notConjunction('opposition')],
    ['max_elongation', 'venus', 'jupiter', notConjunction('max_elongation')],
    ['equinox', undefined, 'jupiter', notConjunction('equinox')],
    [
      'conjunction',
      'saturn',
      'saturn',
      'body and body2 are both "saturn"; a conjunction needs two different bodies.',
    ],
    ['conjunction', 'sun', 'jupiter', notPairable('sun')],
    ['conjunction', 'earth', 'moon', notPairable('earth')],
  ] as const)(
    'throws invalid_body_pair for %s of %s with body2 %s',
    (event, body, body2, message) => {
      const err = captureThrown(() => {
        svc.findEvents(event, {
          start: new Date('2026-01-01T00:00:00Z'),
          count: 1,
          ...(body ? { body } : {}),
          body2,
        });
      });
      expect(err?.data?.reason).toBe('invalid_body_pair');
      expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err?.message).toBe(message);
      expect(err?.data?.recovery?.hint).toBe(
        findEventsTool.errors?.find((e) => e.reason === 'invalid_body_pair')?.recovery,
      );
    },
  );

  it('throws body_required for a two-body conjunction without a body', () => {
    const err = captureThrown(() => {
      svc.findEvents('conjunction', {
        start: new Date('2026-01-01T00:00:00Z'),
        count: 1,
        body2: 'jupiter',
      });
    });
    expect(err?.data?.reason).toBe('body_required');
  });

  it('still accepts the bodies each event class is defined for', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    expect(svc.findEvents('opposition', { start, count: 1, body: 'mars' })).toHaveLength(1);
    expect(svc.findEvents('conjunction', { start, count: 1, body: 'mercury' })).toHaveLength(1);
    expect(svc.findEvents('max_elongation', { start, count: 1, body: 'venus' })).toHaveLength(1);
    expect(svc.findEvents('perigee_apogee', { start, count: 1, body: 'moon' })).toHaveLength(1);
    expect(svc.findEvents('perigee_apogee', { start, count: 1, body: 'earth' })).toHaveLength(1);
    expect(svc.findEvents('perigee_apogee', { start, count: 1, body: 'mars' })).toHaveLength(1);
  });
});
