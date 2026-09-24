/**
 * @fileoverview Error-path and edge-case coverage for the five core tool handlers,
 *   complementing the happy-path wiring tests in core-tools.test.ts. Covers every
 *   declared `ctx.fail` reason (time_out_of_range, star_not_found, the find_events
 *   gates), the Zod validation rejections (out-of-range coordinates, count bounds),
 *   boundary contracts (empty visible list, circumpolar notes, multi-count
 *   pagination), and format() completeness on the tools the happy-path file does
 *   not exercise. Closes with the contracts EphemerisService raises on all five
 *   (invalid_time, invalid_timezone, time_out_of_range), asserting each declared
 *   `recovery` is the same string the resolver throws, and one tool's error
 *   reaching both client surfaces. The deterministic numeric correctness lives in
 *   the EphemerisService tests; here we assert the tool-layer contracts.
 * @module tests/tools/core-tools-errors.test
 */

import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type FindEventsOutputType,
  findEventsTool,
} from '@/mcp-server/tools/definitions/find-events.tool.js';
import { getMoonPhaseTool } from '@/mcp-server/tools/definitions/get-moon-phase.tool.js';
import { getRiseSetTool } from '@/mcp-server/tools/definitions/get-rise-set.tool.js';
import { getSkyPositionTool } from '@/mcp-server/tools/definitions/get-sky-position.tool.js';
import { listVisibleTool } from '@/mcp-server/tools/definitions/list-visible.tool.js';
import { num } from '@/mcp-server/tools/format-numbers.js';
import { initEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { STAR_CATALOG } from '@/services/ephemeris/star-catalog.js';
import { captureThrown } from '../helpers/capture-thrown.js';
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
    const err = captureThrown(() => {
      getSkyPositionTool.handler(input, ctx);
    });
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
    const err = captureThrown(() => {
      getSkyPositionTool.handler(input, ctx);
    });
    expect(err?.data?.reason).toBe('star_not_found');
    expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('lists the whole star catalog on star_not_found, on both client surfaces', async () => {
    // "Toliman" is a real name for Alpha Centauri, but not the catalog's — alternate proper
    // names stay a miss, and the miss names what the catalog does hold.
    const result = await runToolContract(getSkyPositionTool, { star: 'Toliman', ...SEATTLE });
    const names = STAR_CATALOG.map((s) => s.name);
    const envelope = errorEnvelope(result) as
      | (ReturnType<typeof errorEnvelope> & { data?: { catalog_stars?: string[] } })
      | undefined;
    expect(result.isError).toBe(true);
    expect(envelope?.data?.reason).toBe('star_not_found');
    expect(envelope?.data?.catalog_stars).toEqual(names);
    const text = firstText(result);
    for (const name of names) {
      expect(envelope?.message).toContain(name);
      expect(text).toContain(name);
    }
    expect(text).toContain(
      `Recovery: ${declaredRecovery(getSkyPositionTool.errors, 'star_not_found')}`,
    );
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
    const err = captureThrown(() => {
      getMoonPhaseTool.handler(input, ctx);
    });
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
    const ctx = createMockContext({ errors: getMoonPhaseTool.errors });
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
    const ctx = createMockContext({ errors: getMoonPhaseTool.errors });
    const input = getMoonPhaseTool.input.parse({ time: '2024-04-23T23:49:00Z' });
    const result = await getMoonPhaseTool.handler(input, ctx);
    const block = getMoonPhaseTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(displayValuesOf(text)).not.toMatch(/\.\d{4,}/);
    expectExactCarried(text, result.phase_longitude_degrees);
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
    const err = captureThrown(() => {
      getRiseSetTool.handler(input, ctx);
    });
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
  it.each([
    ['solar_eclipse', { latitude: 41.9 }],
    ['lunar_eclipse', { longitude: 12.5 }],
  ] as const)('fails incomplete_observer for a %s with one coordinate', (event, coordinate) => {
    // A lone coordinate cannot place an observer. Dropping it would silently answer a
    // different question — global circumstances — than the one the caller asked.
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event,
      start: '2026-01-01T00:00:00Z',
      ...coordinate,
    });
    const err = captureThrown(() => {
      findEventsTool.handler(input, ctx);
    });
    expect(err?.data?.reason).toBe('incomplete_observer');
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.recovery?.hint).toBe(
      declaredRecovery(findEventsTool.errors, 'incomplete_observer'),
    );
  });

  it('ignores a lone coordinate on an event that takes no observer', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'equinox',
      start: '2026-01-01T00:00:00Z',
      latitude: 41.9,
    });
    const result = await findEventsTool.handler(input, ctx);
    expect(result.events).toHaveLength(1);
  });

  it('fails time_out_of_range for a start outside the supported span', () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'equinox',
      start: '1880-01-01T00:00:00Z',
    });
    const err = captureThrown(() => {
      findEventsTool.handler(input, ctx);
    });
    expect(err?.data?.reason).toBe('time_out_of_range');
  });

  it('answers a lunar eclipse without an observer, geocentric and with no local fields', async () => {
    // Without coordinates the eclipse is the same event for every observer, so neither
    // surface may carry local visibility or per-contact altitudes.
    const result = await runToolContract(findEventsTool, {
      event: 'lunar_eclipse',
      start: '2024-01-01T00:00:00Z',
    });
    expect(result.isError).toBeFalsy();
    const e = (result.structuredContent as FindEventsOutputType).events[0]!;
    expect(e.event).toBe('lunar_eclipse');
    expect(e.contacts?.peak_utc).toBeTruthy();
    expect(e.local_visible).toBeUndefined();
    expect(e.contact_altitudes_degrees).toBeUndefined();
    const text = firstText(result);
    expect(text).not.toContain('Locally visible');
    expect(text).not.toContain('Contact altitudes');
  });

  it.each([
    ['opposition', 'sun'],
    ['opposition', 'venus'],
    ['conjunction', 'moon'],
    ['perigee_apogee', 'sun'],
  ] as const)('fails body_not_supported for %s of %s', (event, body) => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({ event, body, start: '2026-01-01T00:00:00Z' });
    const err = captureThrown(() => {
      findEventsTool.handler(input, ctx);
    });
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

  it('renders a null obscuration honestly (global partial solar, no observer)', async () => {
    // The 2025-03-29 partial: the engine defines no obscuration for a global partial, and
    // format() must not invent one.
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'solar_eclipse',
      start: '2025-03-01T00:00:00Z',
    });
    const result = await findEventsTool.handler(input, ctx);
    expect(result.events[0]?.kind).toBe('partial');
    expect(result.events[0]?.obscuration).toBeNull();
    const block = findEventsTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('**Obscuration:** unavailable');
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

/** The success payload of a `runToolContract` call, typed as find_events output. */
function eventsOf(result: ToolCallResult): FindEventsOutputType['events'] {
  return (result.structuredContent as FindEventsOutputType).events;
}

/** Every `content[]` text block joined — `format()` output plus the enrichment trailer. */
function allText(result: ToolCallResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** Every number in `structuredContent` is recoverable from the `content[]` a client reads. */
function expectContentCarriesEveryNumber(result: ToolCallResult): void {
  const text = allText(result);
  for (const [path, value] of numericLeaves(result.structuredContent)) {
    expect(text, `${path} = ${value} is not recoverable from content[]`).toContain(String(value));
  }
}

/**
 * Eclipse circumstances, driven through the production rendering path so each field is
 * asserted on both client surfaces: `structuredContent` for structured clients, and the
 * `content[]` text a format()-only client reads — every number recoverable from it.
 */
describe('astronomy_find_events — eclipse circumstances on both surfaces', () => {
  const ROME = { latitude: 41.9, longitude: 12.5 };

  it('marks the 2026-08-12 sunset partial from Rome visible, with every contact altitude', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'solar_eclipse',
      start: '2026-01-01T00:00:00Z',
      ...ROME,
    });
    expect(result.isError).toBeFalsy();
    const e = eventsOf(result)[0]!;
    expect(e.time_utc.startsWith('2026-08-12')).toBe(true);
    expect(e.local_visible).toBe(true);
    const altitudes = e.contact_altitudes_degrees!;
    expect(Object.keys(altitudes)).toEqual([
      'partial_begin',
      'total_begin',
      'peak',
      'total_end',
      'partial_end',
    ]);
    expect(altitudes.partial_begin).toBeCloseTo(6.7, 1);
    expect(altitudes.total_begin).toBeNull();
    expect(altitudes.peak).toBeCloseTo(-1.9, 1);
    expect(altitudes.total_end).toBeNull();
    expect(altitudes.partial_end).toBeCloseTo(-10.1, 1);
    // `contacts` stays time-only.
    for (const value of Object.values(e.contacts!)) {
      expect(value === null || typeof value === 'string').toBe(true);
    }

    const text = firstText(result);
    expect(text).toContain('**Locally visible:** yes');
    expect(text).toContain(`partial_begin ${num1(altitudes.partial_begin!)}`);
    expect(text).toContain(`peak ${num1(altitudes.peak!)}`);
    expect(text).toContain(`partial_end ${num1(altitudes.partial_end!)}`);
    expectContentCarriesEveryNumber(result);
    expectRoundedDisplay(text);
  });

  it('keeps the Dallas totality visible with all five contact altitudes above the horizon', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'solar_eclipse',
      start: '2024-01-01T00:00:00Z',
      latitude: 32.7767,
      longitude: -96.797,
    });
    const e = eventsOf(result)[0]!;
    expect(e.local_visible).toBe(true);
    for (const [phase, altitude] of Object.entries(e.contact_altitudes_degrees!)) {
      expect(altitude!, `${phase} altitude`).toBeGreaterThan(0);
      expect(firstText(result)).toContain(`${phase} ${num1(altitude!)}`);
    }
  });

  it('returns global solar eclipses with peak coordinates when no observer is supplied', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'solar_eclipse',
      start: '2026-08-01T00:00:00Z',
      count: 2,
    });
    expect(result.isError).toBeFalsy();
    const events = eventsOf(result);
    expect(events.map((e) => e.kind)).toEqual(['total', 'annular']);
    expect(events[0]!.peak_latitude_degrees).toBeCloseTo(65.2, 1);
    expect(events[0]!.peak_longitude_degrees).toBeCloseTo(-25.2, 1);
    expect(events[1]!.peak_latitude_degrees).toBeCloseTo(-31.3, 1);
    expect(events[1]!.peak_longitude_degrees).toBeCloseTo(-48.5, 1);
    for (const e of events) {
      expect(e.local_visible).toBeUndefined();
      expect(e.contact_altitudes_degrees).toBeUndefined();
    }

    const text = firstText(result);
    expect(text).toContain(
      `**Peak location:** lat ${num1(events[0]!.peak_latitude_degrees!)}, lon ${num1(events[0]!.peak_longitude_degrees!)}`,
    );
    expect(text).not.toContain('Locally visible');
    expectContentCarriesEveryNumber(result);
  });

  it('omits the peak location for a global partial solar eclipse on both surfaces', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'solar_eclipse',
      start: '2025-03-01T00:00:00Z',
    });
    const e = eventsOf(result)[0]!;
    expect(e.kind).toBe('partial');
    expect(e.peak_latitude_degrees).toBeUndefined();
    expect(e.peak_longitude_degrees).toBeUndefined();
    expect(firstText(result)).not.toContain('Peak location');
  });

  it('reports lunar local circumstances at all seven contacts when coordinates are supplied', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'lunar_eclipse',
      start: '2025-01-01T00:00:00Z',
      ...SEATTLE,
    });
    expect(result.isError).toBeFalsy();
    const e = eventsOf(result)[0]!;
    expect(e.kind).toBe('total');
    expect(e.local_visible).toBe(true);
    const altitudes = e.contact_altitudes_degrees!;
    expect(Object.keys(altitudes)).toEqual([
      'penumbral_begin',
      'partial_begin',
      'total_begin',
      'peak',
      'total_end',
      'partial_end',
      'penumbral_end',
    ]);
    const text = firstText(result);
    expect(text).toContain('**Locally visible:** yes');
    for (const [phase, altitude] of Object.entries(altitudes)) {
      expect(altitude, `${phase} altitude`).not.toBeNull();
      expect(text).toContain(`${phase} ${num1(altitude!)}`);
    }
    expectContentCarriesEveryNumber(result);
  });

  it('reports a daytime lunar eclipse not visible, and nulls unreached phases', async () => {
    const daytime = await runToolContract(findEventsTool, {
      event: 'lunar_eclipse',
      start: '2025-09-01T00:00:00Z',
      ...SEATTLE,
    });
    expect(eventsOf(daytime)[0]!.local_visible).toBe(false);
    expect(firstText(daytime)).toContain('**Locally visible:** no');

    const partial = await runToolContract(findEventsTool, {
      event: 'lunar_eclipse',
      start: '2026-08-01T00:00:00Z',
      ...SEATTLE,
    });
    const altitudes = eventsOf(partial)[0]!.contact_altitudes_degrees!;
    expect(altitudes.total_begin).toBeNull();
    expect(altitudes.total_end).toBeNull();
    // A phase that does not occur is left out of the rendered line, as in Contacts.
    const line = firstText(partial)
      .split('\n')
      .find((l) => l.startsWith('**Contact altitudes:**'));
    expect(line).toBeDefined();
    expect(line).not.toContain('total_begin');
    expect(line).toContain('penumbral_begin');
  });
});

/**
 * Searches stop at the end of the supported span. A list cut short that way is not the
 * complete answer the caller asked for, so the handler says so — on both surfaces.
 */
describe('astronomy_find_events — the end of the supported span', () => {
  /** The `notice` enrichment on a successful call's structuredContent. */
  const noticeOf = (result: ToolCallResult) =>
    (result.structuredContent as { notice?: string }).notice;

  it('returns zero events and a notice when the first result falls past 2100', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'opposition',
      body: 'mars',
      start: '2099-12-01T00:00:00Z',
      count: 5,
    });
    expect(result.isError).toBeFalsy();
    expect(eventsOf(result)).toEqual([]);
    expect(noticeOf(result)).toMatch(/0 of 5/);
    expect(noticeOf(result)).toMatch(/2100/);
    // The empty list renders as a clean header; the notice rides the enrichment trailer.
    expect(firstText(result)).toBe('## 0 events found');
    expect(allText(result)).toContain(noticeOf(result)!);
  });

  it('names N of M when the span ends partway through the requested count', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'solstice',
      start: '2100-01-01T00:00:00Z',
      count: 5,
    });
    expect(eventsOf(result).map((e) => e.which)).toEqual(['june', 'december']);
    expect(noticeOf(result)).toMatch(/2 of 5/);
    expect(allText(result)).toContain(noticeOf(result)!);
  });

  it('adds no notice when the full count fits inside the span', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'moon_quarter',
      start: '2100-12-01T00:00:00Z',
      count: 4,
    });
    expect(eventsOf(result)).toHaveLength(4);
    expect(noticeOf(result)).toBeUndefined();
    expect(allText(result)).not.toContain('supported span');
  });
});

/** The one-decimal display `format()` gives an angle, with its exact tail when lossy. */
const num1 = (value: number) => num(value, 1, '°');

/**
 * Every numeric leaf of a response, with its dotted path. The `content[]` parity
 * assertions run off this rather than a written-out field list, so a numeric field
 * added to an output schema later is covered without anyone remembering to add it.
 */
function numericLeaves(value: unknown, path = ''): [string, number][] {
  if (typeof value === 'number') return [[path, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    numericLeaves(child, path ? `${path}.${key}` : key),
  );
}

describe('astronomy_list_visible — boundaries and validation', () => {
  it('fails time_out_of_range outside the supported span', () => {
    const ctx = createMockContext({ errors: listVisibleTool.errors });
    const input = listVisibleTool.input.parse({ ...SEATTLE, time: '2200-01-01T00:00:00Z' });
    const err = captureThrown(() => {
      listVisibleTool.handler(input, ctx);
    });
    expect(err?.data?.reason).toBe('time_out_of_range');
  });

  it('returns an empty list and the "no bodies" format when min_altitude excludes everything', async () => {
    const ctx = createMockContext({ errors: listVisibleTool.errors });
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
    const ctx = createMockContext({ errors: listVisibleTool.errors });
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
    const ctx = createMockContext({ errors: listVisibleTool.errors });
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
    const ctx = createMockContext({ errors: listVisibleTool.errors });
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

  it('format() makes a listed star altitude and RA recoverable without a second call', async () => {
    const ctx = createMockContext({ errors: listVisibleTool.errors });
    const input = listVisibleTool.input.parse({
      ...SEATTLE,
      time: '2024-08-01T08:00:00Z',
      include_stars: true,
    });
    const result = await listVisibleTool.handler(input, ctx);
    const star = result.bodies.find((b) => b.body === 'Arcturus');
    expect(star).toBeDefined();
    const block = listVisibleTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    // `alt 11.5°` and `RA 14.28h` are what a scan reads; 11.5053577071495 and
    // 14.280223566073504 are what a structured client gets. Both surfaces carry both.
    expectExactCarried(text, star!.horizontal.altitude_degrees);
    expectExactCarried(text, star!.equatorial.ra_hours);
    // The rounded value still leads the phrase.
    expect(displayValuesOf(text)).toContain(
      `alt ${star!.horizontal.altitude_degrees.toFixed(1)}° az ${star!.horizontal.azimuth_degrees.toFixed(1)}°`,
    );
  });

  it('format() carries every number in the result, not a hand-picked subset', async () => {
    const ctx = createMockContext({ errors: listVisibleTool.errors });
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
    // Driven off the response rather than a listed field set, so a numeric field added
    // to the output later without a tail fails here instead of shipping unrecoverable.
    const leaves = numericLeaves(result);
    expect(leaves.length).toBeGreaterThan(result.bodies.length * 8);
    for (const [path, value] of leaves) {
      expect(text, `${path} = ${value} is not recoverable from content[]`).toContain(String(value));
    }
    // The rounded display still leads every phrase, and the exact fraction behind a
    // percentage stays labelled so 100% is never read back as the 1 the schema declares.
    expectRoundedDisplay(text);
    expect(text).toContain('fraction ');
  });

  it('format() reads a null field as n/a and attempts no tail on it', async () => {
    const ctx = createMockContext({ errors: listVisibleTool.errors });
    const input = listVisibleTool.input.parse({
      ...SEATTLE,
      time: '2024-08-01T08:00:00Z',
      include_stars: true,
    });
    const result = await listVisibleTool.handler(input, ctx);
    // A catalog star carries a magnitude but no angular diameter, phase, or
    // illumination; a planet carries all four. Both shapes are on this one sweep.
    const star = result.bodies.find((b) => b.body === 'Arcturus');
    const planet = result.bodies.find((b) => b.body === 'saturn');
    expect(star?.angular_diameter_arcsec).toBeNull();
    expect(star?.phase_angle_degrees).toBeNull();
    expect(star?.illuminated_fraction).toBeNull();
    expect(planet?.illuminated_fraction).not.toBeNull();

    const block = listVisibleTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    const lines = text.split('\n');
    const starLine = lines[lines.findIndex((l) => l.includes(`${star!.rank}. Arcturus`)) + 1] ?? '';
    expect(starLine).toContain('⌀ n/a');
    expect(starLine).toContain('phase n/a');
    expect(starLine).toContain('illum n/a');
    expect(starLine).not.toMatch(/n\/a\s*\[/);
    // The magnitude it does have is still recoverable.
    expectExactCarried(starLine, star!.magnitude!);
  });

  it('the empty-list scan still carries the sky-condition numbers and no body tails', async () => {
    const ctx = createMockContext({ errors: listVisibleTool.errors });
    const input = listVisibleTool.input.parse({
      ...SEATTLE,
      time: '2024-06-21T20:00:00Z',
      min_altitude: 90,
    });
    const result = await listVisibleTool.handler(input, ctx);
    expect(result.bodies).toHaveLength(0);
    const block = listVisibleTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expectExactCarried(text, result.sun_altitude_degrees);
    // One tail, the sun altitude's — there are no bodies to carry any others.
    expect(text.match(/\[/g) ?? []).toHaveLength(1);
    expectRoundedDisplay(text);
  });

  it('carries the exact values on both client surfaces of one call', async () => {
    const result = await runToolContract(listVisibleTool, {
      ...SEATTLE,
      time: '2024-06-21T09:00:00Z',
      include_stars: true,
    });
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    // Read off the wire shapes a client actually receives, not the handler's return:
    // every number in structuredContent is recoverable from the content[] twin.
    for (const [path, value] of numericLeaves(result.structuredContent)) {
      expect(text, `${path} = ${value} is not recoverable from content[]`).toContain(String(value));
    }
  });

  it('astronomy_get_sky_position agrees with the scan line on a body they both report', async () => {
    const time = '2024-06-21T09:00:00Z';
    const listed = await listVisibleTool.handler(
      listVisibleTool.input.parse({ ...SEATTLE, time, min_altitude: -90 }),
      createMockContext({ errors: listVisibleTool.errors }),
    );
    const body = listed.bodies.find((b) => b.body === 'saturn');
    expect(body).toBeDefined();
    const detail = await getSkyPositionTool.handler(
      getSkyPositionTool.input.parse({ body: 'saturn', ...SEATTLE, time }),
      createMockContext({ errors: getSkyPositionTool.errors }),
    );
    // Same instant, same observer, same schema — the two tools must not disagree on a
    // body they both report. Each carries its own exact values, so this pins cross-tool
    // consistency rather than a recovery path from one surface to the other.
    expect(detail.equatorial.ra_hours).toBe(body!.equatorial.ra_hours);
    const block = getSkyPositionTool.format!(detail)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expectExactCarried(text, body!.equatorial.ra_hours);
    expectExactCarried(text, body!.horizontal.altitude_degrees);
    expectExactCarried(text, body!.equatorial.distance_au);
  });
});

/**
 * `resolveTime()` is shared by all five core tools, so the calendar-validity check lands
 * in one place — but each tool reaches it through its own input field (`time` on three,
 * `start` on two), and a tool that forgot to route through the resolver would not be
 * caught by a service-level test. One case per tool pins the fan-out.
 */
describe('core tools — impossible calendar dates', () => {
  const IMPOSSIBLE = '2026-02-30T00:00:00Z';

  it('astronomy_get_sky_position rejects an impossible date in time', () => {
    const ctx = createMockContext({ errors: getSkyPositionTool.errors });
    const input = getSkyPositionTool.input.parse({ body: 'mars', ...SEATTLE, time: IMPOSSIBLE });
    const err = captureThrown(() => {
      getSkyPositionTool.handler(input, ctx);
    });
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_time');
    expect(err?.data?.recovery?.hint).toBeTruthy();
  });

  it('astronomy_get_rise_set rejects an impossible date in start', () => {
    const ctx = createMockContext({ errors: getRiseSetTool.errors });
    const input = getRiseSetTool.input.parse({ body: 'sun', ...SEATTLE, start: IMPOSSIBLE });
    const err = captureThrown(() => {
      getRiseSetTool.handler(input, ctx);
    });
    expect(err?.data?.reason).toBe('invalid_time');
  });

  it('astronomy_get_moon_phase rejects an impossible date in time', () => {
    const ctx = createMockContext({ errors: getMoonPhaseTool.errors });
    const input = getMoonPhaseTool.input.parse({ time: IMPOSSIBLE });
    const err = captureThrown(() => {
      getMoonPhaseTool.handler(input, ctx);
    });
    expect(err?.data?.reason).toBe('invalid_time');
  });

  it('astronomy_find_events rejects an impossible date in start', () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({ event: 'equinox', start: IMPOSSIBLE });
    const err = captureThrown(() => {
      findEventsTool.handler(input, ctx);
    });
    expect(err?.data?.reason).toBe('invalid_time');
  });

  it('astronomy_list_visible answers the impossible date it used to normalize away', () => {
    // The reported defect: this call succeeded and reported time_utc 2026-03-02, two days
    // after the date the caller asked about.
    const ctx = createMockContext({ errors: listVisibleTool.errors });
    const input = listVisibleTool.input.parse({ ...SEATTLE, time: IMPOSSIBLE });
    const err = captureThrown(() => {
      listVisibleTool.handler(input, ctx);
    });
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_time');
    expect(err?.data?.recovery?.hint).toBeTruthy();
  });

  it('astronomy_list_visible still answers a real leap day', async () => {
    const ctx = createMockContext({ errors: listVisibleTool.errors });
    const input = listVisibleTool.input.parse({
      ...SEATTLE,
      time: '2024-02-29T12:00:00Z',
      min_altitude: -90,
    });
    const result = await listVisibleTool.handler(input, ctx);
    expect(result.bodies.length).toBeGreaterThan(0);
    expect(result.bodies[0]?.time_utc).toBe('2024-02-29T12:00:00.000Z');
  });
});

/** The dual-surface result `runToolContract` returns, without a direct SDK import. */
type ToolCallResult = Awaited<ReturnType<typeof runToolContract>>;

/** The error envelope a client reads off `structuredContent` on a failed call. */
interface ToolErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    data?: { reason?: string; recovery?: { hint?: string } };
  };
}

/** Read the `structuredContent.error` surface of a `CallToolResult`. */
function errorEnvelope(result: ToolCallResult): ToolErrorEnvelope['error'] {
  return (result.structuredContent as ToolErrorEnvelope | undefined)?.error;
}

/** Read the `content[0]` text surface of a `CallToolResult`. */
function firstText(result: ToolCallResult): string {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
}

/** The `recovery` string a definition declares for one of its contract reasons. */
function declaredRecovery(errors: readonly ErrorContract[] | undefined, reason: string): string {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No contract entry declares reason "${reason}".`);
  return entry.recovery;
}

/** One core tool, with everything needed to drive its handler through the resolvers. */
interface CoreToolCase {
  /** Parse `raw` against this tool's input schema and run its handler on a wired ctx. */
  call: (raw: Record<string, unknown>) => unknown;
  errors: readonly ErrorContract[] | undefined;
  name: string;
  /** The input field this tool routes into `resolveTime()`. */
  timeField: 'time' | 'start';
  /** The smallest input that reaches the resolvers, minus the field under test. */
  valid: Record<string, unknown>;
}

const CORE_TOOL_CASES: CoreToolCase[] = [
  {
    name: 'astronomy_get_sky_position',
    errors: getSkyPositionTool.errors,
    call: (raw) =>
      getSkyPositionTool.handler(
        getSkyPositionTool.input.parse(raw),
        createMockContext({ errors: getSkyPositionTool.errors }),
      ),
    valid: { body: 'mars', ...SEATTLE },
    timeField: 'time',
  },
  {
    name: 'astronomy_get_rise_set',
    errors: getRiseSetTool.errors,
    call: (raw) =>
      getRiseSetTool.handler(
        getRiseSetTool.input.parse(raw),
        createMockContext({ errors: getRiseSetTool.errors }),
      ),
    valid: { body: 'sun', ...SEATTLE },
    timeField: 'start',
  },
  {
    name: 'astronomy_get_moon_phase',
    errors: getMoonPhaseTool.errors,
    call: (raw) =>
      getMoonPhaseTool.handler(
        getMoonPhaseTool.input.parse(raw),
        createMockContext({ errors: getMoonPhaseTool.errors }),
      ),
    valid: {},
    timeField: 'time',
  },
  {
    name: 'astronomy_find_events',
    errors: findEventsTool.errors,
    call: (raw) =>
      findEventsTool.handler(
        findEventsTool.input.parse(raw),
        createMockContext({ errors: findEventsTool.errors }),
      ),
    valid: { event: 'equinox' },
    timeField: 'start',
  },
  {
    name: 'astronomy_list_visible',
    errors: listVisibleTool.errors,
    call: (raw) =>
      listVisibleTool.handler(
        listVisibleTool.input.parse(raw),
        createMockContext({ errors: listVisibleTool.errors }),
      ),
    valid: { ...SEATTLE },
    timeField: 'time',
  },
];

/**
 * `resolveTime()` and `resolveTimezone()` take no ctx, so each hint is written at the
 * throw site rather than resolved from the calling tool's contract. Nothing links the
 * two, so a declared `recovery` can drift into documenting a next move no client is
 * ever handed — or, as here, a reachable reason can go undeclared entirely. Each case
 * asserts the declared string and the thrown hint are the same string.
 */
describe.each(CORE_TOOL_CASES)('$name — service-raised contracts', (c) => {
  it('declares the invalid_time hint resolveTime() throws', () => {
    const err = captureThrown(() => {
      c.call({ ...c.valid, [c.timeField]: '2026-02-30T00:00:00Z' });
    });
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_time');
    expect(err?.data?.recovery?.hint).toBe(declaredRecovery(c.errors, 'invalid_time'));
  });

  it('declares the invalid_timezone hint resolveTimezone() throws', () => {
    const err = captureThrown(() => {
      c.call({ ...c.valid, timezone: 'Mars/Olympus_Mons' });
    });
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_timezone');
    expect(err?.data?.recovery?.hint).toBe(declaredRecovery(c.errors, 'invalid_timezone'));
  });

  it('leaves time_out_of_range on the wire unchanged', () => {
    const err = captureThrown(() => {
      c.call({ ...c.valid, [c.timeField]: '1850-01-01T00:00:00Z' });
    });
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(err?.data?.recovery?.hint).toBe('Use a date between 1900 and 2100.');
  });

  it('still answers a real instant in a known zone', async () => {
    const result = await c.call({
      ...c.valid,
      [c.timeField]: '2024-04-08T18:00:00Z',
      timezone: 'America/Los_Angeles',
    });
    expect(result).toBeDefined();
  });
});

/**
 * Clients split on which surface they forward: structuredContent-only clients read
 * `data.recovery.hint`, format()-only clients read the `Recovery:` line. A declared
 * contract is only worth its words if both surfaces carry it.
 */
describe('astronomy_list_visible — invalid_time reaches both client surfaces', () => {
  it('carries the declared hint in structuredContent and in content[] text', async () => {
    const result = await runToolContract(listVisibleTool, {
      ...SEATTLE,
      time: '2026-02-30T00:00:00Z',
    });
    const hint = declaredRecovery(listVisibleTool.errors, 'invalid_time');

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.data?.reason).toBe('invalid_time');
    expect(errorEnvelope(result)?.data?.recovery?.hint).toBe(hint);
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
  });

  it('answers a real instant without an error envelope', async () => {
    const result = await runToolContract(listVisibleTool, {
      ...SEATTLE,
      time: '2024-04-08T18:00:00Z',
      min_altitude: -90,
    });
    expect(result.isError).toBeFalsy();
    expect(errorEnvelope(result)).toBeUndefined();
  });
});
