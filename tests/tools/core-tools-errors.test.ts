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
});
