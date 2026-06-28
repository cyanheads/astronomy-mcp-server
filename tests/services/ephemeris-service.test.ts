/**
 * @fileoverview Determinism / golden-value tests for the EphemerisService. The core
 *   is pure computation over astronomy-engine, so known astronomical events anchor
 *   correctness: the 2024-04-08 total solar eclipse, a known full moon, the 2024
 *   March equinox, and a known sunrise. These are the determinism payoff — same
 *   inputs, byte-identical, verifiable against published values.
 * @module tests/services/ephemeris-service.test
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EphemerisService } from '@/services/ephemeris/ephemeris-service.js';

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
    // At the exact new-moon boundary the synodic age is either ~0 (just after) or
    // ~29.5 (just before the next new moon); both are valid near-new readings.
    expect(result.ageDays < 1 || result.ageDays > 28.5).toBe(true);
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

describe('findEvents — body-relative', () => {
  it('finds a Jupiter opposition', () => {
    const events = svc.findEvents('opposition', {
      start: new Date('2024-01-01T00:00:00Z'),
      count: 1,
      body: 'jupiter',
    });
    expect(events[0]?.event).toBe('opposition');
    expect(events[0]?.body).toBe('jupiter');
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
  });
});
