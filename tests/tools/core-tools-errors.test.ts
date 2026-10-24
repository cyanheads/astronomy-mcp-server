/**
 * @fileoverview Error-path and edge-case coverage for the five core tool handlers,
 *   complementing the happy-path wiring tests in core-tools.test.ts. Covers every
 *   declared `ctx.fail` reason (time_out_of_range, star_not_found, the find_events
 *   gates), the Zod validation rejections (out-of-range coordinates, count bounds),
 *   boundary contracts (empty visible list, circumpolar notes, multi-count
 *   pagination), and format() completeness on the tools the happy-path file does
 *   not exercise. Closes with the contracts EphemerisService raises on all five
 *   (invalid_time, invalid_timezone, time_out_of_range), asserting each declared
 *   `recovery` is the same string the resolver throws (time_out_of_range is thrown
 *   with none, so the declared one fills it), and one tool's error
 *   reaching both client surfaces. The deterministic numeric correctness lives in
 *   the EphemerisService tests; here we assert the tool-layer contracts.
 * @module tests/tools/core-tools-errors.test
 */

import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type FindEventsOutputType,
  findEventsTool,
} from '@/mcp-server/tools/definitions/find-events.tool.js';
import { getMoonPhaseTool } from '@/mcp-server/tools/definitions/get-moon-phase.tool.js';
import {
  getRiseSetTool,
  type RiseSetOutputType,
} from '@/mcp-server/tools/definitions/get-rise-set.tool.js';
import { getSkyPositionTool } from '@/mcp-server/tools/definitions/get-sky-position.tool.js';
import { listVisibleTool } from '@/mcp-server/tools/definitions/list-visible.tool.js';
import { num } from '@/mcp-server/tools/format-numbers.js';
import {
  getEphemerisService,
  initEphemerisService,
} from '@/services/ephemeris/ephemeris-service.js';
import { STAR_CATALOG } from '@/services/ephemeris/star-catalog.js';
import type {
  EventBodyName,
  EventName,
  PairBodyName,
  RiseSetEvent,
} from '@/services/ephemeris/types.js';
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

  it('rejects a count above the ceiling of 366, and a non-integer count', () => {
    // Up to 366 is served 31 per call (see the per-call cap block below); past it the
    // schema still rejects.
    expect(() => getRiseSetTool.input.parse({ body: 'sun', ...SEATTLE, count: 367 })).toThrow();
    expect(() => getRiseSetTool.input.parse({ body: 'sun', ...SEATTLE, count: 1.5 })).toThrow();
    expect(getRiseSetTool.input.parse({ body: 'sun', ...SEATTLE, count: 366 }).count).toBe(366);
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

/**
 * A count past the 31-per-call cap is served up to the cap, with a notice naming the exact
 * `start` that continues the series — the instant the cycle loop itself would resume from.
 */
describe('astronomy_get_rise_set — a count past the per-call cap', () => {
  const call = async (input: Parameters<typeof runToolContract<typeof getRiseSetTool>>[1]) => {
    const result = await runToolContract(getRiseSetTool, input);
    expect(result.isError).toBeFalsy();
    return { result, out: result.structuredContent as RiseSetOutputType & CapEnrichment };
  };
  /** One cycle's instants, in a form the wire and service shapes both reduce to. */
  const wireKey = (e: RiseSetOutputType['events'][number]) =>
    JSON.stringify([e.rise_utc, e.set_utc, e.transit_utc, e.note ?? null, e.twilight ?? null]);
  const serviceKey = (e: RiseSetEvent) =>
    JSON.stringify([
      e.riseUtc,
      e.setUtc,
      e.transitUtc,
      e.note ?? null,
      e.twilight
        ? Object.fromEntries(
            (['civil', 'nautical', 'astronomical'] as const).map((d) => [
              d,
              { dawn_utc: e.twilight![d].dawnUtc, dusk_utc: e.twilight![d].duskUtc },
            ]),
          )
        : null,
    ]);

  it('serves 31 cycles and names the exact resume start on both surfaces', async () => {
    const { result, out } = await call({
      body: 'sun',
      ...SEATTLE,
      start: '2026-10-15T19:00:00Z',
      count: 40,
    });
    expect(out.events).toHaveLength(31);
    expect(out.totalCount).toBe(31);
    expect(out.truncated).toBe(true);
    expect(out.shown).toBe(31);
    expect(out.cap).toBe(31);
    // One second past the 31st cycle's set, 2026-11-15T00:33:45.555Z.
    expect(out.events[30]?.set_utc).toBe('2026-11-15T00:33:45.555Z');
    expect(out.notice).toBe(
      'Returned 31 of the 40 requested cycles (31 per call). Re-call with start 2026-11-15T00:33:46.555Z and count 9 for the rest.',
    );
    expect(allText(result)).toContain(out.notice!);
  });

  it('resumes at the named start without repeating or skipping a cycle', async () => {
    const svc = getEphemerisService();
    const sites = [
      { latitude: 47.6, longitude: -122.33 },
      { latitude: 69.65, longitude: 18.96 },
      { latitude: -33.9, longitude: 18.4 },
    ];
    for (const site of sites) {
      for (const body of ['sun', 'moon', 'mars', 'jupiter'] as const) {
        const label = `${body} at ${site.latitude}`;
        const start = '2026-10-15T19:00:00Z';
        const first = await call({ body, ...site, start, count: 40 });
        const resume = resumeOf(first.out.notice);
        expect(resume?.count, label).toBe(9);
        const rest = await call({ body, ...site, ...resume });
        expect(rest.out.notice, label).toBeUndefined();
        const uncapped = svc.riseSet(body, { ...site, elevation: 0 }, new Date(start), 40);
        expect([...first.out.events, ...rest.out.events].map(wireKey), label).toEqual(
          uncapped.map(serviceKey),
        );
      }
    }
  });

  it('re-slices corrected shallow crossings and polar nights through two continuation pages', async () => {
    for (const input of [
      { body: 'moon' as const, latitude: 68, longitude: 18.96, start: '2026-09-07T12:00:00Z' },
      {
        body: 'sun' as const,
        latitude: -67.39,
        longitude: -68.13,
        start: '2027-06-22T06:34:32.666Z',
      },
    ]) {
      const first = await call({ ...input, count: 65 });
      const second = await call({ ...input, ...resumeOf(first.out.notice) });
      const third = await call({ ...input, ...resumeOf(second.out.notice) });
      expect(first.out.events).toHaveLength(31);
      expect(second.out.events).toHaveLength(31);
      expect(third.out.events).toHaveLength(3);
      expect(third.out.notice).toBeUndefined();
      const whole = getEphemerisService().riseSet(
        input.body,
        { latitude: input.latitude, longitude: input.longitude, elevation: 0 },
        new Date(input.start),
        65,
      );
      expect([...first.out.events, ...second.out.events, ...third.out.events].map(wireKey)).toEqual(
        whole.map(serviceKey),
      );
      for (const page of [first, second]) expect(allText(page.result)).toContain(page.out.notice!);
    }
  });

  it('resumes just past the lower culmination of a last cycle that has no set', async () => {
    // Tromsø's midnight sun: every cycle is circumpolar, so the loop resumes past each day's lower culmination.
    const tromso = { latitude: 69.65, longitude: 18.96 };
    const first = await call({ body: 'sun', ...tromso, start: '2026-06-01T00:00:00Z', count: 40 });
    expect(first.out.events[30]?.set_utc).toBeNull();
    const resume = resumeOf(first.out.notice);
    expect(resume).toEqual({ start: '2026-07-01T22:48:09.206Z', count: 9 });
    const rest = await call({ body: 'sun', ...tromso, ...resume });
    const uncapped = getEphemerisService().riseSet(
      'sun',
      { ...tromso, elevation: 0 },
      new Date('2026-06-01T00:00:00Z'),
      40,
    );
    expect(rest.out.events.map(wireKey)).toEqual(uncapped.slice(31).map(serviceKey));
  });

  /**
   * The named start falls one second past the last cycle's set, so the Sun is down there and
   * the continuation reports the night under way — the one the previous call's last cycle
   * already carried. Its events pick up at the next sunrise without repeating it.
   */
  it('repeats the last cycle_s night as the continuation_s night in progress', async () => {
    const start = '2026-10-15T19:00:00Z';
    const first = await call({ body: 'sun', ...SEATTLE, start, count: 40 });
    const rest = await call({ body: 'sun', ...SEATTLE, ...resumeOf(first.out.notice) });
    const last = first.out.events[30]!;
    const night = rest.out.night_in_progress!;
    for (const depth of ['civil', 'nautical', 'astronomical'] as const) {
      for (const side of ['dusk_utc', 'dawn_utc'] as const) {
        const label = `${depth} ${side}`;
        const carried = Date.parse(night[depth][side]!);
        const previous = Date.parse(last.twilight![depth][side]!);
        expect(Math.abs(carried - previous), label).toBeLessThan(1000);
        expect(allText(rest.result), label).toContain(night[depth][side]!);
      }
    }
    expect(Date.parse(rest.out.events[0]!.rise_utc!)).toBeGreaterThan(Date.parse(last.set_utc!));
    const uncapped = getEphemerisService().riseSet(
      'sun',
      { ...SEATTLE, elevation: 0 },
      new Date(start),
      40,
    );
    expect([...first.out.events, ...rest.out.events].map(wireKey)).toEqual(
      uncapped.map(serviceKey),
    );
  });

  it('names the whole remainder at the ceiling', async () => {
    const { out } = await call({
      body: 'moon',
      ...SEATTLE,
      start: '2026-10-15T19:00:00Z',
      count: 366,
    });
    expect(out.events).toHaveLength(31);
    expect(out.notice).toMatch(
      /^Returned 31 of the 366 requested cycles \(31 per call\)\. Re-call with start \S+ and count 335 for the rest\.$/,
    );
  });

  it('names no continuation when the next cycle starts past the supported span', async () => {
    // The 31st sunset from 2100-12-15 falls in 2101, so the start that would continue the
    // series — one second past it — lies where every call fails time_out_of_range.
    const { result, out } = await call({
      body: 'sun',
      ...SEATTLE,
      start: '2100-12-15T00:00:00Z',
      count: 40,
    });
    expect(out.events).toHaveLength(31);
    expect(out.events[30]?.set_utc).toBe('2101-01-14T00:42:22.254Z');
    expect(out).toMatchObject({ truncated: true, shown: 31, cap: 31 });
    expect(out.notice).toBe(
      'Returned 31 of the 40 requested cycles (31 per call). The next cycle starts past the end of the supported span (2100), so no call can continue the series.',
    );
    expect(allText(result)).toContain(out.notice!);
    const next = await runToolContract(getRiseSetTool, {
      body: 'sun',
      ...SEATTLE,
      start: '2101-01-14T00:42:23.254Z',
      count: 9,
    });
    expect(errorEnvelope(next)?.data?.reason).toBe('time_out_of_range');
  });

  it('names a continuation that lands inside the span, and it succeeds', async () => {
    const first = await call({ body: 'sun', ...SEATTLE, start: '2100-11-01T00:00:00Z', count: 40 });
    const resume = resumeOf(first.out.notice);
    expect(resume).toEqual({ start: '2100-12-01T00:20:14.028Z', count: 9 });
    const rest = await call({ body: 'sun', ...SEATTLE, ...resume });
    expect(rest.out.events).toHaveLength(9);
    expect(rest.out.notice).toBeUndefined();
  });

  it('adds no notice or truncation at or under the cap', async () => {
    for (const count of [1, 31]) {
      const { out } = await call({ body: 'sun', ...SEATTLE, start: '2026-10-15T19:00:00Z', count });
      expect(out.events).toHaveLength(count);
      expect(out.totalCount).toBe(count);
      for (const key of ['notice', 'truncated', 'shown', 'cap']) {
        expect(key in out, `${key} at count ${count}`).toBe(false);
      }
    }
  });
});

describe('astronomy_find_events — error contracts and validation', () => {
  it.each([
    ['solar_eclipse', { latitude: 41.9 }],
    ['lunar_eclipse', { longitude: 12.5 }],
  ] as const)(
    'fails incomplete_observer for a %s with one coordinate',
    async (event, coordinate) => {
      // A lone coordinate cannot place an observer. Dropping it would silently answer a
      // different question — global circumstances — than the one the caller asked.
      const result = await runToolContract(findEventsTool, {
        event,
        start: '2026-01-01T00:00:00Z',
        ...coordinate,
      });
      const err = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(err?.data?.reason).toBe('incomplete_observer');
      expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err?.data?.recovery?.hint).toBe(
        declaredRecovery(findEventsTool.errors, 'incomplete_observer'),
      );
    },
  );

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

  it('rejects a count above the ceiling of 200, below 1, or fractional', () => {
    for (const count of [201, 0, 1.5]) {
      expect(() => findEventsTool.input.parse({ event: 'equinox', count }), `${count}`).toThrow();
    }
    expect(findEventsTool.input.parse({ event: 'equinox', count: 200 }).count).toBe(200);
  });

  it('passes body2 on an event other than conjunction through to fail invalid_body_pair', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'opposition',
      body: 'mars',
      body2: 'saturn',
      start: '2026-01-01T00:00:00Z',
    });
    const err = errorEnvelope(result);
    expect(result.isError).toBe(true);
    expect(err?.data?.reason).toBe('invalid_body_pair');
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.recovery?.hint).toBe(
      declaredRecovery(findEventsTool.errors, 'invalid_body_pair'),
    );
  });

  it('rejects the Sun or Earth as body2 at the schema', () => {
    for (const body2 of ['sun', 'earth']) {
      expect(
        findEventsTool.input.safeParse({ event: 'conjunction', body: 'venus', body2 }).success,
        body2,
      ).toBe(false);
    }
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

  it('returns an eclipse whose peak follows start with its earlier contacts on both surfaces', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'solar_eclipse',
      start: '2024-04-08T18:42:00Z',
      latitude: 32.78,
      longitude: -96.8,
    });
    expect(result.isError).toBeFalsy();
    const event = eventsOf(result)[0]!;
    expect(event.time_utc).toBe('2024-04-08T18:42:37.121Z');
    expect(Date.parse(event.contacts!.partial_begin_utc!)).toBeLessThan(
      Date.parse('2024-04-08T18:42:00Z'),
    );
    expect(firstText(result)).toContain('2024-04-08T18:42:37.121Z');
    expect(firstText(result)).toContain(event.contacts!.partial_begin_utc!);
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

  it('stops a slow two-body pair at the span end with the same notice', async () => {
    const jupiterSaturn = await runToolContract(findEventsTool, {
      event: 'conjunction',
      body: 'jupiter',
      body2: 'saturn',
      start: '2026-10-15T00:00:00Z',
      count: 5,
    });
    expect(eventsOf(jupiterSaturn)).toHaveLength(4);
    expect(noticeOf(jupiterSaturn)).toBe(
      'The search reached the end of the supported span (2100) after 4 of 5 requested events; no occurrence after 2100 is computed.',
    );

    const uranusNeptune = await runToolContract(findEventsTool, {
      event: 'conjunction',
      body: 'uranus',
      body2: 'neptune',
      start: '2026-10-15T00:00:00Z',
    });
    expect(eventsOf(uranusNeptune)).toEqual([]);
    expect(noticeOf(uranusNeptune)).toBe(
      'The search reached the end of the supported span (2100) after 0 of 1 requested events; no occurrence after 2100 is computed.',
    );
    expect(allText(uranusNeptune)).toContain(noticeOf(uranusNeptune)!);
  });
});

/**
 * Two-body conjunctions name both bodies and carry the separation at the conjunction
 * instant, on both client surfaces.
 */
describe('astronomy_find_events — two-body conjunctions on both surfaces', () => {
  it('reports Venus–Jupiter with both bodies and the separation', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'conjunction',
      body: 'venus',
      body2: 'jupiter',
      start: '2026-10-15T00:00:00Z',
      timezone: 'Europe/Rome',
    });
    expect(result.isError).toBeFalsy();
    const out = findEventsTool.output.parse(result.structuredContent);
    const e = out.events[0]!;
    expect(e.event).toBe('conjunction');
    expect(e.body).toBe('venus');
    expect(e.body2).toBe('jupiter');
    expect(e.time_utc.slice(0, 16)).toBe('2027-08-26T02:59');
    expect(e.time_local?.slice(0, 16)).toBe('2027-08-26T04:59');
    expect(Math.abs(e.separation_degrees! - 0.495)).toBeLessThanOrEqual(0.005);
    expect(e.conjunction_kind).toBeUndefined();

    const text = firstText(result);
    expect(text).toContain('### conjunction — venus and jupiter');
    expect(text).toContain(`**Separation:** ${num(e.separation_degrees!, 3, '°')}`);
    expectContentCarriesEveryNumber(result);
    expectRoundedDisplay(text);
  });

  it('keeps a conjunction with the Sun free of the two-body fields', async () => {
    const result = await runToolContract(findEventsTool, {
      event: 'conjunction',
      body: 'venus',
      start: '2026-10-15T00:00:00Z',
    });
    const e = eventsOf(result)[0]!;
    expect(e.conjunction_kind).toBe('inferior');
    expect('body2' in e).toBe(false);
    expect('separation_degrees' in e).toBe(false);
    const text = firstText(result);
    expect(text).toContain('### conjunction — venus\n');
    expect(text).not.toContain('Separation');
  });
});

/**
 * A `count` past 20 is served 20 at a time. The notice names the exact `start` that
 * continues the series — an hour past the last event returned, ten days past the last
 * eclipse.
 */
describe('astronomy_find_events — a count past the per-call cap', () => {
  const call = async (input: Parameters<typeof runToolContract<typeof findEventsTool>>[1]) => {
    const result = await runToolContract(findEventsTool, input);
    expect(result.isError).toBeFalsy();
    return { result, out: result.structuredContent as FindEventsOutputType & CapEnrichment };
  };
  /**
   * The served events match an uncapped search one for one. Each instant is refined to
   * within a second of the true one, from whichever bracket the search starts in, so the
   * two can differ by under two seconds — never by an event.
   */
  const expectSameInstants = (
    served: FindEventsOutputType['events'],
    uncapped: ReadonlyArray<{ timeUtc: string }>,
  ) => {
    expect(served).toHaveLength(uncapped.length);
    served.forEach((e, i) => {
      expect(
        Math.abs(Date.parse(e.time_utc) - Date.parse(uncapped[i]!.timeUtc)),
        `#${i + 1}`,
      ).toBeLessThan(2000);
    });
  };

  it('serves 20 events and names the exact resume start on both surfaces', async () => {
    const { result, out } = await call({
      event: 'moon_quarter',
      start: '2026-10-15T00:00:00Z',
      count: 24,
    });
    expect(out.events).toHaveLength(20);
    expect(out.totalCount).toBe(20);
    expect(out.truncated).toBe(true);
    expect(out.shown).toBe(20);
    expect(out.cap).toBe(20);
    // One hour past the 20th event, 2027-03-08T09:30:07.391Z.
    expect(out.events[19]?.time_utc).toBe('2027-03-08T09:30:07.391Z');
    expect(out.notice).toBe(
      'Returned 20 of the 24 requested events (20 per call). Re-call with start 2027-03-08T10:30:07.391Z and count 4 for the rest.',
    );
    expect(allText(result)).toContain(out.notice!);
  });

  /**
   * One search per hour-offset class: the event and its body or pair. The eclipse classes,
   * which resume ten days on, are walked page by page below.
   */
  interface ClassCase {
    body?: EventBodyName;
    body2?: PairBodyName;
    event: EventName;
  }
  const CLASSES: Array<[string, ClassCase]> = [
    ['equinox', { event: 'equinox' }],
    ['solstice', { event: 'solstice' }],
    ['moon_quarter', { event: 'moon_quarter' }],
    ['opposition of jupiter', { event: 'opposition', body: 'jupiter' }],
    ['conjunction of venus', { event: 'conjunction', body: 'venus' }],
    ['conjunction of mercury', { event: 'conjunction', body: 'mercury' }],
    ['max_elongation of mercury', { event: 'max_elongation', body: 'mercury' }],
    ['perigee_apogee of the moon', { event: 'perigee_apogee', body: 'moon' }],
    ['perigee_apogee of earth', { event: 'perigee_apogee', body: 'earth' }],
    ['conjunction of mercury and venus', { event: 'conjunction', body: 'mercury', body2: 'venus' }],
    ['conjunction of the moon and saturn', { event: 'conjunction', body: 'moon', body2: 'saturn' }],
  ];

  it.each(CLASSES)(
    'resumes %s at the named start without repeating or skipping an event',
    async (_label, { event, body, body2 }) => {
      const start = '2026-10-15T00:00:00Z';
      const args = { event, ...(body ? { body } : {}), ...(body2 ? { body2 } : {}) };
      const first = await call({ ...args, start, count: 40 });
      expect(first.out.events).toHaveLength(20);
      const resume = resumeOf(first.out.notice);
      expect(resume?.count).toBe(20);
      const rest = await call({ ...args, ...resume });
      expect(rest.out.notice).toBeUndefined();
      const uncapped = getEphemerisService().findEvents(event, {
        start: new Date(start),
        count: 40,
        ...(body ? { body } : {}),
        ...(body2 ? { body2 } : {}),
      });
      expectSameInstants([...first.out.events, ...rest.out.events], uncapped);
    },
  );

  /**
   * Eclipse continuation retains the ten-day offset used by astronomy-engine's
   * next-eclipse iterators.
   */
  it('resumes a local solar eclipse series past the eclipse it ended on', async () => {
    const args = { event: 'solar_eclipse', latitude: 0, longitude: 0 } as const;
    const first = await call({ ...args, start: '1950-03-01T00:00:00Z', count: 24 });
    expect(first.out.events).toHaveLength(20);
    expect(first.out.events[19]?.time_utc).toBe('2002-12-04T05:47:26.311Z');
    expect(first.out.notice).toBe(
      'Returned 20 of the 24 requested events (20 per call). Re-call with start 2002-12-14T05:47:26.311Z and count 4 for the rest.',
    );
    expect(allText(first.result)).toContain(first.out.notice!);
    const rest = await call({ ...args, ...resumeOf(first.out.notice) });
    expect(rest.out.events.map((e) => e.time_utc)).toEqual([
      '2005-10-03T10:05:17.375Z',
      '2006-03-29T09:02:30.840Z',
      '2006-09-22T11:02:06.755Z',
      '2010-01-15T05:17:24.355Z',
    ]);
    expect(rest.out.notice).toBeUndefined();
  });

  it.each([
    ['lunar_eclipse', { event: 'lunar_eclipse' }],
    ['lunar_eclipse from 60° N, 60° E', { event: 'lunar_eclipse', latitude: 60, longitude: 60 }],
    ['global solar_eclipse', { event: 'solar_eclipse' }],
    ['solar_eclipse from 0°, 0°', { event: 'solar_eclipse', latitude: 0, longitude: 0 }],
    ['solar_eclipse from 30° S, 60° E', { event: 'solar_eclipse', latitude: -30, longitude: 60 }],
  ] as const)(
    'walks every page of %s from 1900 without repeating or skipping an eclipse',
    async (_label, args) => {
      const start = '1900-01-01T00:00:00Z';
      const observer =
        'latitude' in args
          ? { latitude: args.latitude, longitude: args.longitude, elevation: 0 }
          : undefined;
      const uncapped = getEphemerisService().findEvents(args.event, {
        start: new Date(start),
        count: 200,
        ...(observer ? { observer } : {}),
      });
      const served: FindEventsOutputType['events'] = [];
      let next: { start: string; count: number } | undefined = { start, count: 200 };
      let lastNotice: string | undefined;
      for (let page = 1; next; page++) {
        expect(page, 'pages walked').toBeLessThanOrEqual(11);
        const { out } = await call({ ...args, ...next });
        served.push(...out.events);
        lastNotice = out.notice;
        next = resumeOf(out.notice);
      }
      // The four solar walks past an observer end at 2100 with fewer than 200 eclipses.
      if (uncapped.length === 200) expect(lastNotice).toBeUndefined();
      else expect(lastNotice).toMatch(/^The search reached the end of the supported span/);
      expectSameInstants(served, uncapped);
    },
  );

  it('names the whole remainder at the ceiling', async () => {
    const { out } = await call({
      event: 'moon_quarter',
      start: '2026-10-15T00:00:00Z',
      count: 200,
    });
    expect(out.events).toHaveLength(20);
    expect(out.notice).toMatch(
      /^Returned 20 of the 200 requested events \(20 per call\)\. Re-call with start \S+ and count 180 for the rest\.$/,
    );
  });

  /**
   * A 20th event whose resume start would leave the span: an hour past it for most
   * classes, ten days past it for an eclipse. No class has an event that close to the end
   * of 2100, so the service is stubbed at the tool seam with 20 events of the class ending
   * at the instant under test, spaced as that class's events are. From 2100-12-31T23:00Z
   * (2100-12-22T00:00Z for an eclipse) on, the resume start falls past 2100 and the span
   * notice replaces the cap notice; no event of the class lies in that gap, so none is lost.
   */
  describe('a 20th event at the edge of the span', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const SPAN_NOTICE =
      'The search reached the end of the supported span (2100) after 20 of 40 requested events; no occurrence after 2100 is computed.';
    const CAP_NOTICE =
      'Returned 20 of the 40 requested events (20 per call). Re-call with start 2100-12-31T23:59:59.999Z and count 20 for the rest.';
    const RECORDS = {
      moon_quarter: { record: { event: 'moon_quarter', quarter: 'new' }, spacingDays: 7 },
      lunar_eclipse: { record: { event: 'lunar_eclipse', kind: 'penumbral' }, spacingDays: 177 },
    } as const;

    it.each([
      ['moon_quarter', '2100-12-31T23:00:00.000Z', SPAN_NOTICE],
      ['moon_quarter', '2100-12-31T22:59:59.999Z', CAP_NOTICE],
      ['lunar_eclipse', '2100-12-22T00:00:00.000Z', SPAN_NOTICE],
      ['lunar_eclipse', '2100-12-21T23:59:59.999Z', CAP_NOTICE],
    ] as const)('%s ending at %s', async (event, lastIso, notice) => {
      const { record, spacingDays } = RECORDS[event];
      vi.spyOn(getEphemerisService(), 'findEvents').mockReturnValue(
        Array.from({ length: 20 }, (_unused, k) => ({
          ...record,
          timeUtc: new Date(
            Date.parse(lastIso) - (19 - k) * spacingDays * 86_400_000,
          ).toISOString(),
        })),
      );
      const { result, out } = await call({ event, start: '2091-01-01T00:00:00Z', count: 40 });
      expect(out.events).toHaveLength(20);
      expect(out.notice).toBe(notice);
      expect(allText(result)).toContain(notice);
      if (notice === CAP_NOTICE) expect(out).toMatchObject({ truncated: true, shown: 20, cap: 20 });
      else for (const key of ['truncated', 'shown', 'cap']) expect(key in out, key).toBe(false);
    });
  });

  it('adds no notice or truncation at or under the cap', async () => {
    for (const count of [1, 20]) {
      const { out } = await call({ event: 'moon_quarter', start: '2026-10-15T00:00:00Z', count });
      expect(out.events).toHaveLength(count);
      expect(out.totalCount).toBe(count);
      for (const key of ['notice', 'truncated', 'shown', 'cap']) {
        expect(key in out, `${key} at count ${count}`).toBe(false);
      }
    }
  });

  it('gives the span notice alone when the span ends before the cap', async () => {
    const { out } = await call({ event: 'moon_quarter', start: '2100-11-01T00:00:00Z', count: 40 });
    expect(out.events).toHaveLength(9);
    expect(out.notice).toBe(
      'The search reached the end of the supported span (2100) after 9 of 40 requested events; no occurrence after 2100 is computed.',
    );
    for (const key of ['truncated', 'shown', 'cap']) expect(key in out, key).toBe(false);
  });

  it('gives the cap notice alone when exactly 20 events remain, and the span notice on the resume', async () => {
    // The last 20 moon quarters of the span begin 2100-08-12.
    const first = await call({ event: 'moon_quarter', start: '2100-08-10T00:00:00Z', count: 40 });
    expect(first.out.events).toHaveLength(20);
    expect(first.out.truncated).toBe(true);
    expect(first.out.notice).toBe(
      'Returned 20 of the 40 requested events (20 per call). Re-call with start 2100-12-31T00:56:53.058Z and count 20 for the rest.',
    );
    const rest = await call({ event: 'moon_quarter', ...resumeOf(first.out.notice) });
    expect(rest.out.events).toEqual([]);
    expect(rest.out.notice).toBe(
      'The search reached the end of the supported span (2100) after 0 of 20 requested events; no occurrence after 2100 is computed.',
    );
    expect('truncated' in rest.out).toBe(false);
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

/** The enrichment a capped series adds beside a successful call's output. */
interface CapEnrichment {
  cap?: number;
  notice?: string;
  shown?: number;
  totalCount?: number;
  truncated?: boolean;
}

/** The resume `start` and `count` a per-call cap notice names. */
function resumeOf(notice: string | undefined): { start: string; count: number } | undefined {
  const match = /Re-call with start (\S+) and count (\d+) for the rest\.$/.exec(notice ?? '');
  return match?.[1] && match[2] ? { start: match[1], count: Number(match[2]) } : undefined;
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
 * asserts the declared string and the thrown hint are the same string. `time_out_of_range`
 * is the exception: it is thrown with no hint, so the framework sends each tool's own
 * declared recovery (asserted on the wire in error-contract-coverage.test.ts).
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

  it('raises time_out_of_range with no hint, leaving the declared recovery to fill it', () => {
    const err = captureThrown(() => {
      c.call({ ...c.valid, [c.timeField]: '1850-01-01T00:00:00Z' });
    });
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(err?.data?.recovery).toBeUndefined();
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
