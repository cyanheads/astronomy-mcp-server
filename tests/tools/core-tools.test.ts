/**
 * @fileoverview End-to-end tests for the five core tool handlers — schema conformance,
 *   format() parity at runtime, output shape, and the validation-gate error paths. The
 *   deep numeric correctness lives in the EphemerisService tests; here we verify the
 *   tool wiring, output shape, and the typed `ctx.fail` contracts.
 * @module tests/tools/core-tools.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { findEventsTool } from '@/mcp-server/tools/definitions/find-events.tool.js';
import { getMoonPhaseTool } from '@/mcp-server/tools/definitions/get-moon-phase.tool.js';
import { getRiseSetTool } from '@/mcp-server/tools/definitions/get-rise-set.tool.js';
import { getSkyPositionTool } from '@/mcp-server/tools/definitions/get-sky-position.tool.js';
import { listVisibleTool } from '@/mcp-server/tools/definitions/list-visible.tool.js';
import { initEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { expectExactCarried, expectRoundedDisplay } from '../helpers/content-parity.js';

const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };

beforeAll(() => {
  initEphemerisService();
});

describe('astronomy_get_sky_position', () => {
  it('returns a schema-conforming position for Mars', async () => {
    const ctx = createMockContext();
    const input = getSkyPositionTool.input.parse({
      body: 'mars',
      ...SEATTLE,
      time: '2024-08-01T08:00:00Z',
    });
    const result = await getSkyPositionTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(getSkyPositionTool.output));
    expect(result.body).toBe('mars');
  });

  it('resolves a named star and ignores body when star is set', async () => {
    const ctx = createMockContext();
    const input = getSkyPositionTool.input.parse({ star: 'Vega', body: 'mars', ...SEATTLE });
    const result = await getSkyPositionTool.handler(input, ctx);
    expect(result.body).toBe('Vega');
  });

  it('fails with body_required when neither body nor star is supplied', () => {
    const ctx = createMockContext({ errors: getSkyPositionTool.errors });
    const input = getSkyPositionTool.input.parse({ ...SEATTLE });
    expect(() => getSkyPositionTool.handler(input, ctx)).toThrow(/body|star/i);
  });

  it('format() renders every output field at runtime', async () => {
    const ctx = createMockContext();
    const input = getSkyPositionTool.input.parse({ body: 'jupiter', ...SEATTLE });
    const result = await getSkyPositionTool.handler(input, ctx);
    const block = getSkyPositionTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('jupiter');
    expect(text).toContain('Magnitude');
    expect(text).toContain('Constellation');
  });

  it('format() keeps a rounded report while carrying every exact coordinate', async () => {
    const ctx = createMockContext();
    const input = getSkyPositionTool.input.parse({
      body: 'mars',
      ...SEATTLE,
      time: '2024-08-01T08:00:00Z',
    });
    const result = await getSkyPositionTool.handler(input, ctx);
    const block = getSkyPositionTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    // The report a human reads stays rounded at each field's chosen precision…
    expectRoundedDisplay(text);
    expect(text).toContain(`RA ${result.equatorial.ra_hours.toFixed(4)} h`);
    expect(text).toContain(`altitude ${result.horizontal.altitude_degrees.toFixed(2)}°`);
    // …and a content[]-only client can still recover what structuredContent says.
    expectExactCarried(text, result.equatorial.ra_hours);
    expectExactCarried(text, result.equatorial.dec_degrees);
    expectExactCarried(text, result.equatorial.distance_au);
    expectExactCarried(text, result.horizontal.altitude_degrees);
    expectExactCarried(text, result.horizontal.azimuth_degrees);
    expectExactCarried(text, result.ecliptic.longitude_degrees);
    expectExactCarried(text, result.ecliptic.latitude_degrees);
    if (result.magnitude !== null) expectExactCarried(text, result.magnitude);
    if (result.angular_diameter_arcsec !== null) {
      expectExactCarried(text, result.angular_diameter_arcsec);
    }
    if (result.phase_angle_degrees !== null) expectExactCarried(text, result.phase_angle_degrees);
    if (result.illuminated_fraction !== null) {
      expect(text).toContain(`[fraction ${result.illuminated_fraction}]`);
    }
  });
});

describe('astronomy_get_moon_phase', () => {
  it('returns a schema-conforming phase record', async () => {
    const ctx = createMockContext();
    const input = getMoonPhaseTool.input.parse({ time: '2024-04-23T23:49:00Z' });
    const result = await getMoonPhaseTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(getMoonPhaseTool.output));
    expect(result.next_quarters).toHaveLength(4);
  });
});

describe('astronomy_get_rise_set', () => {
  it('returns rise/set with twilight for the sun and conforms to schema', async () => {
    const ctx = createMockContext();
    const input = getRiseSetTool.input.parse({
      body: 'sun',
      ...SEATTLE,
      start: '2024-06-21T00:00:00Z',
    });
    const result = await getRiseSetTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(getRiseSetTool.output));
    expect(result.events[0]?.twilight).toBeDefined();
  });

  it('omits twilight for a non-sun body', async () => {
    const ctx = createMockContext();
    const input = getRiseSetTool.input.parse({
      body: 'moon',
      ...SEATTLE,
      start: '2024-06-21T00:00:00Z',
    });
    const result = await getRiseSetTool.handler(input, ctx);
    expect(result.events[0]?.twilight).toBeUndefined();
  });
});

describe('astronomy_find_events', () => {
  it('fails observer_required for a solar eclipse without coordinates', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'solar_eclipse',
      start: '2024-01-01T00:00:00Z',
    });
    await expect(Promise.resolve().then(() => findEventsTool.handler(input, ctx))).rejects.toThrow(
      /observer|latitude/i,
    );
  });

  it('fails body_required for an opposition without a body', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'opposition',
      start: '2024-01-01T00:00:00Z',
    });
    await expect(Promise.resolve().then(() => findEventsTool.handler(input, ctx))).rejects.toThrow(
      /body/i,
    );
  });

  it('fails body_not_supported for max_elongation of an outer planet', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'max_elongation',
      body: 'jupiter',
      start: '2024-01-01T00:00:00Z',
    });
    const err = await Promise.resolve()
      .then(() => findEventsTool.handler(input, ctx))
      .catch((e: unknown) => e as { data?: { reason?: string; recovery?: { hint?: string } } });
    expect(err?.data?.reason).toBe('body_not_supported');
    // The alternatives ride the recovery hint, which is what reaches the agent.
    expect(err?.data?.recovery?.hint).toMatch(/mercury|venus/i);
  });

  it('returns geocentric equinoxes without an observer and conforms to schema', async () => {
    const ctx = createMockContext({ errors: findEventsTool.errors });
    const input = findEventsTool.input.parse({
      event: 'equinox',
      start: '2024-01-01T00:00:00Z',
      count: 2,
    });
    const result = await findEventsTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(findEventsTool.output));
    expect(result.events).toHaveLength(2);
  });
});

describe('astronomy_list_visible', () => {
  it('returns a ranked list with the sky-condition gate fields in the output', async () => {
    const ctx = createMockContext();
    const input = listVisibleTool.input.parse({ ...SEATTLE, time: '2024-06-21T20:00:00Z' });
    const result = await listVisibleTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(listVisibleTool.output));
    expect(result.bodies[0]?.rank).toBe(1);
    // Sky condition, sun altitude, and count ride the output (not enrichment) so
    // content[]-only clients receive them.
    expect(result.sky_condition).toBe('daylight');
    expect(result.total_count).toBe(result.bodies.length);
  });
});
