/**
 * @fileoverview Determinism / golden-value tests for the EphemerisService. The core
 *   is pure computation over astronomy-engine, so known astronomical events anchor
 *   correctness: the 2024-04-08 total solar eclipse, a known full moon, the 2024
 *   March equinox, and a known sunrise. These are the determinism payoff — same
 *   inputs, byte-identical, verifiable against published values.
 * @module tests/services/ephemeris-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import type { EventBodyName, EventName } from '@/services/ephemeris/types.js';
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
    // Phase angle near 180° at full moon.
    expect(Math.abs(result.phaseAngleDegrees - 180)).toBeLessThan(3);
    expect(result.nextQuarters).toHaveLength(4);
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

  it('keeps the time_out_of_range hint intact for a year outside the span', () => {
    const err = captureThrown(() => {
      svc.resolveTime('2200-01-01T00:00:00Z');
    });
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(err?.data?.recovery?.hint).toBe('Use a date between 1900 and 2100.');
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
