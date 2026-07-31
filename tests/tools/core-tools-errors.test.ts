/**
 * @fileoverview Error-path and edge-case coverage for the five core tool handlers,
 *   complementing the happy-path wiring tests in core-tools.test.ts. Covers every
 *   declared `ctx.fail` reason (time_out_of_range, star_not_found, the find_events
 *   gates), the Zod validation rejections (out-of-range coordinates, count bounds),
 *   boundary contracts (empty visible list, circumpolar notes, multi-count
 *   pagination), and format() completeness on the tools the happy-path file does
 *   not exercise. The deterministic numeric correctness lives in the
 *   EphemerisService tests; here we assert the tool-layer contracts.
 * @module tests/tools/core-tools-errors.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { findEventsTool } from '@/mcp-server/tools/definitions/find-events.tool.js';
import { getMoonPhaseTool } from '@/mcp-server/tools/definitions/get-moon-phase.tool.js';
import { getRiseSetTool } from '@/mcp-server/tools/definitions/get-rise-set.tool.js';
import { getSkyPositionTool } from '@/mcp-server/tools/definitions/get-sky-position.tool.js';
import { listVisibleTool } from '@/mcp-server/tools/definitions/list-visible.tool.js';
import { initEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import {
  displayValuesOf,
  expectExactCarried,
  expectRoundedDisplay,
} from '../helpers/content-parity.js';

const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };
const NORTH_POLE = { latitude: 89.9, longitude: 0 };

beforeAll(() => {
  initEphemerisService();
});

describe('astronomy_get_sky_position — error contracts', () => {
  it('fails time_out_of_range for an instant before 1900', () => {
    const ctx = createMockContext({ errors: getSkyPositionTool.errors });
    const input = getSkyPositionTool.input.parse({
      body: 'mars',
      ...SEATTLE,
      time: '1850-06-01T00:00:00Z',
    });
    const err = (() => {
      try {
        getSkyPositionTool.handler(input, ctx);
      } catch (e) {
        return e as { code?: number; data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('fails time_out_of_range for an instant after 2100', () => {
    const ctx = createMockContext({ errors: getSkyPositionTool.errors });
    const input = getSkyPositionTool.input.parse({
      body: 'mars',
      ...SEATTLE,
      time: '2150-06-01T00:00:00Z',
    });
    expect(() => getSkyPositionTool.handler(input, ctx)).toThrow(/1900|2100/);
  });

  it('rejects a malformed (non-ISO) time string', () => {
    const ctx = createMockContext({ errors: getSkyPositionTool.errors });
    const input = getSkyPositionTool.input.parse({
      body: 'mars',
      ...SEATTLE,
      time: 'not-a-date',
    });
    expect(() => getSkyPositionTool.handler(input, ctx)).toThrow(/Invalid time|ISO 8601/i);
  });

  it('fails star_not_found for a name not in the catalog', () => {
    const ctx = createMockContext({ errors: getSkyPositionTool.errors });
    const input = getSkyPositionTool.input.parse({ star: 'Nonexistent Star', ...SEATTLE });
    const err = (() => {
      try {
        getSkyPositionTool.handler(input, ctx);
      } catch (e) {
        return e as { code?: number; data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('star_not_found');
    expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('rejects an unknown timezone with a recovery hint', () => {
    const ctx = createMockContext({ errors: getSkyPositionTool.errors });
    const input = getSkyPositionTool.input.parse({
      body: 'mars',
      ...SEATTLE,
      timezone: 'Mars/Olympus_Mons',
    });
    expect(() => getSkyPositionTool.handler(input, ctx)).toThrow(/timezone|IANA/i);
  });

  it('treats a whitespace-only star as absent and falls through to body', async () => {
    // Form clients can send "" / "   "; the handler must not resolve it as a star.
    const ctx = createMockContext({ errors: getSkyPositionTool.errors });
    const input = getSkyPositionTool.input.parse({ body: 'venus', star: '   ', ...SEATTLE });
    const result = await getSkyPositionTool.handler(input, ctx);
    expect(result.body).toBe('venus');
  });
});

describe('astronomy_get_sky_position — input validation', () => {
  it('rejects a latitude above 90', () => {
    expect(() =>
      getSkyPositionTool.input.parse({ body: 'mars', latitude: 91, longitude: 0 }),
    ).toThrow();
  });

  it('rejects a longitude below -180', () => {
    expect(() =>
      getSkyPositionTool.input.parse({ body: 'mars', latitude: 0, longitude: -181 }),
    ).toThrow();
  });

  it('rejects a body outside the closed enum', () => {
    expect(() => getSkyPositionTool.input.parse({ body: 'ceres', ...SEATTLE })).toThrow();
  });

  it('applies the elevation default of 0 when omitted', () => {
    const input = getSkyPositionTool.input.parse({ body: 'mars', ...SEATTLE });
    expect(input.elevation).toBe(0);
  });
});

describe('astronomy_get_moon_phase', () => {
  it('fails time_out_of_range outside the supported span', () => {
    const ctx = createMockContext({ errors: getMoonPhaseTool.errors });
    const input = getMoonPhaseTool.input.parse({ time: '1700-01-01T00:00:00Z' });
    const err = (() => {
      try {
        getMoonPhaseTool.handler(input, ctx);
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('time_out_of_range');
  });

  it('attaches time_local on the record and each quarter when a timezone is supplied', async () => {
    const ctx = createMockContext({ errors: getMoonPhaseTool.errors });
    const input = getMoonPhaseTool.input.parse({
      time: '2024-04-23T23:49:00Z',
      timezone: 'America/Los_Angeles',
    });
    const result = await getMoonPhaseTool.handler(input, ctx);
    expect(result.time_local).toMatch(/-0[78]:00$/);
    for (const q of result.next_quarters) {
      expect(q.time_local).toBeTruthy();
    }
  });

  it('format() renders the phase, illumination, age, and every quarter', async () => {
    const ctx = createMockContext();
    const input = getMoonPhaseTool.input.parse({ time: '2024-04-23T23:49:00Z' });
    const result = await getMoonPhaseTool.handler(input, ctx);
    const block = getMoonPhaseTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('Illuminated');
    expect(text).toContain('Age');
    expect(text).toContain('Next quarters');
    // All four quarter labels render.
    expect(text).toMatch(/New Moon|First Quarter|Full Moon|Last Quarter/);
  });

  it('format() shows a rounded report and still carries the exact phase numbers', async () => {
    const ctx = createMockContext();
    const input = getMoonPhaseTool.input.parse({ time: '2024-04-23T23:49:00Z' });
    const result = await getMoonPhaseTool.handler(input, ctx);
    const block = getMoonPhaseTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(displayValuesOf(text)).not.toMatch(/\.\d{4,}/);
    expectExactCarried(text, result.phase_angle_degrees);
    expectExactCarried(text, result.age_days);
    // Illumination renders as a percentage, so its exact value is labelled a
    // fraction — the two differ by 100x and must not be confused.
    expect(text).toContain(`[fraction ${result.illuminated_fraction}]`);
  });
});

describe('astronomy_get_rise_set — boundaries and contracts', () => {
  it('fails time_out_of_range outside the supported span', () => {
    const ctx = createMockContext({ errors: getRiseSetTool.errors });
    const input = getRiseSetTool.input.parse({
      body: 'sun',
      ...SEATTLE,
      start: '1899-01-01T00:00:00Z',
    });
    const err = (() => {
      try {
        getRiseSetTool.handler(input, ctx);
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('time_out_of_range');
  });

  it('reports the Sun as circumpolar (null rise/set + note) at the North Pole in June', async () => {
    const ctx = createMockContext({ errors: getRiseSetTool.errors });
    const input = getRiseSetTool.input.parse({
      body: 'sun',
      ...NORTH_POLE,
      start: '2024-06-21T00:00:00Z',
    });
    const result = await getRiseSetTool.handler(input, ctx);
    const e = result.events[0]!;
    expect(e.rise_utc).toBeNull();
    expect(e.set_utc).toBeNull();
    expect(e.note).toMatch(/[Cc]ircumpolar|[Nn]ever/);
  });

  it('returns the requested number of cycles for count > 1', async () => {
    const ctx = createMockContext({ errors: getRiseSetTool.errors });
    const input = getRiseSetTool.input.parse({
      body: 'moon',
      ...SEATTLE,
      start: '2024-06-21T00:00:00Z',
      count: 3,
    });
    const result = await getRiseSetTool.handler(input, ctx);
    expect(result.events).toHaveLength(3);
  });

  it('rejects a count above the maximum of 31', () => {
    expect(() => getRiseSetTool.input.parse({ body: 'sun', ...SEATTLE, count: 50 })).toThrow();
  });

  it('rejects a count below 1', () => {
    expect(() => getRiseSetTool.input.parse({ body: 'sun', ...SEATTLE, count: 0 })).toThrow();
  });

  it('format() renders the three twilight bands for the Sun', async () => {
    const ctx = createMockContext({ errors: getRiseSetTool.errors });
    const input = getRiseSetTool.input.parse({
      body: 'sun',
      ...SEATTLE,
      start: '2024-06-21T00:00:00Z',
    });
    const result = await getRiseSetTool.handler(input, ctx);
    const block = getRiseSetTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('Civil twilight');
    expect(text).toContain('Nautical twilight');
    expect(text).toContain('Astronomical twilight');
  });

  it('format() leads with the body name and cycle count and rounds the transit altitude', async () => {
    const ctx = createMockContext({ errors: getRiseSetTool.errors });
    const input = getRiseSetTool.input.parse({
      body: 'moon',
      ...SEATTLE,
      start: '2024-06-21T00:00:00Z',
      count: 3,
    });
    const result = await getRiseSetTool.handler(input, ctx);
    expect(result.body).toBe('moon');
    const block = getRiseSetTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toMatch(/## moon — 3 rise\/set cycles/i);
    // The report a human reads stays rounded: no display value carries four or more
    // decimal places. Exact values live only in bracketed tails.
    expect(displayValuesOf(text)).not.toMatch(/\.\d{4,}/);
  });

  it('format() carries the exact transit altitude alongside the rounded one', async () => {
    const ctx = createMockContext({ errors: getRiseSetTool.errors });
    const input = getRiseSetTool.input.parse({
      body: 'moon',
      ...SEATTLE,
      start: '2024-06-21T00:00:00Z',
      count: 3,
    });
    const result = await getRiseSetTool.handler(input, ctx);
    const block = getRiseSetTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    const lossy = result.events
      .map((e) => e.transit_altitude_degrees)
      .filter((v): v is number => v !== null && Number(v.toFixed(1)) !== v);
    expect(lossy.length).toBeGreaterThan(0);
    for (const v of lossy) {
      expect(text).toContain(`max alt ${v.toFixed(1)}°`);
      // A content[]-only client can recover the structured value, not just the rounding.
      expect(text).toContain(`[${v}]`);
    }
  });
});

describe('astronomy_find_events — error contracts and validation', () => {
  it('exposes the InvalidParams code on the observer_required failure', () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'solar_eclipse',
      start: '2024-01-01T00:00:00Z',
    });
    const err = (() => {
      try {
        findEventsTool.handler(input, ctx);
      } catch (e) {
        return e as { code?: number; data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('observer_required');
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('fails time_out_of_range for a start outside the supported span', () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'equinox',
      start: '1880-01-01T00:00:00Z',
    });
    const err = (() => {
      try {
        findEventsTool.handler(input, ctx);
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('time_out_of_range');
  });

  it('does NOT require an observer for a lunar eclipse (geocentric)', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'lunar_eclipse',
      start: '2024-01-01T00:00:00Z',
    });
    const result = await findEventsTool.handler(input, ctx);
    expect(result.events[0]?.event).toBe('lunar_eclipse');
  });

  it('omits local_visible for a lunar eclipse even when coordinates are supplied', async () => {
    // A lunar eclipse is the same event for every observer, so the tool advertises
    // no local visibility for it — supplying coordinates must not conjure the field.
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'lunar_eclipse',
      start: '2024-01-01T00:00:00Z',
      ...SEATTLE,
    });
    const result = await findEventsTool.handler(input, ctx);
    const e = result.events[0]!;
    expect(e.local_visible).toBeUndefined();
    expect(e.contacts?.peak_utc).toBeTruthy();
    const block = findEventsTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).not.toContain('Locally visible');
  });

  it.each([
    ['opposition', 'sun'],
    ['opposition', 'venus'],
    ['conjunction', 'moon'],
    ['perigee_apogee', 'sun'],
  ] as const)('fails body_not_supported for %s of %s', (event, body) => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({ event, body, start: '2026-01-01T00:00:00Z' });
    const err = (() => {
      try {
        findEventsTool.handler(input, ctx);
      } catch (e) {
        return e as { code?: number; message?: string; data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('body_not_supported');
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    // No astronomy-engine internals reach the client.
    expect(err?.message).not.toMatch(/OrbitalPeriod|undefined|not a planet/i);
  });

  it("accepts earth for perigee_apogee and labels the apsides Earth's own", async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'perigee_apogee',
      body: 'earth',
      start: '2026-01-01T00:00:00Z',
      count: 2,
    });
    const result = await findEventsTool.handler(input, ctx);
    expect(result.events.map((e) => e.apsis_kind)).toEqual(['perihelion', 'aphelion']);
    expect(result.events[0]?.body).toBe('earth');
    expect(result.events[0]?.distance_au).toBeCloseTo(0.9833, 3);
  });

  it('rejects earth on the tools with no observer-relative geometry for it', () => {
    // The wider find_events enum must not leak into the position/rise-set surfaces.
    expect(() => getSkyPositionTool.input.parse({ body: 'earth', ...SEATTLE })).toThrow();
    expect(() => getRiseSetTool.input.parse({ body: 'earth', ...SEATTLE })).toThrow();
  });

  it('format() renders the conjunction kind for an inner planet', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'conjunction',
      body: 'venus',
      start: '2026-06-01T00:00:00Z',
      count: 2,
    });
    const result = await findEventsTool.handler(input, ctx);
    expect(result.events.map((e) => e.conjunction_kind)).toEqual(['inferior', 'superior']);
    const block = findEventsTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('**Conjunction:** inferior');
    expect(text).toContain('**Conjunction:** superior');
  });

  it('reports local circumstances for a solar eclipse when an observer is supplied', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'solar_eclipse',
      start: '2024-01-01T00:00:00Z',
      latitude: 32.7767,
      longitude: -96.797,
    });
    const result = await findEventsTool.handler(input, ctx);
    const e = result.events[0]!;
    expect(e.local_visible).toBe(true);
    expect(e.contacts?.peak_utc).toBeTruthy();
  });

  it('rejects a count above the maximum of 20', () => {
    expect(() => findEventsTool.input.parse({ event: 'equinox', count: 21 })).toThrow();
  });

  it('format() renders a body-relative event headline (perigee_apogee)', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'perigee_apogee',
      body: 'moon',
      start: '2024-01-01T00:00:00Z',
      count: 2,
    });
    const result = await findEventsTool.handler(input, ctx);
    const block = findEventsTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('perigee_apogee');
    expect(text).toContain('moon');
    expect(text).toMatch(/Apsis|Distance/);
  });

  it('renders eclipse obscuration honestly when null (global solar, no observer)', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'solar_eclipse',
      start: '2024-01-01T00:00:00Z',
      latitude: 0,
      longitude: 0,
    });
    const result = await findEventsTool.handler(input, ctx);
    // Whatever obscuration comes back, format() must not invent a value: a null
    // renders as "unavailable", a number renders as a percentage.
    const block = findEventsTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    if (result.events[0]?.obscuration === null) {
      expect(text).toContain('unavailable');
    } else {
      expect(text).toMatch(/Obscuration:.*%/);
    }
  });

  it('format() opens with the total event count', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'equinox',
      start: '2024-01-01T00:00:00Z',
      count: 2,
    });
    const result = await findEventsTool.handler(input, ctx);
    const block = findEventsTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text.split('\n')[0]).toMatch(/2 events found/i);
  });

  it('format() carries the exact apsis distances alongside the rounded ones', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'perigee_apogee',
      body: 'moon',
      start: '2024-01-01T00:00:00Z',
      count: 2,
    });
    const result = await findEventsTool.handler(input, ctx);
    const block = findEventsTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expectRoundedDisplay(text);
    for (const e of result.events) {
      if (e.distance_km !== undefined) {
        expect(text).toContain(`${e.distance_km.toFixed(0)} km`);
        expectExactCarried(text, e.distance_km);
      }
      if (e.distance_au !== undefined) expectExactCarried(text, e.distance_au);
    }
  });

  it('format() renders a lunar distance in AU without collapsing it to zero', () => {
    // A fixed-decimal AU rendering breaks across the range this tool covers: the
    // Moon sits at ~0.0026 AU while an outer-planet opposition sits near 30.
    const block = findEventsTool.format!({
      events: [
        {
          event: 'perigee_apogee',
          time_utc: '2024-01-13T10:57:00.000Z',
          body: 'moon',
          apsis_kind: 'perigee',
          distance_km: 362266.6069,
          distance_au: 0.0024215706172,
        },
      ],
    })[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('0.00242157 AU');
    expect(text).toContain('[0.0024215706172]');
  });
});

describe('astronomy_list_visible — boundaries and validation', () => {
  it('fails time_out_of_range outside the supported span', () => {
    const ctx = createMockContext({ errors: listVisibleTool.errors });
    const input = listVisibleTool.input.parse({ ...SEATTLE, time: '2200-01-01T00:00:00Z' });
    const err = (() => {
      try {
        listVisibleTool.handler(input, ctx);
      } catch (e) {
        return e as { data?: { reason?: string } };
      }
    })();
    expect(err?.data?.reason).toBe('time_out_of_range');
  });

  it('returns an empty list and the "no bodies" format when min_altitude excludes everything', async () => {
    const ctx = createMockContext();
    // No body is ever at altitude 90° from a fixed point at a single instant for
    // every body at once, so a 90° floor yields an empty above-filter set.
    const input = listVisibleTool.input.parse({
      ...SEATTLE,
      time: '2024-06-21T20:00:00Z',
      min_altitude: 90,
    });
    const result = await listVisibleTool.handler(input, ctx);
    expect(result.bodies).toHaveLength(0);
    const block = listVisibleTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toMatch(/No bodies/i);
  });

  it('returns the sky-condition fields in the output even when the body list is empty', async () => {
    const ctx = createMockContext();
    const input = listVisibleTool.input.parse({
      ...SEATTLE,
      time: '2024-06-21T20:00:00Z',
      min_altitude: 90,
    });
    const result = await listVisibleTool.handler(input, ctx);
    // The sky-condition gate now lives in the output (moved off enrichment) so content[]-only
    // clients see it; it is populated regardless of how many bodies clear the filter.
    expect(result.sky_condition).toBe('daylight');
    expect(result.sun_altitude_degrees).toBeGreaterThan(0);
    expect(result.total_count).toBe(0);
  });

  it('format() opens with the sky-condition header carrying sun altitude and visible count', async () => {
    const ctx = createMockContext();
    const input = listVisibleTool.input.parse({ ...SEATTLE, time: '2024-06-21T20:00:00Z' });
    const result = await listVisibleTool.handler(input, ctx);
    const block = listVisibleTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('Sky:');
    expect(header).toContain(result.sky_condition);
    expect(header).toContain(`${result.sun_altitude_degrees.toFixed(1)}°`);
    expect(header).toContain(`${result.total_count} bodies visible`);
  });

  it('rejects a min_altitude above 90', () => {
    expect(() => listVisibleTool.input.parse({ ...SEATTLE, min_altitude: 91 })).toThrow();
  });

  it('applies include_stars default of false', () => {
    const input = listVisibleTool.input.parse({ ...SEATTLE });
    expect(input.include_stars).toBe(false);
  });

  it('format() leads each body with its visibility note and rounds the coordinates', async () => {
    const ctx = createMockContext();
    const input = listVisibleTool.input.parse({ ...SEATTLE, time: '2024-06-21T20:00:00Z' });
    const result = await listVisibleTool.handler(input, ctx);
    expect(result.bodies.length).toBeGreaterThan(0);
    const block = listVisibleTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    // The precomputed visibility note is the per-body headline.
    const body0 = result.bodies[0]!;
    expect(text).toContain(`${body0.rank}. ${body0.body} — ${body0.visibility_note}`);
    // No raw full-precision coordinate dump: the display values are the tool's own
    // one-decimal rounding, and the old raw field-name labels are gone.
    expectRoundedDisplay(text);
    expect(displayValuesOf(text)).toContain(
      `alt ${body0.horizontal.altitude_degrees.toFixed(1)}° az ${body0.horizontal.azimuth_degrees.toFixed(1)}°`,
    );
    expect(text).not.toContain('above_horizon');
  });

  it('format() tails only the distance — the rest of the scan line is display-only', async () => {
    const ctx = createMockContext();
    const input = listVisibleTool.input.parse({
      ...SEATTLE,
      time: '2024-06-21T09:00:00Z',
      include_stars: true,
      min_altitude: -90,
    });
    const result = await listVisibleTool.handler(input, ctx);
    expect(result.bodies.length).toBeGreaterThan(20);
    const block = listVisibleTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    // Tailing all eleven coordinates per body grew this surface by ~1.7x for digits an
    // at-a-glance list is never read for. Only the distance keeps its tail, so the
    // bracket count never exceeds one per body.
    const tails = text.match(/\[/g) ?? [];
    expect(tails.length).toBeLessThanOrEqual(result.bodies.length);
    for (const b of result.bodies) expectExactCarried(text, b.equatorial.distance_au);
    expect(text).not.toContain('fraction ');
    expectRoundedDisplay(text);
  });

  it('astronomy_get_sky_position carries the exact values this scan line rounds', async () => {
    const ctx = createMockContext();
    const time = '2024-06-21T09:00:00Z';
    const listed = await listVisibleTool.handler(
      listVisibleTool.input.parse({ ...SEATTLE, time, min_altitude: -90 }),
      ctx,
    );
    const body = listed.bodies.find((b) => b.body === 'saturn');
    expect(body).toBeDefined();
    const detail = await getSkyPositionTool.handler(
      getSkyPositionTool.input.parse({ body: 'saturn', ...SEATTLE, time }),
      ctx,
    );
    // Same instant, same observer, same schema — the recovery path a content[]-only
    // client takes when it needs more than the scan line's rounding.
    expect(detail.equatorial.ra_hours).toBe(body!.equatorial.ra_hours);
    const block = getSkyPositionTool.format!(detail)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expectExactCarried(text, body!.equatorial.ra_hours);
    expectExactCarried(text, body!.horizontal.altitude_degrees);
    expectExactCarried(text, body!.equatorial.distance_au);
  });
});
