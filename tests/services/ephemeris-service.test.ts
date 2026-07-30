/**
 * @fileoverview Determinism / golden-value tests for the EphemerisService. The core
 *   is pure computation over astronomy-engine, so known astronomical events anchor
 *   correctness: the 2024-04-08 total solar eclipse, a known full moon, the 2024
 *   March equinox, and a known sunrise. These are the determinism payoff — same
 *   inputs, byte-identical, verifiable against published values.
 * @module tests/services/ephemeris-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { beforeAll, describe, expect, it } from 'vitest';
import { EphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import type { EventBodyName, EventName } from '@/services/ephemeris/types.js';

let svc: EphemerisService;

beforeAll(() => {
  svc = new EphemerisService();
});

/** Dallas, TX — inside the 2024-04-08 path of totality. */
const DALLAS = { latitude: 32.7767, longitude: -96.797, elevation: 131 };
/** Seattle, WA. */
const SEATTLE = { latitude: 47.6062, longitude: -122.3321, elevation: 56 };

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

  it('finds a global solar eclipse on 2024-04-08 without an observer', () => {
    const events = svc.findEvents('solar_eclipse', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
    });
    const t = new Date(events[0]!.timeUtc);
    expect(t.getUTCDate()).toBe(8);
    expect(t.getUTCMonth()).toBe(3);
    expect(events[0]?.localVisible).toBe(false);
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
    const events = svc.riseSet('sun', SEATTLE, new Date('2024-06-21T00:00:00Z'), 1);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.riseUtc).toBeTruthy();
    expect(e.setUtc).toBeTruthy();
    // Seattle sunrise on the solstice is ~05:11 local (12:11 UTC); set ~21:11 local (04:11 UTC next day).
    const rise = new Date(e.riseUtc as string);
    expect(rise.getUTCHours()).toBeGreaterThanOrEqual(11);
    expect(rise.getUTCHours()).toBeLessThanOrEqual(13);
    // The Sun branch carries twilight.
    expect(e.twilight).toBeDefined();
    expect(e.twilight?.astronomical).toBeDefined();
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
    const err = (() => {
      try {
        svc.resolveTime('2200-01-01T00:00:00Z');
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('time_out_of_range');
  });

  it('throws invalid_time (not time_out_of_range) for a malformed instant', () => {
    const err = (() => {
      try {
        svc.resolveTime('the-ides-of-march');
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('invalid_time');
  });

  it('tags the unknown-timezone error with reason invalid_timezone', () => {
    const err = (() => {
      try {
        svc.resolveTimezone('Mars/Olympus_Mons');
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('invalid_timezone');
  });

  it('tags the unknown-star error with reason star_not_found', () => {
    const err = (() => {
      try {
        svc.resolveStarTarget('Nonexistent Star');
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('star_not_found');
  });
});

describe('findEvents — validation reasons', () => {
  it('throws body_not_supported for max_elongation of an outer planet', () => {
    const err = (() => {
      try {
        svc.findEvents('max_elongation', {
          start: new Date('2024-01-01T00:00:00Z'),
          count: 1,
          body: 'jupiter',
        });
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('body_not_supported');
  });

  it('throws body_required when a conjunction is requested without a body', () => {
    const err = (() => {
      try {
        svc.findEvents('conjunction', { start: new Date('2024-01-01T00:00:00Z'), count: 1 });
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
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
    const err = (() => {
      try {
        svc.findEvents(event, { start: new Date('2026-01-01T00:00:00Z'), count: 1, body });
      } catch (e) {
        return e as {
          code?: number;
          data?: { reason?: string; recovery?: { hint?: string } };
          message?: string;
        };
      }
    })();
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
      const err = (() => {
        try {
          svc.findEvents('max_elongation', {
            start: new Date('2026-01-01T00:00:00Z'),
            count: 1,
            body,
          });
        } catch (e) {
          return e as { data?: { recovery?: { hint?: string } } };
        }
      })();
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
