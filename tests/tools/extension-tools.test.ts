/**
 * @fileoverview Tests for the two gated, network-backed extension tools —
 *   astronomy_get_ephemeris (JPL Horizons) and astronomy_get_satellite_passes
 *   (CelesTrak TLE + SGP4). The network boundary (`fetchWithTimeout` → global
 *   `fetch`) is stubbed with canned upstream text so no live request is made; the
 *   SGP4 propagation and the Horizons CSV parse run for real against the fixtures.
 *
 *   Covers every declared `ctx.fail` reason (invalid_time, invalid_time_range,
 *   incomplete_observer, invalid_elevation, invalid_step, body_not_found, request_rejected,
 *   horizons_unavailable,
 *   tle_not_found, object_decayed, time_out_of_range, celestrak_unavailable,
 *   malformed_element_set), the split between a CelesTrak outage and a 200 whose GP
 *   record fails OMM validation — one retryable, one permanent — the
 *   happy-path parse, a sparse upstream payload (Horizons "n.a." magnitude → null),
 *   rows the parse cannot turn into a point (short layout, "n.a." distance, an
 *   unparseable position) being dropped and disclosed rather than shipped as a
 *   schema-invalid NaN that fails the whole call, the drop and truncation caveats
 *   composing into one notice, the truncation-disclosure enrichment as it reaches a
 *   client (domain payload merged with enrichment and parsed against the effective
 *   output schema, not the bare handler return), the Horizons query parameters the
 *   advertised altitude semantics depend on (including the refraction toggle, set for a
 *   topocentric request only), two-page continuation from the advertised resume instant
 *   on both a fixed-duration and a calendar step — concatenating with no repeated
 *   instant and no gap — and the calendar-stepping skip rule that carries a month or
 *   year step to the next period that has the day (multi-count steps included), the
 *   fractional seconds Horizons echoes, a STOP_TIME bounded to one row past the page, a
 *   name matching several major bodies, the calendar years Horizons reads,
 *   pass-boundary detection at all three positions of `start` relative
 *   to a rise (before, exactly on, mid-pass) and at the window's end (a pass still up when
 *   it closes followed to its set), satellite rise, set, and visible-stretch edges checked
 *   against an independent one-second rescan, the visible-stretch keep rule (two-stretch
 *   passes included), the per-call `days` cap and a continuation that neither repeats nor
 *   skips a pass, offset timestamps reaching Horizons as parsed instants,
 *   a refused date kept apart from a designation miss, the resolved `target_name` on both
 *   surfaces, the well-known satellite-name alias table, the split between a decayed object and a
 *   start the element set cannot reach — including the epoch-horizon rejection of a start
 *   SGP4 would still have propagated, pinned against the propagator's own answer at that
 *   instant so it cannot decay into a re-test of the probe it replaced — observer alt/az
 *   inclusion, the TLE cache, and format() completeness including the empty-result branch.
 * @module tests/tools/extension-tools.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type ErrorContract, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Body, Equator, Horizon, MakeTime, Observer } from 'astronomy-engine';
import {
  ecfToLookAngles,
  eciToEcf,
  gstime,
  jday,
  json2satrec,
  propagate,
  shadowFraction,
  sunPos,
} from 'satellite.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toJSONSchema } from 'zod/v4/core';
import {
  type EphemerisOutputType,
  getEphemerisTool,
} from '@/mcp-server/tools/definitions/get-ephemeris.tool.js';
import {
  getSatellitePassesTool,
  type SatellitePassesOutputType,
} from '@/mcp-server/tools/definitions/get-satellite-passes.tool.js';
import { initEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { HorizonsService, initHorizonsService } from '@/services/horizons/horizons-service.js';
import { initSatelliteService, SatelliteService } from '@/services/satellite/satellite-service.js';
import { OmmResponseSchema } from '@/services/satellite/types.js';
import { captureRejected } from '../helpers/capture-thrown.js';
import {
  displayValuesOf,
  expectExactCarried,
  expectRoundedDisplay,
} from '../helpers/content-parity.js';

const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };

/** A canned `fetch` returning fixed text for every call (so retries see the same body). */
function stubFetch(body: string, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: ok ? 200 : 503 })),
  );
}

/**
 * Stub `fetch` so it throws the exact status-mapped McpError shape
 * `fetchWithTimeout` raises on a non-2xx — its `data` carries the upstream
 * internals the public server must NOT leak, under both the canonical
 * `status`/`body` names and the legacy `statusCode`/`responseBody` aliases,
 * plus `requestId`; the message carries the request URL. `retryable: false`
 * makes `withRetry` give up on the first attempt so the leak-strip is
 * exercised without burning the backoff schedule. The service's catch must
 * reclassify this into its typed domain error, dropping every internal.
 */
function stubFetchThrowsUpstream(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Fetch failed for https://internal.example.test/api. Status: 503',
        {
          requestId: 'req-internal-abc123',
          operation: 'fetch',
          status: 503,
          statusText: 'Service Unavailable',
          body: '<html>upstream stack trace and internal host details</html>',
          statusCode: 503,
          responseBody: '<html>upstream stack trace and internal host details</html>',
          errorSource: 'FetchHttpError',
          retryable: false,
        },
      );
    }),
  );
}

/**
 * Stub `fetch` so it throws the `Timeout` McpError `fetchWithTimeout` raises
 * when its own deadline fires — a distinct JSON-RPC code from the
 * `ServiceUnavailable` a 5xx maps to, and one that still carries `requestId`
 * and `errorSource` internals. Each service catches the whole fetch boundary,
 * so a timeout must surface as that service's own unavailable contract rather
 * than bubbling the framework code and its data to the client.
 */
function stubFetchThrowsTimeout(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new McpError(JsonRpcErrorCode.Timeout, 'Fetch timed out.', {
        requestId: 'req-internal-abc123',
        operation: 'fetch',
        errorSource: 'FetchTimeout',
        retryable: false,
      });
    }),
  );
}

/** Assert a client-facing error `data` payload carries none of the upstream internals. */
function expectNoUpstreamLeak(data: unknown): void {
  const serialized = JSON.stringify(data);
  expect(serialized).not.toContain('statusCode');
  expect(serialized).not.toContain('responseBody');
  expect(serialized).not.toContain('status');
  expect(serialized).not.toContain('body');
  expect(serialized).not.toContain('requestId');
  expect(serialized).not.toContain('errorSource');
  expect(serialized).not.toContain('503');
  expect(serialized).not.toContain('internal.example.test');
  expect(serialized).not.toMatch(/https?:\/\//);
}

/**
 * Reproduce the surface a client actually receives for the ephemeris tool: the domain
 * payload merged with accumulated enrichment and parsed against
 * `output.extend(enrichment)`, exactly as the framework's tool handler factory builds
 * `structuredContent`. Asserting on the raw handler return value instead skips the
 * merge — and therefore the parse that silently strips any enriched key the definition
 * never declared.
 */
function mergedEphemerisOutput(domain: EphemerisOutputType, ctx: Context) {
  return getEphemerisTool.output
    .extend(getEphemerisTool.enrichment!)
    .parse({ ...domain, ...getEnrichment(ctx) });
}

/** Build a Horizons OBSERVER CSV block. Geocentric layout: date,flag,flag,RA,Dec,APmag,S-brt,delta,deldot. */
function horizonsGeocentric(rows: string[]): string {
  return ['Some header text', 'JPL Horizons response', '$$SOE', ...rows, '$$EOE', 'trailer'].join(
    '\n',
  );
}

/** Build a Horizons OBSERVER CSV with an observer (adds Az,El columns after Dec). */
function horizonsTopocentric(rows: string[]): string {
  return ['header', '$$SOE', ...rows, '$$EOE'].join('\n');
}

beforeAll(() => {
  initEphemerisService();
});

beforeEach(() => {
  // Re-init the services fresh each test so the TLE cache and config are clean.
  initHorizonsService('https://example.test/horizons', 5000);
  initSatelliteService('https://example.test/celestrak', 5000, 7_200_000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('astronomy_get_ephemeris — happy path', () => {
  it('parses a geocentric ephemeris into RA/Dec/distance/magnitude points', async () => {
    // date, solar-flag, lunar-flag, RA(deg), Dec(deg), APmag, S-brt, delta(AU), deldot
    stubFetch(
      horizonsGeocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
        '2024-Jan-01 01:00:00.0000, , , 45.100000, 12.520000, 9.51, 5.0, 1.501000, 0.0',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433 Eros',
      start: '2024-01-01T00:00:00Z',
      stop: '2024-01-01T02:00:00Z',
      step: '1h',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(getEphemerisTool.output));
    expect(result.designation).toBe('433 Eros');
    expect(result.points).toHaveLength(2);
    // RA is converted from degrees to sidereal hours (45° → 3h).
    expect(result.points[0]?.ra_hours).toBeCloseTo(3, 5);
    expect(result.points[0]?.dec_degrees).toBeCloseTo(12.5, 5);
    expect(result.points[0]?.distance_au).toBeCloseTo(1.5, 5);
    expect(result.points[0]?.magnitude).toBeCloseTo(9.5, 5);
    // No observer → no alt/az.
    expect(result.points[0]?.altitude_degrees).toBeUndefined();
  });

  it('requests az/el (QUANTITIES 4) and returns a finite distance + alt/az for a topocentric observer', async () => {
    // The #1 repro: an observer call must request QUANTITIES '1,4,9,20' so the response
    // carries the Az/El columns parseRow reads. Without '4' the columns shift left, delta
    // lands undefined → distance_au NaN → SerializationError. With observer the layout is
    // date,flag,flag,RA,Dec,Az,El,APmag,S-brt,delta,deldot.
    const fetchSpy = vi.fn(
      async (_url: string | URL) =>
        new Response(
          horizonsTopocentric([
            '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 180.000000, 30.000000, 9.50, 5.0, 1.500000, 0.0',
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433 Eros',
      ...SEATTLE,
      start: '2024-01-01T00:00:00Z',
      stop: '2024-01-01T01:00:00Z',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(decodeURIComponent(String(fetchSpy.mock.calls[0]?.[0]))).toContain(
      "QUANTITIES='1,4,9,20'",
    );
    expect(Number.isFinite(result.points[0]?.distance_au)).toBe(true);
    expect(result.points[0]?.distance_au).toBeCloseTo(1.5, 5);
    expect(result.points[0]?.altitude_degrees).toBeCloseTo(30, 5);
    expect(result.points[0]?.azimuth_degrees).toBeCloseTo(180, 5);
  });

  it('omits the az/el quantity for a geocentric call (QUANTITIES 1,9,20)', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) =>
        new Response(
          horizonsGeocentric([
            '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433 Eros',
      start: '2024-01-01T00:00:00Z',
    });
    await getEphemerisTool.handler(input, ctx);
    const url = decodeURIComponent(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url).toContain("QUANTITIES='1,9,20'");
    expect(url).not.toContain("QUANTITIES='1,4,9,20'");
  });

  it('preserves a null magnitude when Horizons reports "n.a." (sparse payload)', async () => {
    stubFetch(
      horizonsGeocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, n.a., n.a., 1.500000, 0.0',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '1P/Halley',
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result.points[0]?.magnitude).toBeNull();
    // format() must render the uncertainty, not invent a value.
    const block = getEphemerisTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('mag n/a');
  });

  it('parses the seconds-less HH:MM date column as UTC (real OBSERVER-table format)', async () => {
    // Horizons emits "2024-Jan-01 00:00" (no seconds) at hour/day steps — the
    // common case. Asserts the timestamp is the requested UTC instant, never
    // shifted by the host's local offset (the local-time `new Date(...)` trap).
    stubFetch(
      horizonsGeocentric(['2024-Jan-01 00:00, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0']),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result.points[0]?.time_utc).toBe('2024-01-01T00:00:00.000Z');
  });

  it('discloses truncation with an exact-retrieval notice on the merged client surface', async () => {
    // The disclosure only exists once enrichment is merged into the effective output;
    // the handler's own return value carries none of it, so assert on the merged parse.
    const rows: string[] = [];
    for (let i = 0; i < 250; i++) {
      const hh = String(i % 24).padStart(2, '0');
      rows.push(`2024-Jan-01 ${hh}:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0`);
    }
    stubFetch(horizonsGeocentric(rows));
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433 Eros',
      start: '2024-01-01T00:00:00Z',
      step: '10m',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    // The service caps at 200 inline rows.
    expect(result.points).toHaveLength(200);

    const merged = mergedEphemerisOutput(result, ctx);
    expect(merged).toMatchObject({ truncated: true, shown: 200, cap: 200 });
    const endsAt = result.points.at(-1)?.time_utc;
    expect(endsAt).toBeTypeOf('string');
    // The notice must name the instant the returned rows end at, and a `start` to
    // resume from that is one step past it — not that same instant, which Horizons'
    // inclusive START_TIME would repeat — while keeping the caller on the same step,
    // since widening it drops samples the original range asked for instead of
    // retrieving them.
    expect(merged.notice).toContain(endsAt as string);
    expect(advertisedResumeInstant(merged.notice)).not.toBe(endsAt);
    expect(merged.notice).toMatch(/same step/i);
  });

  it('reports truncated: false with no notice when the whole span fits the cap', async () => {
    stubFetch(
      horizonsGeocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    const merged = mergedEphemerisOutput(result, ctx);
    expect(merged).toMatchObject({ truncated: false, shown: 1, cap: 200 });
    expect(merged.notice).toBeUndefined();
  });

  it('format() renders the designation, point count, and per-point coordinates', async () => {
    stubFetch(
      horizonsGeocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433 Eros' });
    const result = await getEphemerisTool.handler(input, ctx);
    const block = getEphemerisTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('433 Eros');
    expect(text).toMatch(/RA .* h, Dec/);
    expect(text).toMatch(/AU/);
  });

  it('format() renders a near-Earth distance in AU and carries every exact point value', async () => {
    // 0.0000352417 AU is ~5,270 km — a spacecraft in low orbit, and the case a fixed
    // 4-decimal AU rendering collapsed to "0.0000". Significant figures keep it.
    stubFetch(
      horizonsGeocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.123456, 12.987654, 9.53, 5.0, 0.0000352417, 0.0',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '-48' });
    const result = await getEphemerisTool.handler(input, ctx);
    const block = getEphemerisTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    const p = result.points[0]!;
    expect(p.distance_au.toFixed(4)).toBe('0.0000');
    expect(text).toContain('0.0000352417 AU');
    // The report a human reads stays rounded at each field's chosen precision, and a
    // content[]-only client can still recover what structuredContent says.
    expectRoundedDisplay(text);
    expectExactCarried(text, p.ra_hours);
    expectExactCarried(text, p.dec_degrees);
    expectExactCarried(text, p.distance_au);
    if (p.magnitude !== null) expectExactCarried(text, p.magnitude);
  });

  it('format() rounds the per-point alt/az of an observer ephemeris', async () => {
    stubFetch(
      horizonsTopocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.123456, 12.987654, 120.345679, 51.111111, 9.53, 5.0, 1.234568, 0.0',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', ...SEATTLE });
    const result = await getEphemerisTool.handler(input, ctx);
    const block = getEphemerisTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('alt 51.1°');
    expect(text).toContain('az 120.3°');
    expect(text).not.toContain('undefined');
    expectRoundedDisplay(text);
    const p = result.points[0]!;
    expectExactCarried(text, p.altitude_degrees!);
    expectExactCarried(text, p.azimuth_degrees!);
  });
});

/** Query parameters of a URL a stubbed `fetch` was called with. */
function paramsOf(url: unknown): URLSearchParams {
  return new URL(String(url)).searchParams;
}

/** Stub `fetch` with a one-row block in the layout the observer flag implies. */
function stubOneRow(hasObserver: boolean): ReturnType<typeof vi.fn> {
  const body = hasObserver
    ? horizonsTopocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 180.000000, 30.000000, 9.50, 5.0, 1.500000, 0.0',
      ])
    : horizonsGeocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
      ]);
  const spy = vi.fn(async (_url: string | URL) => new Response(body, { status: 200 }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('astronomy_get_ephemeris — the Horizons request behind the advertised altitude', () => {
  /** The span both requests below ask for, kept explicit so START/STOP are assertable. */
  const SPAN = { start: '2024-01-01T00:00:00Z', stop: '2024-01-02T00:00:00Z', step: '1h' };
  /** START/STOP as Horizons receives them: the parsed instants, never the caller's strings. */
  const SENT_START = new Date(SPAN.start).toISOString();
  const SENT_STOP = new Date(SPAN.stop).toISOString();

  /**
   * A zoneless `start` carries no zone designator, so reading it with `new Date` resolved
   * it in the host's zone — and the default `stop`, derived from it, moved with the
   * deployment. Horizons reads a zoneless `START_TIME` as UTC, so a host-zone reading also
   * put the two ends of the span in different frames.
   */
  it('derives the default stop from a zoneless start read as UTC, in any host zone', async () => {
    const originalTz = process.env.TZ;
    async function stopTimeUnder(tz: string): Promise<string | null> {
      process.env.TZ = tz;
      const fetchSpy = stubOneRow(true);
      const ctx = createMockContext({ errors: getEphemerisTool.errors });
      const input = getEphemerisTool.input.parse({
        designation: '433;',
        ...SEATTLE,
        start: '2026-06-30T12:00:00',
        step: '1h',
      });
      await getEphemerisTool.handler(input, ctx);
      return paramsOf(fetchSpy.mock.calls[0]?.[0]).get('STOP_TIME');
    }
    try {
      expect(await stopTimeUnder('UTC')).toBe("'2026-07-01T12:00:00.000Z'");
      expect(await stopTimeUnder('America/Los_Angeles')).toBe("'2026-07-01T12:00:00.000Z'");
      expect(await stopTimeUnder('Asia/Tokyo')).toBe("'2026-07-01T12:00:00.000Z'");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('keeps every documented query parameter of a topocentric request at its current value', async () => {
    const fetchSpy = stubOneRow(true);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', ...SEATTLE, ...SPAN });
    await getEphemerisTool.handler(input, ctx);

    // Horizons parameters are sent quoted, so assert the quoted form the service sends.
    expect(Object.fromEntries(paramsOf(fetchSpy.mock.calls[0]?.[0]))).toMatchObject({
      format: 'text',
      COMMAND: "'433;'",
      EPHEM_TYPE: 'OBSERVER',
      CENTER: "'coord@399'",
      START_TIME: `'${SENT_START}'`,
      STOP_TIME: `'${SENT_STOP}'`,
      STEP_SIZE: `'${SPAN.step}'`,
      QUANTITIES: "'1,4,9,20'",
      CSV_FORMAT: 'YES',
      ANG_FORMAT: 'DEG',
      EXTRA_PREC: 'YES',
      COORD_TYPE: 'GEODETIC',
      // E-longitude, latitude, height in km — the order Horizons reads SITE_COORD in.
      SITE_COORD: `'${SEATTLE.longitude},${SEATTLE.latitude},0.000000'`,
    });
  });

  it('keeps every documented query parameter of a geocentric request at its current value', async () => {
    const fetchSpy = stubOneRow(false);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', ...SPAN });
    await getEphemerisTool.handler(input, ctx);

    const params = paramsOf(fetchSpy.mock.calls[0]?.[0]);
    expect(Object.fromEntries(params)).toMatchObject({
      format: 'text',
      COMMAND: "'433;'",
      EPHEM_TYPE: 'OBSERVER',
      CENTER: "'500@399'",
      START_TIME: `'${SENT_START}'`,
      STOP_TIME: `'${SENT_STOP}'`,
      STEP_SIZE: `'${SPAN.step}'`,
      QUANTITIES: "'1,9,20'",
      CSV_FORMAT: 'YES',
      ANG_FORMAT: 'DEG',
      EXTRA_PREC: 'YES',
    });
    // Observer geometry belongs to a topocentric request only.
    expect(params.has('COORD_TYPE')).toBe(false);
    expect(params.has('SITE_COORD')).toBe(false);
  });

  it('asks Horizons to refract the elevation of a topocentric request', async () => {
    // altitude_degrees is advertised as refraction-corrected, and Horizons applies
    // refraction only when asked: APPARENT defaults to AIRLESS, so without this
    // parameter the returned elevation is geometric — adrift of the advertised value by
    // a margin that grows toward the horizon, exactly where a caller reads rise/set off it.
    const fetchSpy = stubOneRow(true);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', ...SEATTLE, ...SPAN });
    await getEphemerisTool.handler(input, ctx);

    const params = paramsOf(fetchSpy.mock.calls[0]?.[0]);
    expect(params.get('APPARENT')).toBe('REFRACTED');
    // Pin the whole parameter set, not just the new key: a request that grows or loses a
    // parameter changes which columns come back, and parseRow reads them by position.
    expect([...params.keys()].sort()).toEqual(
      [
        'ANG_FORMAT',
        'APPARENT',
        'CAL_TYPE',
        'CENTER',
        'COMMAND',
        'COORD_TYPE',
        'CSV_FORMAT',
        'EPHEM_TYPE',
        'EXTRA_PREC',
        'QUANTITIES',
        'SITE_COORD',
        'START_TIME',
        'STEP_SIZE',
        'STOP_TIME',
        'format',
      ].sort(),
    );
  });

  it('leaves APPARENT unset for a geocentric request, which refraction cannot apply to', async () => {
    // Per Horizons' own API documentation APPARENT toggles refraction correction for
    // Earth-topocentric requests only, and a geocentric response carries no elevation.
    const fetchSpy = stubOneRow(false);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', ...SPAN });
    const result = await getEphemerisTool.handler(input, ctx);

    expect(paramsOf(fetchSpy.mock.calls[0]?.[0]).has('APPARENT')).toBe(false);
    expect(result.points[0]?.altitude_degrees).toBeUndefined();
    expect(result.points[0]?.azimuth_degrees).toBeUndefined();
  });
});

/** Julian Day at 0h UT of a proleptic Gregorian instant. */
function gregorianJulianDay(iso: string): number {
  return new Date(iso).getTime() / 86_400_000 + 2_440_587.5;
}

/** Julian Day at 0h of a date read in the Julian calendar, as Horizons' mixed mode reads one before 1582-10-15. */
function julianCalendarJulianDay(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32_083.5;
}

/**
 * A `fetch` stub with Horizons' calendar behavior: in its default mixed mode a START_TIME
 * before 1582-10-15 is a Julian-calendar date, so the row labelled with that date belongs
 * to a different instant than the proleptic Gregorian one the label names; with
 * `CAL_TYPE='GREGORIAN'` the label and the instant agree. The row's RA column carries the
 * Julian Day Horizons computed, offset into a small degree value, so a test can read back
 * which instant the position belongs to.
 */
function stubHorizonsCalendar(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string | URL) => {
    const params = paramsOf(url);
    const start = unquote(params.get('START_TIME'));
    const [year, month, day] = start.slice(0, 10).split('-').map(Number) as [
      number,
      number,
      number,
    ];
    const gregorian = unquote(params.get('CAL_TYPE')) === 'GREGORIAN';
    const julianDay =
      !gregorian && start < '1582-10-15'
        ? julianCalendarJulianDay(year, month, day)
        : gregorianJulianDay(`${start.slice(0, 10)}T00:00:00Z`);
    const label = `${year}-${HORIZONS_MONTHS[month - 1]}-${String(day).padStart(2, '0')} 00:00`;
    return new Response(
      horizonsGeocentric([`${label}, , , ${julianDay - 2_268_900}, 10.0, -11.0, 4.6, 0.0026, 0.1`]),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('astronomy_get_ephemeris — one calendar end to end', () => {
  /**
   * ISO 8601 dates are proleptic Gregorian, while Horizons' default calendar mode reads a
   * date before 1582-10-15 as Julian — there `1500-01-01` is JD 2268932.5, Gregorian
   * 1500-01-10. The request asks for the Gregorian calendar on every span, so the row
   * labelled with the start is computed at that start's Gregorian Julian Day.
   */
  it.each([
    ['before 1582, where the default calendar is Julian', '1500-01-01', '1500-01-02'],
    ['after 1582, where the two calendars agree', '2026-01-01', '2026-01-02'],
  ])(
    'computes the row labelled with its start at that Gregorian instant, %s',
    async (_label, day, next) => {
      const spy = stubHorizonsCalendar();
      const ctx = createMockContext({ errors: getEphemerisTool.errors });
      const input = getEphemerisTool.input.parse({
        designation: '301',
        start: `${day}T00:00:00Z`,
        stop: `${next}T00:00:00Z`,
        step: '1d',
      });
      const result = await getEphemerisTool.handler(input, ctx);
      expect(paramsOf(spy.mock.calls[0]?.[0]).get('CAL_TYPE')).toBe('GREGORIAN');
      expect(result.points[0]?.time_utc).toBe(`${day}T00:00:00.000Z`);
      // The position's Julian Day, read back out of the RA column.
      expect((result.points[0]?.ra_hours ?? 0) * 15 + 2_268_900).toBeCloseTo(
        gregorianJulianDay(`${day}T00:00:00Z`),
        6,
      );
    },
  );

  it('pins the stub’s Julian-calendar arithmetic to the value Horizons computed', () => {
    // Live, COMMAND='301' START_TIME='1500-01-01' in mixed mode printed JD 2268932.5.
    expect(julianCalendarJulianDay(1500, 1, 1)).toBe(2_268_932.5);
    expect(gregorianJulianDay('1500-01-01T00:00:00Z')).toBe(2_268_923.5);
  });
});

/** Strip the single quotes a Horizons query parameter is wrapped in. */
function unquote(value: string | null): string {
  return (value ?? '').replace(/^'|'$/g, '');
}

const HORIZONS_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Render an instant the way the OBSERVER table writes its calendar-date column, fractional
 * seconds included — Horizons echoes a START_TIME's fraction on every row it prints.
 */
function horizonsDateColumn(t: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fraction = `${String(t.getUTCMilliseconds()).padStart(3, '0')}0`;
  return `${t.getUTCFullYear()}-${HORIZONS_MONTHS[t.getUTCMonth()]}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}.${fraction}`;
}

/**
 * The instants Horizons prints for a request, generated from that request's own
 * START_TIME. The first instant is START_TIME itself, because Horizons' start is
 * inclusive of the first output row — the property that makes an inclusive resume
 * instant repeat a sample. Calendar steps here stay on a day-of-month every month
 * carries; the skip rule for the 29th through 31st is exercised on its own below.
 */
function seriesInstants(startIso: string, step: string, count: number): Date[] {
  const parsed = /^(\d+) ?(mo|[mhdy])$/i.exec(step);
  if (!parsed) throw new Error(`Fixture cannot generate a series for step "${step}".`);
  const size = Number(parsed[1]);
  const unit = String(parsed[2]).toLowerCase();
  const t0 = new Date(startIso);
  return Array.from({ length: count }, (_unused, k) => {
    const t = new Date(t0.getTime());
    if (unit === 'm') t.setUTCMinutes(t.getUTCMinutes() + size * k);
    else if (unit === 'h') t.setUTCHours(t.getUTCHours() + size * k);
    else if (unit === 'd') t.setUTCDate(t.getUTCDate() + size * k);
    else if (unit === 'mo') t.setUTCMonth(t.getUTCMonth() + size * k);
    else t.setUTCFullYear(t.getUTCFullYear() + size * k);
    // A calendar step keeps the day of the month; a fixture that silently rolled off it
    // would be generating a series Horizons never prints. Fixed-duration steps walk the
    // calendar freely and are exempt.
    if ((unit === 'mo' || unit === 'y') && t.getUTCDate() !== t0.getUTCDate()) {
      throw new Error(`Fixture step "${step}" rolled off day ${t0.getUTCDate()}.`);
    }
    return t;
  });
}

/**
 * A `fetch` stub that answers each request with a block generated from that request's
 * own START_TIME and STEP_SIZE. A canned body cannot express paging, and paging is the
 * whole question here: what the second call returns for the `start` the first advertised.
 */
function stubPagedHorizons(rowsPerPage: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const params = paramsOf(url);
      const rows = seriesInstants(
        unquote(params.get('START_TIME')),
        unquote(params.get('STEP_SIZE')),
        rowsPerPage,
      ).map((t) => `${horizonsDateColumn(t)}, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0`);
      return new Response(horizonsGeocentric(rows), { status: 200 });
    }),
  );
}

/** Days in a month (0-based), proleptic Gregorian. */
function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The rows Horizons prints for a request, through STOP_TIME inclusive, at most `limit` of
 * them. Written from Horizons' observed output rather than from the tool's arithmetic, so
 * the tool is checked against Horizons and not against itself:
 *
 * - m / h / d steps are fixed durations.
 * - mo / y steps advance the month or year field by the step count from the previous row.
 *   When that period has no such day of the month, Horizons moves on one month or year at
 *   a time until one does, and the series continues from the row it printed. Captured live:
 *   5mo from 2026-01-31 prints Jul 31, Dec 31, May 31 …, and 3y from 2024-02-29 prints a
 *   leap day every four years (`HORIZONS_5MO_FROM_JAN_31`, `HORIZONS_3Y_FROM_FEB_29`).
 */
function horizonsRowInstants(
  startIso: string,
  step: string,
  stopIso: string,
  limit: number,
): Date[] {
  const parsed = /^(\d+) ?(mo|[mhdy])$/i.exec(step);
  if (!parsed) throw new Error(`Fixture cannot generate a series for step "${step}".`);
  const size = Number(parsed[1]);
  const unit = String(parsed[2]).toLowerCase();
  const stop = new Date(stopIso).getTime();
  const fixedMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as 'm' | 'h' | 'd'];
  const rows: Date[] = [];
  let t = new Date(startIso);
  while (rows.length < limit && t.getTime() <= stop) {
    rows.push(t);
    if (fixedMs !== undefined) {
      t = new Date(t.getTime() + size * fixedMs);
      continue;
    }
    const day = t.getUTCDate();
    let year = t.getUTCFullYear();
    let month = t.getUTCMonth();
    if (unit === 'mo') month += size;
    else year += size;
    while (day > daysInUtcMonth(year + Math.floor(month / 12), month % 12)) {
      if (unit === 'mo') month += 1;
      else year += 1;
    }
    const next = new Date(t.getTime());
    next.setUTCFullYear(year + Math.floor(month / 12), month % 12, day);
    t = next;
  }
  // An advance past the representable range is NaN, which fails `<= stop` and ends the series.
  return rows;
}

/** Horizons' row-count ceiling, from its refusal "Projected output length (~N) exceeds 90024". */
const HORIZONS_PROJECTED_ROW_LIMIT = 90_024;

/**
 * A `fetch` stub that answers like Horizons does for the request it receives: the rows from
 * START_TIME through STOP_TIME, or — when STOP_TIME is not after START_TIME, or the span
 * projects more rows than Horizons will print — its refusal line with no ephemeris block.
 * `dropRowAt` writes that row (0-based)
 * in a layout the parse cannot read; `boundAfter` makes the stub answer a STOP_TIME past
 * that instant with Horizons' out-of-span line, the way a target's data bound refuses;
 * `appendStopRow` closes the block with one more row at STOP_TIME whenever the series
 * ends before it, the off-series row Horizons prints to close some year-step spans.
 */
function stubHorizonsSeries(
  options: {
    appendStopRow?: boolean;
    boundAfter?: { iso: string; line: string };
    dropRowAt?: number;
  } = {},
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string | URL) => {
    const params = paramsOf(url);
    const start = unquote(params.get('START_TIME'));
    const stop = unquote(params.get('STOP_TIME'));
    if (new Date(stop) <= new Date(start)) {
      return new Response('API VERSION: 1.2\n\nBad dates -- start must be earlier than stop\n', {
        status: 200,
      });
    }
    if (options.boundAfter && new Date(stop) > new Date(options.boundAfter.iso)) {
      return new Response(horizonsOutOfSpan(options.boundAfter.line), { status: 200 });
    }
    const instants = horizonsRowInstants(
      start,
      unquote(params.get('STEP_SIZE')),
      stop,
      HORIZONS_PROJECTED_ROW_LIMIT + 1,
    );
    if (instants.length > HORIZONS_PROJECTED_ROW_LIMIT) {
      return new Response(
        `API VERSION: 1.2\n\nProjected output length (~${instants.length}) exceeds ${HORIZONS_PROJECTED_ROW_LIMIT} -- change step-size\n`,
        { status: 200 },
      );
    }
    const last = instants.at(-1);
    if (options.appendStopRow && last !== undefined && last.getTime() < new Date(stop).getTime()) {
      instants.push(new Date(stop));
    }
    const rows = instants.map((t, i) =>
      i === options.dropRowAt
        ? `${horizonsDateColumn(t)}, , , 45.000000, 12.500000`
        : `${horizonsDateColumn(t)}, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0`,
    );
    return new Response(horizonsGeocentric(rows), { status: 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The STOP_TIME of the n-th request (0-based) a stubbed `fetch` received, unquoted. */
function sentStopTime(spy: ReturnType<typeof vi.fn>, call = 0): string {
  return unquote(paramsOf(spy.mock.calls[call]?.[0]).get('STOP_TIME'));
}

/**
 * Rows Horizons printed for `COMMAND='10'`, `STEP_SIZE='5mo'`, 2026-01-31 → 2160-01-31: the
 * first fifteen, then row 201 and the last of the 313 rows. Each row after a month with no
 * 31st is one month on from where the step landed, not a whole step on.
 */
const HORIZONS_5MO_FROM_JAN_31 = {
  first15: [
    '2026-01-31',
    '2026-07-31',
    '2026-12-31',
    '2027-05-31',
    '2027-10-31',
    '2028-03-31',
    '2028-08-31',
    '2029-01-31',
    '2029-07-31',
    '2029-12-31',
    '2030-05-31',
    '2030-10-31',
    '2031-03-31',
    '2031-08-31',
    '2032-01-31',
  ],
  row201: '2111-10-31',
  last: '2159-10-31',
  count: 313,
};

/**
 * Rows Horizons printed for `COMMAND='10'`, `STEP_SIZE='3y'` from 2024-02-29: a leap day every
 * four years, 2028 following 2024 rather than the whole step to 2036.
 */
const HORIZONS_3Y_FROM_FEB_29 = Array.from({ length: 19 }, (_unused, k) => `${2024 + 4 * k}-02-29`);

/** The instant a truncation notice tells the caller to pass back as `start`. */
function advertisedResumeInstant(notice: string | undefined): string {
  const match = /start set to (\S+)/.exec(notice ?? '');
  if (!match?.[1]) throw new Error(`No resume instant in notice: ${notice}`);
  return match[1];
}

/** Run one page and hand back its instants, its merged surface, and its advertised start. */
async function fetchEphemerisPage(start: string, step: string) {
  const ctx = createMockContext({ errors: getEphemerisTool.errors });
  const input = getEphemerisTool.input.parse({ designation: '433;', start, step });
  const result = await getEphemerisTool.handler(input, ctx);
  const merged = mergedEphemerisOutput(result, ctx);
  return {
    times: result.points.map((p) => p.time_utc),
    merged,
    resumeFrom: advertisedResumeInstant(merged.notice),
  };
}

describe('astronomy_get_ephemeris — the advertised resume instant continues the series', () => {
  it('concatenates two pages of a fixed-duration step with no repeated instant and no gap', async () => {
    // 250 rows per page, so each call truncates at the 200-row cap and advertises a
    // continuation — the exact situation in which a caller pages.
    stubPagedHorizons(250);
    const start = '2026-08-20T00:00:00.000Z';

    const first = await fetchEphemerisPage(start, '10m');
    expect(first.merged).toMatchObject({ truncated: true, shown: 200, cap: 200 });
    expect(first.times[0]).toBe(start);

    const second = await fetchEphemerisPage(first.resumeFrom, '10m');
    expect(second.times).toHaveLength(200);
    // The defect: the advertised `start` was the last row already returned, and
    // Horizons' START_TIME is inclusive, so the continuation repeated it.
    expect(second.times[0]).not.toBe(first.times.at(-1));

    const joined = [...first.times, ...second.times];
    expect(new Set(joined).size).toBe(joined.length);
    // No duplicate is only half the contract: an over-advanced resume instant would
    // also deduplicate, while silently dropping the sample in between. Every adjacent
    // pair has to be exactly one step apart, across the seam included.
    const gaps = joined
      .slice(1)
      .map((t, i) => new Date(t).getTime() - new Date(String(joined[i])).getTime());
    expect([...new Set(gaps)]).toEqual([10 * 60_000]);
  });

  it('concatenates two pages of a calendar step with no repeated instant and no gap', async () => {
    // A month is not a fixed duration, so the same seam has to be checked as a calendar
    // relationship: same day-of-month, exactly one month on.
    stubPagedHorizons(250);
    const start = '2026-01-15T00:00:00.000Z';

    const first = await fetchEphemerisPage(start, '1mo');
    expect(first.merged).toMatchObject({ truncated: true, shown: 200, cap: 200 });
    const second = await fetchEphemerisPage(first.resumeFrom, '1mo');
    expect(second.times[0]).not.toBe(first.times.at(-1));

    const joined = [...first.times, ...second.times];
    expect(new Set(joined).size).toBe(joined.length);
    for (let i = 1; i < joined.length; i++) {
      const prev = new Date(String(joined[i - 1]));
      const next = new Date(String(joined[i]));
      expect(next.getUTCDate()).toBe(prev.getUTCDate());
      const monthsApart =
        (next.getUTCFullYear() - prev.getUTCFullYear()) * 12 +
        (next.getUTCMonth() - prev.getUTCMonth());
      expect(monthsApart).toBe(1);
    }
  });

  it.each(['10m', '3h', '1d', '1mo', '1y'])(
    'names an instant strictly after the last row returned for step "%s"',
    async (step) => {
      // Every unit the step grammar accepts, so no one unit can regress to the
      // inclusive instant while the others stay fixed.
      stubPagedHorizons(250);
      const page = await fetchEphemerisPage('2026-01-15T00:00:00.000Z', step);
      expect(page.merged.truncated).toBe(true);
      const lastReturned = String(page.times.at(-1));
      expect(page.resumeFrom).not.toBe(lastReturned);
      expect(new Date(page.resumeFrom).getTime()).toBeGreaterThan(new Date(lastReturned).getTime());
    },
  );

  it('advances a month step to the next month that has the day, the way Horizons steps', async () => {
    // JPL's calendar-stepping rule: "if a start date on the 31st is requested, output
    // will only occur for months having 31 days." February carries no 31st, so the
    // instant after 2026-01-31 at a 1mo step is 2026-03-31 — not the 2026-03-03 a plain
    // month-field increment rolls over to, which would shift every row of the
    // continuation off the series the caller asked for.
    const rows: string[] = [];
    for (let i = 0; i < 250; i++) {
      // Filler: only the 200th row, the last one the cap admits, is what the notice reads.
      const t = new Date(Date.UTC(2020, 0, 1) + i * 3_600_000);
      rows.push(`${horizonsDateColumn(t)}, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0`);
    }
    rows[199] = '2026-Jan-31 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0';
    stubFetch(horizonsGeocentric(rows));

    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2020-01-01T00:00:00Z',
      step: '1mo',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    const merged = mergedEphemerisOutput(result, ctx);

    expect(result.points.at(-1)?.time_utc).toBe('2026-01-31T00:00:00.000Z');
    expect(advertisedResumeInstant(merged.notice)).toBe('2026-03-31T00:00:00.000Z');
  });

  it('advances a year step to the next year that has the day, the way Horizons steps', async () => {
    // The same rule on the coarse unit: a Feb-29 start yields output "only for Feb 29
    // calendar days in those leap years having 29 days in February," so the instant
    // after 2028-02-29 at a 1y step is 2032-02-29, not 2029-03-01.
    const rows: string[] = [];
    for (let i = 0; i < 250; i++) {
      const t = new Date(Date.UTC(2020, 0, 1) + i * 3_600_000);
      rows.push(`${horizonsDateColumn(t)}, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0`);
    }
    rows[199] = '2028-Feb-29 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0';
    stubFetch(horizonsGeocentric(rows));

    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2020-01-01T00:00:00Z',
      step: '1y',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    const merged = mergedEphemerisOutput(result, ctx);

    expect(result.points.at(-1)?.time_utc).toBe('2028-02-29T00:00:00.000Z');
    expect(advertisedResumeInstant(merged.notice)).toBe('2032-02-29T00:00:00.000Z');
  });

  const isoDay = (day: string) => `${day}T00:00:00.000Z`;

  it('generates the rows Horizons printed for multi-count calendar steps', () => {
    // Pins the fixture rule to live output, so the tests below compare the tool with Horizons.
    const fiveMonth = horizonsRowInstants(
      '2026-01-31T00:00:00.000Z',
      '5mo',
      '2160-01-31T00:00:00.000Z',
      1000,
    ).map((t) => t.toISOString());
    expect(fiveMonth).toHaveLength(HORIZONS_5MO_FROM_JAN_31.count);
    expect(fiveMonth.slice(0, 15)).toEqual(HORIZONS_5MO_FROM_JAN_31.first15.map(isoDay));
    expect(fiveMonth[200]).toBe(isoDay(HORIZONS_5MO_FROM_JAN_31.row201));
    expect(fiveMonth.at(-1)).toBe(isoDay(HORIZONS_5MO_FROM_JAN_31.last));

    const threeYear = horizonsRowInstants(
      '2024-02-29T00:00:00.000Z',
      '3y',
      '2096-02-29T00:00:00.000Z',
      1000,
    ).map((t) => t.toISOString());
    expect(threeYear).toEqual(HORIZONS_3Y_FROM_FEB_29.map(isoDay));
  });

  it('keeps the fractional seconds Horizons prints in time_utc and in the resume start', async () => {
    // Horizons echoes START_TIME's fraction on every row ("2026-Jan-01 00:00:30.500"), so
    // time_utc carries it, and the resume start keeps page 2 on the caller's sub-second grid.
    stubHorizonsSeries();
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2026-01-01T00:00:30.500Z',
      stop: '2026-01-02T00:00:00Z',
      step: '1m',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    const merged = mergedEphemerisOutput(result, ctx);
    expect(result.points[0]?.time_utc).toBe('2026-01-01T00:00:30.500Z');
    expect(result.points.at(-1)?.time_utc).toBe('2026-01-01T03:19:30.500Z');
    expect(advertisedResumeInstant(merged.notice)).toBe('2026-01-01T03:20:30.500Z');
    const block = getEphemerisTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('- 2026-01-01T00:00:30.500Z:');
  });

  it.each([
    // Transcribed from a live 3 h request whose START_TIME carried .500.
    [
      ' 2026-Jan-01 00:00:30.500, , ,  20.290840843,  31.548456026,   10.251,  3.801,  0.41587723378933,  1.6133501,',
      '2026-01-01T00:00:30.500Z',
    ],
    // A fraction finer than a millisecond rounds, carrying into the next day when it must.
    [
      '2026-Jan-01 23:59:59.9996, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
      '2026-01-02T00:00:00.000Z',
    ],
  ])('reads the row %j as %s', async (row, expected) => {
    stubFetch(horizonsGeocentric([row]));
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;' });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result.points.map((p) => p.time_utc)).toEqual([expected]);
  });
});

describe('astronomy_get_ephemeris — the request asks Horizons for one page', () => {
  /**
   * STOP_TIME is the 201st instant of the series — one row past the page, which is what
   * marks the page truncated — or the requested stop when that comes first. Horizons
   * refuses a span projecting past its row ceiling outright, with no ephemeris block, so
   * the whole span is never requested.
   */

  /** Run one page of `433;` at `step` through `stop`, returning its surface and resume start. */
  async function pageThrough(start: string, stop: string, step: string) {
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', start, stop, step });
    const result = await getEphemerisTool.handler(input, ctx);
    const merged = mergedEphemerisOutput(result, ctx);
    return {
      times: result.points.map((p) => p.time_utc),
      merged,
      resume: merged.truncated ? advertisedResumeInstant(merged.notice) : undefined,
    };
  }

  it.each([
    // A year of one-minute rows: past Horizons' row ceiling if requested whole.
    ['1m', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['10m', '2026-08-20T00:00:00.000Z', '2026-08-25T00:00:00.000Z'],
    ['3 h', '2026-01-01T00:00:30.500Z', '2026-03-02T00:00:00.000Z'],
    ['1d', '2026-01-01T00:00:00.000Z', '2027-06-01T00:00:00.000Z'],
    ['1mo', '2026-01-31T00:00:00.000Z', '2060-01-31T00:00:00.000Z'],
    ['1y', '2024-02-29T00:00:00.000Z', '2900-03-01T00:00:00.000Z'],
    ['5mo', '2026-01-31T00:00:00.000Z', '2160-01-31T00:00:00.000Z'],
    ['3y', '2024-02-29T00:00:00.000Z', '3000-01-01T00:00:00.000Z'],
  ])(
    'asks for exactly one row past the page at step "%s", returning the page the whole span would',
    async (step, start, stop) => {
      const spy = stubHorizonsSeries();
      const page = await pageThrough(start, stop, step);
      // The whole span's rows, as Horizons prints them without a bound on STOP_TIME.
      const unbounded = horizonsRowInstants(start, step, stop, 201).map((t) => t.toISOString());
      expect(sentStopTime(spy)).toBe(unbounded[200]);
      expect(page.times).toEqual(unbounded.slice(0, 200));
      expect(page.merged.truncated).toBe(true);
      expect(page.resume).toBe(unbounded[200]);
    },
  );

  it.each([
    // The 201st instant itself: nothing past it was asked for.
    ['the 201st instant', '1m', '2026-01-01T03:20:00Z', '2026-01-01T03:20:00.000Z'],
    // A 25-row span.
    ['a 25-row span', '1h', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00.000Z'],
  ])(
    'sends a stop at or before the 201st instant unchanged: %s',
    async (_label, step, stop, sent) => {
      const spy = stubHorizonsSeries();
      const ctx = createMockContext({ errors: getEphemerisTool.errors });
      const input = getEphemerisTool.input.parse({
        designation: '433;',
        start: '2026-01-01T00:00:00Z',
        stop,
        step,
      });
      await getEphemerisTool.handler(input, ctx);
      expect(sentStopTime(spy)).toBe(sent);
    },
  );

  // 2147483647d is the largest count Horizons reads, and its first advance leaves the Date range.
  it.each(['2147483647d', '999999y', '999999mo'])(
    'sends the requested stop for a step "%s" whose first advance passes it or leaves the date range',
    async (step) => {
      const spy = stubHorizonsSeries();
      const result = await runToolContract(getEphemerisTool, {
        designation: '433;',
        start: '2026-01-01T00:00:00Z',
        stop: '2026-01-02T00:00:00Z',
        step,
      });
      expect(result.isError).toBeFalsy();
      expect(sentStopTime(spy)).toBe('2026-01-02T00:00:00.000Z');
      const structured = result.structuredContent as { points: unknown[]; truncated: boolean };
      expect(structured.points).toHaveLength(1);
      expect(structured.truncated).toBe(false);
    },
  );

  it('still reports a page that dropped a row as truncated while the span continues', async () => {
    // With STOP_TIME one row past the page, a dropped row leaves 200 points and no row past
    // them for the parse to see. One step past the last point is still inside the requested
    // span, so the page is truncated all the same, and the resume start is that step.
    const spy = stubHorizonsSeries({ dropRowAt: 50 });
    const page = await pageThrough('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z', '1m');
    expect(sentStopTime(spy)).toBe('2026-01-01T03:20:00.000Z');
    expect(page.merged).toMatchObject({ truncated: true, shown: 200, dropped: 1 });
    expect(page.times.at(-1)).toBe('2026-01-01T03:20:00.000Z');
    expect(page.resume).toBe('2026-01-01T03:21:00.000Z');
    expect(page.merged.notice).toMatch(/Dropped 1 of the rows/);
  });

  it('ends at the requested stop when the page that dropped a row reaches it', async () => {
    // 201 rows asked for and exactly 201 in the span: one dropped leaves 200 points and the
    // series complete, so the notice carries the dropped-row caveat and no continuation.
    stubHorizonsSeries({ dropRowAt: 50 });
    const page = await pageThrough('2026-01-01T00:00:00Z', '2026-01-01T03:20:00Z', '1m');
    expect(page.merged).toMatchObject({ truncated: false, shown: 200, dropped: 1 });
    expect(page.merged.notice).toMatch(/^Dropped 1 of the rows/);
  });

  it('returns the pages inside a target’s data bound and fails on the page that crosses it', async () => {
    // Mars' data ends at 2599-12-31 23:58:50 UT. A stop past it reaches that bound only on
    // the page whose 201 rows cross it; every page before that one comes back.
    const spy = stubHorizonsSeries({
      boundAfter: { iso: '2599-12-31T23:58:50.816Z', line: MARS_AFTER_SPAN },
    });
    const span = { designation: '499', stop: '2601-01-01T00:00:00Z', step: '1d' };
    const ctx1 = createMockContext({ errors: getEphemerisTool.errors });
    const first = await getEphemerisTool.handler(
      getEphemerisTool.input.parse({ ...span, start: '2599-06-01T00:00:00Z' }),
      ctx1,
    );
    const merged = mergedEphemerisOutput(first, ctx1);
    expect(first.points).toHaveLength(200);
    expect(merged.truncated).toBe(true);
    const resume = advertisedResumeInstant(merged.notice);
    expect(resume).toBe('2599-12-18T00:00:00.000Z');

    const ctx2 = createMockContext({ errors: getEphemerisTool.errors });
    const err = await captureRejected(() =>
      getEphemerisTool.handler(getEphemerisTool.input.parse({ ...span, start: resume }), ctx2),
    );
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(err?.message).toBe(
      'Horizons has no ephemeris for Mars after A.D. 2599-DEC-31 23:58:50.8164 UT.',
    );
    expect(sentStopTime(spy, 1)).toBe('2600-07-06T00:00:00.000Z');
  });

  it('describes truncated as the span continuing past the returned rows', () => {
    expect(getEphemerisTool.enrichment?.truncated.description).toContain(
      'the requested span continues past the returned rows',
    );
  });

  it.each([
    // The 201st row is the requested stop, so the resume start is the stop itself.
    ['201', '2026-01-01T03:20:00Z', ['2026-01-01T03:20:00.000Z']],
    ['202', '2026-01-01T03:21:00Z', ['2026-01-01T03:20:00.000Z', '2026-01-01T03:21:00.000Z']],
  ])(
    'fetches the rows a %s-row span leaves past page 1, from the advertised resume start',
    async (_rows, stop, rest) => {
      stubHorizonsSeries();
      const first = await pageThrough('2026-01-01T00:00:00Z', stop, '1m');
      expect(first.times).toHaveLength(200);
      expect(first.resume).toBe('2026-01-01T03:20:00.000Z');
      const second = await pageThrough(String(first.resume), stop, '1m');
      expect(second.times).toEqual(rest);
      expect(second.merged.truncated).toBe(false);
    },
  );

  it('fetches the stop row a 202-row span leaves when a dropped row ends page 1 one row late', async () => {
    // Bounded at the 201st instant, a dropped row leaves page 1 ending on that instant, so
    // the resume start is the 202nd — the requested stop.
    stubHorizonsSeries({ dropRowAt: 10 });
    const stop = '2026-01-01T03:21:00Z';
    const first = await pageThrough('2026-01-01T00:00:00Z', stop, '1m');
    expect(first.merged).toMatchObject({ truncated: true, shown: 200, dropped: 1 });
    expect(first.resume).toBe('2026-01-01T03:21:00.000Z');
    const second = await pageThrough(String(first.resume), stop, '1m');
    expect(second.times).toEqual(['2026-01-01T03:21:00.000Z']);
  });

  it('resumes at the stop when Horizons closes a year series with a row at STOP_TIME', async () => {
    // At a year step Horizons appends one row at STOP_TIME when the next on-series instant
    // falls past it, e.g. 2900-Mar-01 after 2896-Feb-29. When that is the 201st row, one step
    // past the 200th lies beyond stop, so the continuation is the stop instant itself.
    const onSeries = horizonsRowInstants(
      '2024-02-29T00:00:00.000Z',
      '1y',
      '9999-01-01T00:00:00.000Z',
      200,
    );
    const lastLeapDay = onSeries.at(-1)!;
    // March 1 of the following year: past the 200th row, before the next leap day.
    const stop = `${lastLeapDay.getUTCFullYear() + 1}-03-01T00:00:00.000Z`;
    const spy = stubHorizonsSeries({ appendStopRow: true });
    const first = await pageThrough('2024-02-29T00:00:00Z', stop, '1y');
    expect(first.times).toHaveLength(200);
    expect(first.times.at(-1)).toBe(lastLeapDay.toISOString());
    expect(first.merged.truncated).toBe(true);
    expect(first.resume).toBe(stop);

    // The advertised continuation, end to end. It asks for the single instant at the stop,
    // sent as a 1 ms window; a stub that also closes that window with a row at STOP_TIME
    // must still yield exactly the one row the first page left out.
    const second = await pageThrough(String(first.resume), stop, '1y');
    expect(sentStopTime(spy, 1)).toBe(new Date(Date.parse(stop) + 1).toISOString());
    expect(second.times).toEqual([stop]);
    expect(second.merged).toMatchObject({ truncated: false, shown: 1 });
  });

  it.each(['1h', '1mo', '1y'])(
    'answers a stop equal to start at step "%s" with the one row at that instant',
    async (step) => {
      /**
       * Horizons refuses START_TIME equal to STOP_TIME, so the request closes one millisecond
       * later. The stub also closes that window with a row at STOP_TIME, the row Horizons
       * appends to some year-step spans, so only the row at start may come back. Probed live
       * on year and month steps (COMMAND='10', 2101-03-01 and 2096-02-29 with a 1 ms window),
       * Horizons printed the start row alone.
       */
      const spy = stubHorizonsSeries({ appendStopRow: true });
      const page = await pageThrough('2101-03-01T00:00:00Z', '2101-03-01T00:00:00Z', step);
      expect(sentStopTime(spy)).toBe('2101-03-01T00:00:00.001Z');
      expect(page.times).toEqual(['2101-03-01T00:00:00.000Z']);
      expect(page.merged).toMatchObject({ truncated: false, shown: 1, cap: 200 });
      expect(page.merged.notice).toBeUndefined();
    },
  );
});

describe('astronomy_get_ephemeris — unusable rows', () => {
  /**
   * A row Horizons returns without a distance is not an ephemeris point. It used to be
   * kept with `distance_au: NaN`, which the output schema rejects — so one such row
   * failed the whole call with a serialization error and threw away every row that had
   * parsed. The parse now discards it the way it already discards a row with no date or
   * no RA/Dec, and the surrounding rows survive.
   */
  const GOOD_ROW_00 =
    '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0';
  const GOOD_ROW_02 =
    '2024-Jan-01 02:00:00.0000, , , 45.200000, 12.540000, 9.52, 5.0, 1.502000, 0.0';

  it.each([
    // Horizons' own layout is fixed-width per requested QUANTITIES, so a row narrower
    // than the requested layout means the response and the parser disagree.
    [
      'a row shorter than the requested layout',
      '2024-Jan-01 01:00:00.0000, , , 45.100000, 12.520000',
    ],
    // "n.a." is what Horizons writes for a quantity it cannot supply for a target.
    [
      'a distance column of "n.a."',
      '2024-Jan-01 01:00:00.0000, , , 45.100000, 12.520000, 9.51, 5.0, n.a., 0.0',
    ],
    // Any column that is neither a number nor "n.a." is equally unusable — parseFloat
    // answers NaN, which reached ra_hours through the same gap that delta reached
    // distance_au.
    [
      'a position column that is neither a number nor "n.a."',
      '2024-Jan-01 01:00:00.0000, , , ***, 12.520000, 9.51, 5.0, 1.501000, 0.0',
    ],
  ])('drops %s and keeps the rows that parsed', async (_label, badRow) => {
    stubFetch(horizonsGeocentric([GOOD_ROW_00, badRow, GOOD_ROW_02]));
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2024-01-01T00:00:00Z',
      stop: '2024-01-01T03:00:00Z',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    // The point that could not be built is gone; nothing schema-invalid ships in its place.
    expect(result).toEqual(expect.schemaMatching(getEphemerisTool.output));
    expect(result.points).toHaveLength(2);
    expect(result.points.map((p) => p.time_utc)).toEqual([
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T02:00:00.000Z',
    ]);
    for (const p of result.points) {
      expect(Number.isFinite(p.distance_au)).toBe(true);
      expect(Number.isFinite(p.ra_hours)).toBe(true);
      expect(Number.isFinite(p.dec_degrees)).toBe(true);
    }
  });

  it('discloses the dropped-row count and the resulting gap on the merged client surface', async () => {
    // A shorter-than-requested series that says nothing reads as a complete answer, so
    // the count and the reason both have to reach the client — on both surfaces, which
    // is what the enrichment merge gives.
    stubFetch(
      horizonsGeocentric([
        GOOD_ROW_00,
        '2024-Jan-01 01:00:00.0000, , , 45.100000, 12.520000',
        GOOD_ROW_02,
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    const merged = mergedEphemerisOutput(result, ctx);
    expect(merged).toMatchObject({ truncated: false, shown: 2, cap: 200, dropped: 1 });
    expect(merged.notice).toMatch(/Dropped 1 of the rows/);
    expect(merged.notice).toMatch(/shorter than the requested step count/i);
  });

  it('omits dropped entirely, with no notice, when every row parsed', async () => {
    // Horizons pads rather than shortens, so a clean parse is the overwhelmingly common
    // case; a `dropped: 0` on every healthy call would be noise on both client surfaces.
    // Absence is the "nothing was dropped" signal, so the healthy response is byte-for-
    // byte what it was before the discard path existed.
    stubFetch(horizonsGeocentric([GOOD_ROW_00, GOOD_ROW_02]));
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    const merged = mergedEphemerisOutput(result, ctx);
    expect(merged).toMatchObject({ truncated: false, shown: 2, cap: 200 });
    expect(merged.notice).toBeUndefined();
    expect('dropped' in merged).toBe(false);
    expect('dropped' in getEnrichment(ctx)).toBe(false);
  });

  it('keeps a row whose magnitude column is unparseable, reporting the magnitude as null', async () => {
    // Magnitude is already nullable for Horizons' own "n.a.", so an unusable magnitude
    // token is a hole in an optional field, not a reason to discard a row that carries
    // a real position and distance — and never a reason to fail the whole call.
    stubFetch(
      horizonsGeocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, ***, 5.0, 1.500000, 0.0',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;' });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(getEphemerisTool.output));
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.magnitude).toBeNull();
    expect(result.points[0]?.distance_au).toBeCloseTo(1.5, 5);
    expect('dropped' in getEnrichment(ctx)).toBe(false);
  });

  it('carries both the retrieval loop and the dropped-row caveat in one notice when truncated', async () => {
    // `notice` is last-wins across enrichment writers, so the two caveats have to be
    // composed into a single string or the truncation guidance silently erases the
    // dropped-row disclosure (or the reverse). The counts have to stay mutually
    // consistent too: `shown` is the cap, `dropped` counts only the rows the cap let
    // the parse reach, and the two together are the number of rows examined.
    const rows: string[] = [];
    for (let i = 0; i < 250; i++) {
      const hh = String(i % 24).padStart(2, '0');
      rows.push(`2024-Jan-01 ${hh}:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0`);
    }
    rows.splice(5, 0, '2024-Jan-01 05:30:00.0000, , , 45.000000, 12.500000');
    stubFetch(horizonsGeocentric(rows));
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2024-01-01T00:00:00Z',
      step: '10m',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    const merged = mergedEphemerisOutput(result, ctx);
    expect(merged).toMatchObject({ truncated: true, shown: 200, cap: 200, dropped: 1 });
    expect(result.points).toHaveLength(merged.shown);
    expect(merged.notice).toMatch(/same step/i);
    expect(merged.notice).toMatch(/dropped/i);
  });

  it('fails horizons_unavailable when no row carries a distance, not a serialization error', async () => {
    // The whole-response failure the caller sees must be the tool's own declared
    // contract with an actionable hint, not a -32007 from a sentinel that escaped
    // the parser.
    stubFetch(
      horizonsGeocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000',
        '2024-Jan-01 01:00:00.0000, , , 45.100000, 12.520000',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err).toBeInstanceOf(McpError);
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err?.data?.reason).toBe('horizons_unavailable');
    expect(err?.data?.recovery?.hint).toMatch(/distance/i);
  });

  it('keeps a topocentric row whose az/el is "n.a." — the distance is what makes it a point', async () => {
    // Horizons pads a quantity it cannot supply with "n.a." rather than dropping the
    // column, so az/el can be absent on a row that still carries a real position and
    // distance. Alt/az is optional output; the row is not.
    stubFetch(
      horizonsTopocentric([
        '2024-Jan-01 00:00:00.0000,*,m, 45.000000, 12.500000, n.a., n.a., 9.50, 5.0, 1.500000, 0.0',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', ...SEATTLE });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.distance_au).toBeCloseTo(1.5, 5);
    expect(result.points[0]?.altitude_degrees).toBeUndefined();
    expect(result.points[0]?.azimuth_degrees).toBeUndefined();
    expect('dropped' in mergedEphemerisOutput(result, ctx)).toBe(false);
  });
});

describe('astronomy_get_ephemeris — error contracts', () => {
  it('fails body_not_found when Horizons reports no match', async () => {
    stubFetch('No matches found for the requested object.');
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: 'ZZZ Nonexistent' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('body_not_found');
    expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('fails horizons_unavailable when the response has no ephemeris block', async () => {
    stubFetch('Garbled response with no SOE marker and nothing parseable.');
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433 Eros' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('horizons_unavailable');
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('fails horizons_unavailable when the block has no parsable rows', async () => {
    // A $$SOE/$$EOE block whose only line is too short to parse.
    stubFetch(horizonsGeocentric(['x, y']));
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433 Eros' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('horizons_unavailable');
  });

  it('maps a Horizons HTTP failure to horizons_unavailable without leaking HTTP internals', async () => {
    // fetchWithTimeout throws a status-mapped McpError whose data carries statusCode and
    // the raw body, and whose message names the upstream host. The service catches it and
    // re-throws the typed contract with leak-free data — the framework error rides only
    // as `cause` (server-side logs), never reaching the client surface.
    stubFetchThrowsUpstream();
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err?.data).toEqual({
      reason: 'horizons_unavailable',
      recovery: { hint: expect.stringContaining('retry') },
    });
    expectNoUpstreamLeak(err?.data);
  });

  it('maps a Horizons fetch timeout to horizons_unavailable, not the framework Timeout code', async () => {
    stubFetchThrowsTimeout();
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err?.data).toEqual({
      reason: 'horizons_unavailable',
      recovery: { hint: expect.stringContaining('retry') },
    });
    expectNoUpstreamLeak(err?.data);
  });

  it('rejects an empty designation at schema validation', () => {
    expect(() => getEphemerisTool.input.parse({ designation: '' })).toThrow();
  });

  it('rejects an unparseable start with invalid_time before reaching Horizons', async () => {
    // new Date('not-a-date').toISOString() throws RangeError: Invalid time value, which the
    // framework maps to a generic SerializationError. The guard must surface a clean
    // InvalidParams/invalid_time and never touch the network.
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', start: 'not-a-date' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_time');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an unparseable stop with invalid_time', async () => {
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2024-01-01T00:00:00Z',
      stop: 'not-a-date',
    });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_time');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a latitude without a longitude with incomplete_observer', async () => {
    // A lone coordinate used to fall through to a geocentric query: the observer the
    // caller supplied was dropped along with the alt/az columns it would have produced,
    // and the call still reported success.
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runToolContract(getEphemerisTool, {
      designation: '433;',
      latitude: SEATTLE.latitude,
    });
    const err = errorEnvelope(result);
    expect(result.isError).toBe(true);
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('incomplete_observer');
    expect(err?.data?.recovery?.hint).toMatch(/latitude and longitude together/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a longitude without a latitude with incomplete_observer', async () => {
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      longitude: SEATTLE.longitude,
    });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('incomplete_observer');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a stop before start with invalid_time_range, not an upstream outage', async () => {
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2024-01-02T00:00:00Z',
      stop: '2024-01-01T00:00:00Z',
    });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_time_range');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a single instant at the last millisecond of 9999, which no request can close', async () => {
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '10',
      start: '9999-12-31T23:59:59.999Z',
      stop: '9999-12-31T23:59:59.999Z',
    });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('invalid_time');
    expect(err?.message).toBe(
      'start and stop "9999-12-31T23:59:59.999Z" leave no later instant in year 9999 to close the request, the last calendar year JPL Horizons reads.',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed step with invalid_step, not an upstream outage', async () => {
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', step: 'nonsense' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_step');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['0m', '1w', '10', 'm', '1 1h', '1.5h', '1om', '1 mo d'])(
    'rejects step "%s" with invalid_step',
    async (step) => {
      const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = createMockContext({ errors: getEphemerisTool.errors });
      const input = getEphemerisTool.input.parse({ designation: '433;', step });
      const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
      expect(err?.data?.reason).toBe('invalid_step');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  // Every unit Horizons accepts for a calendar step. `mo` and `y` are the coarse ones a
  // multi-year survey needs; rejecting them would force a day step and truncate at 200
  // rows instead of returning the requested baseline.
  it.each(['10m', '1h', '1d', '1 d', '30M', '1mo', '1 mo', '1y', '2Y'])(
    'accepts step "%s"',
    async (step) => {
      stubFetch(
        horizonsGeocentric([
          '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
        ]),
      );
      const ctx = createMockContext({ errors: getEphemerisTool.errors });
      const input = getEphemerisTool.input.parse({ designation: '433;', step });
      const result = await getEphemerisTool.handler(input, ctx);
      expect(result.points).toHaveLength(1);
    },
  );
});

/**
 * Horizons' answer to a record lookup whose START_TIME it cannot parse, transcribed from a
 * live `COMMAND='433;'` request carrying `START_TIME='2026-10-01T00:00:00-05:00'`: the
 * target header resolves, then the date is refused and no ephemeris block follows.
 */
const HORIZONS_BAD_DATE = [
  'API VERSION: 1.2',
  'API SOURCE: NASA/JPL Horizons API',
  '',
  '*******************************************************************************',
  'JPL/HORIZONS                 433 Eros (A898 PA)            2026-Sep-23 17:10:42',
  'Rec #:     433 (+COV) Soln.date: 2021-May-24_17:55:05   # obs: 9130 (1893-2021)',
  '*******************************************************************************',
  '',
  'Cannot interpret date. Type "?!" or try YYYY-MMM-DD {HH:MN} format.',
].join('\n');

/**
 * Horizons' answer to a designation its small-body index does not hold, transcribed from a
 * live `COMMAND='433 Eros'` request — the bare-name form the tool description warns about.
 */
const HORIZONS_NO_MATCH = [
  'API VERSION: 1.2',
  'API SOURCE: NASA/JPL Horizons API',
  '',
  '*******************************************************************************',
  'JPL/DASTCOM            Small-body Index Search Results     2026-Sep-23 17:10:45',
  '',
  ' Comet AND asteroid index search:',
  '',
  '    DES = 433 Eros;',
  '',
  ' Matching small-bodies: ',
  '    No matches found.',
  '*******************************************************************************',
].join('\n');

/** A one-row geocentric block under a header carrying Horizons' `Target body name:` line. */
function horizonsWithTarget(targetLine: string): string {
  return [
    'API VERSION: 1.2',
    '*******************************************************************************',
    targetLine,
    'Center body name: Earth (399)                     {source: DE441}',
    '*******************************************************************************',
    '$$SOE',
    ' 2026-Oct-01 00:00, , , 306.096000000, -23.719600000,   n.a.,   n.a.,  35.1721000000000, -1.2',
    '$$EOE',
  ].join('\n');
}

describe('astronomy_get_ephemeris — offset timestamps reach Horizons as instants', () => {
  it('sends the parsed UTC instants for an offset-bearing start and stop, not the raw strings', async () => {
    // Horizons cannot read a numeric UTC offset, so forwarding the caller's string made a
    // valid request fail. The offset only ever mattered for which instant it names.
    const fetchSpy = stubOneRow(false);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2026-10-01T00:00:00-05:00',
      stop: '2026-10-01T06:00:00-05:00',
      step: '1h',
    });
    await getEphemerisTool.handler(input, ctx);
    const params = paramsOf(fetchSpy.mock.calls[0]?.[0]);
    expect(params.get('START_TIME')).toBe("'2026-10-01T05:00:00.000Z'");
    expect(params.get('STOP_TIME')).toBe("'2026-10-01T11:00:00.000Z'");
  });

  it('sends a zoneless start and stop as the UTC instants they are read as', async () => {
    const fetchSpy = stubOneRow(false);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2026-10-01T00:00:00',
      stop: '2026-10-01 06:00:00',
    });
    await getEphemerisTool.handler(input, ctx);
    const params = paramsOf(fetchSpy.mock.calls[0]?.[0]);
    expect(params.get('START_TIME')).toBe("'2026-10-01T00:00:00.000Z'");
    expect(params.get('STOP_TIME')).toBe("'2026-10-01T06:00:00.000Z'");
  });

  it('sends an out-of-engine-span epoch as its instant, keeping Horizons’ wider range', async () => {
    const fetchSpy = stubOneRow(false);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '1850-01-01T00:00:00+02:00',
      stop: '1850-01-02T00:00:00Z',
    });
    await getEphemerisTool.handler(input, ctx);
    const params = paramsOf(fetchSpy.mock.calls[0]?.[0]);
    expect(params.get('START_TIME')).toBe("'1849-12-31T22:00:00.000Z'");
    expect(params.get('STOP_TIME')).toBe("'1850-01-02T00:00:00.000Z'");
  });

  it('does not report a refused date as body_not_found', async () => {
    // The recovery for body_not_found tells the caller to change a designation that is
    // valid; a date Horizons refuses is not a designation miss.
    stubFetch(HORIZONS_BAD_DATE);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.data?.reason).not.toBe('body_not_found');
    expect(err?.data?.reason).toBe('horizons_unavailable');
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('still reports a genuine small-body index miss as body_not_found', async () => {
    stubFetch(HORIZONS_NO_MATCH);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433 Eros' });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('body_not_found');
    expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err?.data?.recovery?.hint).toBe(
      declaredRecovery(getEphemerisTool.errors, 'body_not_found'),
    );
  });
});

/**
 * Horizons' answer to a request outside the target's data span: the target resolves, the
 * physical-data header prints, then one line names the bound and no ephemeris block
 * follows. `boundLine` is that last line as Horizons writes it.
 */
function horizonsOutOfSpan(boundLine: string): string {
  return [
    'API VERSION: 1.2',
    'API SOURCE: NASA/JPL Horizons API',
    '',
    '*******************************************************************************',
    ' Revised: July 31, 2013                  Mars                              499',
    '  Maximum Planetary IR (W/m^2)   470         315         390',
    '  Minimum Planetary IR (W/m^2)    30          30          30',
    '*******************************************************************************',
    '',
    boundLine,
  ].join('\n');
}

/** Live `COMMAND='499'`, `START_TIME='9990-01-01…'`: past the end of the Mars span. */
const MARS_AFTER_SPAN = 'No ephemeris for target "Mars" after A.D. 2599-DEC-31 23:58:50.8164 UT';
/** Live `COMMAND='-48'`, `START_TIME='1980-01-01…'`: before the telescope's launch. */
const HST_PRIOR_TO_SPAN =
  'No ephemeris for target "Hubble Space Telescope (spacecraft)" prior to A.D. 1990-APR-25 02:00:42.8861 UT';

/** Run the service's fetch + parse directly against a stubbed body, capturing the throw. */
async function serviceRejection(body: string) {
  stubFetch(body);
  const svc = new HorizonsService('https://example.test/horizons', 5000);
  const ctx = createMockContext({ errors: getEphemerisTool.errors });
  return captureRejected(() =>
    svc.ephemeris('499', '9990-01-01T00:00:00.000Z', '9990-01-02T00:00:00.000Z', '1d', ctx),
  );
}

describe('astronomy_get_ephemeris — a date outside the target’s Horizons span', () => {
  it.each([
    [
      MARS_AFTER_SPAN,
      'Horizons has no ephemeris for Mars after A.D. 2599-DEC-31 23:58:50.8164 UT.',
    ],
    [
      HST_PRIOR_TO_SPAN,
      'Horizons has no ephemeris for Hubble Space Telescope (spacecraft) prior to A.D. 1990-APR-25 02:00:42.8861 UT.',
    ],
  ])('parses %j as time_out_of_range carrying the bound', async (line, message) => {
    const err = await serviceRejection(horizonsOutOfSpan(line));
    expect(err).toBeInstanceOf(McpError);
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(err?.message).toBe(message);
    // The hint the service throws is the one the tool declares, word for word.
    expect(err?.data?.recovery?.hint).toBe(
      declaredRecovery(getEphemerisTool.errors, 'time_out_of_range'),
    );
  });

  it('carries the reason, the bound, and the hint to structuredContent and content[] alike', async () => {
    stubFetch(horizonsOutOfSpan(MARS_AFTER_SPAN));
    const result = await runToolContract(getEphemerisTool, {
      designation: '499',
      start: '9990-01-01T00:00:00Z',
      stop: '9990-01-02T00:00:00Z',
      step: '1d',
    });
    const hint = declaredRecovery(getEphemerisTool.errors, 'time_out_of_range');
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.data?.reason).toBe('time_out_of_range');
    expect(errorEnvelope(result)?.data?.recovery?.hint).toBe(hint);
    expect(errorEnvelope(result)?.message).toContain('after A.D. 2599-DEC-31 23:58:50.8164 UT');
    expect(firstText(result)).toContain('after A.D. 2599-DEC-31 23:58:50.8164 UT');
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
    expect(firstText(result)).toContain('(reason time_out_of_range');
  });

  it('falls to horizons_unavailable for a "No ephemeris" line that names no bound', async () => {
    const err = await serviceRejection(
      horizonsOutOfSpan('No ephemeris available for this request.'),
    );
    expect(err?.data?.reason).toBe('horizons_unavailable');
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it.each([
    ['a small-body index miss', HORIZONS_NO_MATCH],
    ['a bare "No matches found."', 'No matches found for the requested object.'],
  ])('still reports %s as body_not_found', async (_label, body) => {
    const err = await serviceRejection(body);
    expect(err?.data?.reason).toBe('body_not_found');
    expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
  });
});

/**
 * Horizons' answer to `COMMAND='Mars'`, transcribed from a live request: a bare major-body
 * name matches the planet, its barycenter, and every spacecraft named for it, and Horizons
 * lists them by ID number instead of printing an ephemeris.
 */
const HORIZONS_MARS_MULTI_MATCH = [
  'API VERSION: 1.2',
  'API SOURCE: NASA/JPL Horizons API',
  '',
  '*******************************************************************************',
  ' Multiple major-bodies match string "MARS*"',
  '',
  '  ID#      Name                               Designation  IAU/aliases/other',
  '  -------  ---------------------------------- -----------  -------------------',
  '        4  Mars Barycenter',
  '      499  Mars',
  '       -3  Mars Orbiter Mission (spacecraft)  2013-060A    MOM Mangalyaan',
  '      -41  Mars Express (spacecraft)          2003-022A    MEX',
  '      -53  Mars Odyssey (spacecraft)          2001-013A',
  '     -530  Mars Pathfinder (spacecraft)       1996-068A    MPF',
  '      -74  Mars Reconnaissance Orbiter (spacec2005-029A    MRO',
  '      -76  Mars Science Laboratory (spacecraft2011-070A    Curiosity MSL',
  '     -143  ExoMars16 TGO (spacecraft)         2016-017A',
  '     -168  Mars2020 (spacecraft)              2020-052A    Ingenuity Perseveran',
  ' ',
  '   Number of matches =          10 . Use ID# to make unique selection.',
  '*******************************************************************************',
].join('\n');

/** A multi-match list of `count` bodies, in Horizons' layout, for the candidate cap. */
function horizonsMultiMatch(count: number): string {
  const rows = Array.from(
    { length: count },
    (_unused, i) => `${String(-1000 - i).padStart(9)}  ${`Probe ${i} (spacecraft)`.padEnd(34)}`,
  );
  return [
    ' Multiple major-bodies match string "PROBE*"',
    '',
    '  ID#      Name                               Designation  IAU/aliases/other',
    '  -------  ---------------------------------- -----------  -------------------',
    ...rows,
    ' ',
    `   Number of matches = ${String(count).padStart(11)} . Use ID# to make unique selection.`,
  ].join('\n');
}

describe('astronomy_get_ephemeris — a name matching several major bodies', () => {
  /**
   * Horizons gives this answer identically every time, so it is not the retryable outage.
   * The caller needs one of the listed ID numbers, so the error carries them.
   */
  it('fails ambiguous_designation listing every candidate ID, on both surfaces', async () => {
    stubFetch(HORIZONS_MARS_MULTI_MATCH);
    const result = await runToolContract(getEphemerisTool, {
      designation: 'Mars',
      start: '2026-01-01T00:00:00Z',
      stop: '2026-01-02T00:00:00Z',
      step: '1h',
    });
    const err = errorEnvelope(result);
    const hint = declaredRecovery(getEphemerisTool.errors, 'ambiguous_designation');
    expect(result.isError).toBe(true);
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('ambiguous_designation');
    expect(err?.data?.recovery?.hint).toBe(hint);
    expect(err?.message).toBe(
      '"Mars" matches 10 JPL Horizons major bodies: 4 (Mars Barycenter), 499 (Mars), -3 (Mars Orbiter Mission (spacecraft)), -41 (Mars Express (spacecraft)), -53 (Mars Odyssey (spacecraft)), -530 (Mars Pathfinder (spacecraft)), -74 (Mars Reconnaissance Orbiter (spacec), -76 (Mars Science Laboratory (spacecraft), -143 (ExoMars16 TGO (spacecraft)), -168 (Mars2020 (spacecraft)).',
    );
    const text = firstText(result);
    expect(text).toContain('499 (Mars)');
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('(reason ambiguous_designation');
    expect(text).not.toMatch(/retry in a few minutes/);
    expect(declaredRetryable(getEphemerisTool.errors, 'ambiguous_designation')).toBeUndefined();
  });

  it('carries the candidates as data a structured client can pick from', async () => {
    const err = await serviceRejection(HORIZONS_MARS_MULTI_MATCH);
    expect(err).toBeInstanceOf(McpError);
    expect(err?.data).toMatchObject({
      reason: 'ambiguous_designation',
      match_count: 10,
      candidates: expect.arrayContaining([{ id: '499', name: 'Mars' }]),
    });
    const data = err?.data as { candidates: { id: string }[] } | undefined;
    expect(data?.candidates.map((c) => c.id)).toEqual([
      '4',
      '499',
      '-3',
      '-41',
      '-53',
      '-530',
      '-74',
      '-76',
      '-143',
      '-168',
    ]);
  });

  it('lists at most 20 candidates and says how many Horizons matched', async () => {
    const err = await serviceRejection(horizonsMultiMatch(25));
    const data = err?.data as { candidates: unknown[]; match_count: number };
    expect(data.candidates).toHaveLength(20);
    expect(data.match_count).toBe(25);
    expect(err?.message).toMatch(/^"499" matches 25 JPL Horizons major bodies\. The first 20: /);
    expect(err?.message).toContain('-1019 (Probe 19 (spacecraft))');
    expect(err?.message).not.toContain('-1020');
  });

  it('still fails ambiguous_designation when the list carries no readable row', async () => {
    const err = await serviceRejection(' Multiple major-bodies match string "MARS*"\n');
    expect(err?.data?.reason).toBe('ambiguous_designation');
    expect(err?.message).toBe('"499" matches several JPL Horizons major bodies.');
  });
});

describe('astronomy_get_ephemeris — a designation containing an apostrophe', () => {
  /**
   * Horizons reads COMMAND inside single quotes with no escape for one within it, so the
   * quoted "6P/d'Arrest" reached its search as "6P/d". Sent unquoted, the whole name
   * arrives and still matches nothing. The comet resolves only by its designation form, so
   * the tool refuses the name before any request and says which form works.
   */
  it.each([["6P/d'Arrest"], ["d'Arrest"], ["O'Brien"]])(
    'fails body_not_found for %s without reaching Horizons, on both surfaces',
    async (designation) => {
      const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await runToolContract(getEphemerisTool, {
        designation,
        start: '2026-01-01T00:00:00Z',
        stop: '2026-01-02T00:00:00Z',
        step: '1h',
      });
      const err = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err?.data?.reason).toBe('body_not_found');
      expect(err?.data?.recovery?.hint).toBe(
        declaredRecovery(getEphemerisTool.errors, 'body_not_found'),
      );
      expect(err?.message).toBe(
        `Designation "${designation}" contains an apostrophe, which the JPL Horizons search cannot match. Use a record-resolving form instead, such as "DES=6P;CAP" for 6P/d'Arrest.`,
      );
      expect(firstText(result)).toContain('(reason body_not_found');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('states the same mechanism in the designation description and the error contract', () => {
    const description = getEphemerisTool.input.shape.designation.description ?? '';
    const when = getEphemerisTool.errors?.find((e) => e.reason === 'body_not_found')?.when ?? '';
    for (const text of [description, when]) {
      expect(text).toContain('apostrophe, which the Horizons search cannot match');
      expect(text).toContain('outside printable ASCII, which Horizons refuses');
    }
  });

  it('sends the designation form the error recommends to Horizons verbatim', async () => {
    const fetchSpy = stubOneRow(false);
    const result = await runToolContract(getEphemerisTool, {
      designation: 'DES=6P;CAP',
      start: '2026-01-01T00:00:00Z',
      stop: '2026-01-02T00:00:00Z',
      step: '1h',
    });
    expect(result.isError).toBeFalsy();
    expect(paramsOf(fetchSpy.mock.calls[0]?.[0]).get('COMMAND')).toBe("'DES=6P;CAP'");
  });
});

/** Live Horizons answer, HTTP 400, to `COMMAND='6P/d’Arrest'` (a typographic apostrophe). */
const COMMAND_NOT_ASCII_400 =
  '{"message":"invalid value specified for query parameter \'COMMAND\': invalid character(s) found (must be ASCII hex code 0x20-0x7f)","code":"400"}';

describe('astronomy_get_ephemeris — a designation outside printable ASCII', () => {
  const DAY = { start: '2026-01-01T00:00:00Z', stop: '2026-01-02T00:00:00Z', step: '1h' };

  /**
   * Horizons answers any COMMAND character outside printable ASCII with HTTP 400, whatever
   * the name, so the tool refuses such a designation before any request and names the
   * record-resolving forms that reach the object.
   */
  it.each([
    ['Šteins'],
    ['2867 Šteins'],
    ['6P/d’Arrest'],
    ['‘Oumuamua'],
    ['dʼArrest'],
    [`433;${String.fromCharCode(0x7f)}`],
    [`433;${String.fromCharCode(0x09)}`],
  ])(
    'fails body_not_found for %j without reaching Horizons, on both surfaces',
    async (designation) => {
      const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await runToolContract(getEphemerisTool, { designation, ...DAY });
      const err = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err?.data?.reason).toBe('body_not_found');
      expect(err?.data?.recovery?.hint).toBe(
        declaredRecovery(getEphemerisTool.errors, 'body_not_found'),
      );
      expect(err?.message).toBe(
        `Designation "${designation}" contains a character outside printable ASCII, the only characters JPL Horizons accepts. Use a record-resolving form instead, such as "2867;" for the asteroid 2867 Šteins or "DES=6P;CAP" for the comet 6P/d'Arrest.`,
      );
      expect(firstText(result)).toContain('(reason body_not_found');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('sends a designation at both ends of printable ASCII', async () => {
    const fetchSpy = stubOneRow(false);
    const result = await runToolContract(getEphemerisTool, { designation: '433; ~', ...DAY });
    expect(result.isError).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(paramsOf(fetchSpy.mock.calls[0]?.[0]).get('COMMAND')).toBe("'433; ~'");
  });
});

describe('astronomy_get_ephemeris — an HTTP 400 from Horizons', () => {
  const DAY = { start: '2026-01-01T00:00:00Z', stop: '2026-01-02T00:00:00Z', step: '1h' };

  /**
   * Horizons answers a parameter value it refuses with HTTP 400, identically on every
   * attempt, so it is a typed input refusal naming the input — never the retryable outage.
   * The COMMAND body is the live one; the others reuse its wording for another parameter.
   */
  it.each([
    [COMMAND_NOT_ASCII_400, 'designation'],
    [COMMAND_NOT_ASCII_400.replace('COMMAND', 'START_TIME'), 'start'],
    [COMMAND_NOT_ASCII_400.replace('COMMAND', 'STOP_TIME'), 'stop'],
    [COMMAND_NOT_ASCII_400.replace('COMMAND', 'STEP_SIZE'), 'step'],
    [COMMAND_NOT_ASCII_400.replace('COMMAND', 'SITE_COORD'), 'the observer coordinates'],
    [COMMAND_NOT_ASCII_400.replace('COMMAND', 'CAL_TYPE'), 'a request parameter'],
    ['Bad Request', 'a request parameter'],
  ])(
    'fails request_rejected on the first attempt for %s, on both surfaces',
    async (body, input) => {
      const fetchSpy = vi.fn(async () => new Response(body, { status: 400 }));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await runToolContract(getEphemerisTool, { designation: '433;', ...DAY });
      const err = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err?.data?.reason).toBe('request_rejected');
      expect(err?.data?.recovery?.hint).toBe(
        declaredRecovery(getEphemerisTool.errors, 'request_rejected'),
      );
      expect(err?.message).toBe(
        `JPL Horizons refused the request for "433;": it rejected the value sent for ${input}.`,
      );
      expect(firstText(result)).toContain('(reason request_rejected');
      expect(firstText(result)).not.toContain('ASCII hex code');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('carries only the typed reason and hint, no upstream internals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(COMMAND_NOT_ASCII_400, { status: 400 })),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', ...DAY });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.data).toEqual({
      reason: 'request_rejected',
      recovery: { hint: declaredRecovery(getEphemerisTool.errors, 'request_rejected') },
    });
    expectNoUpstreamLeak(err?.data);
  });
});

/** A resolved-target header followed by one Horizons refusal line, as a live response ends. */
function horizonsRefusal(line: string): string {
  return [
    'API VERSION: 1.2',
    'API SOURCE: NASA/JPL Horizons API',
    '',
    '*******************************************************************************',
    'JPL/HORIZONS                 433 Eros (A898 PA)            2026-Oct-15 11:24:45',
    '*******************************************************************************',
    '',
    line,
  ].join('\n');
}

describe('astronomy_get_ephemeris — Horizons refusals a retry cannot change', () => {
  /**
   * Horizons gives each of these answers identically every time, so none is the retryable
   * horizons_unavailable. Lines transcribed from live responses to input the tool accepted.
   */
  it('fails a step longer than the target’s data with invalid_step, on both surfaces', async () => {
    // Live: COMMAND='433;' STEP_SIZE='2147483647d'.
    stubFetch(horizonsRefusal('STEP_SIZE too big, exceeds available span.'));
    const result = await runToolContract(getEphemerisTool, {
      designation: '433;',
      start: '2026-01-01T00:00:00Z',
      stop: '2026-01-02T00:00:00Z',
      step: '2147483647d',
    });
    const err = errorEnvelope(result);
    const hint = declaredRecovery(getEphemerisTool.errors, 'invalid_step');
    expect(result.isError).toBe(true);
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_step');
    expect(err?.message).toBe(
      'Step "2147483647d" is longer than the span of data JPL Horizons holds for "433;".',
    );
    expect(err?.data?.recovery?.hint).toBe(hint);
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
    expect(firstText(result)).not.toMatch(/retry in a few minutes/);
  });

  it('rejects a step count Horizons cannot read before the request', async () => {
    // Live: STEP_SIZE='2147483648d' and '2147483648m' come back "Cannot read numeric value";
    // 2147483647 reads.
    const fetchSpy = stubOneRow(false);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const tooBig = await captureRejected(() =>
      getEphemerisTool.handler(
        getEphemerisTool.input.parse({ designation: '433;', step: '2147483648m' }),
        ctx,
      ),
    );
    expect(tooBig?.data?.reason).toBe('invalid_step');
    expect(tooBig?.message).toBe(
      'Invalid step "2147483648m". Expected a positive count up to 2147483647 plus m, h, d, mo, or y, e.g. "10m".',
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    await getEphemerisTool.handler(
      getEphemerisTool.input.parse({ designation: '433;', step: '2147483647m' }),
      createMockContext({ errors: getEphemerisTool.errors }),
    );
    expect(unquote(paramsOf(fetchSpy.mock.calls[0]?.[0]).get('STEP_SIZE'))).toBe('2147483647m');
  });

  it('fails Earth as the target with observer_is_target, on both surfaces', async () => {
    // Live: COMMAND='399' from the geocenter.
    stubFetch(horizonsRefusal('Observer table for observer=target disallowed.'));
    const result = await runToolContract(getEphemerisTool, {
      designation: '399',
      start: '2026-01-01T00:00:00Z',
      stop: '2026-01-02T00:00:00Z',
    });
    const err = errorEnvelope(result);
    const hint = declaredRecovery(getEphemerisTool.errors, 'observer_is_target');
    expect(result.isError).toBe(true);
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('observer_is_target');
    expect(err?.message).toBe(
      '"399" resolves to Earth, the body the observer is on, and JPL Horizons has no observer table for it.',
    );
    expect(err?.data?.recovery?.hint).toBe(hint);
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
  });

  it('rejects a blank designation at the schema, before the request', async () => {
    // Live: COMMAND=' ' comes back "missing COMMAND content ... cannot proceed".
    const fetchSpy = stubOneRow(false);
    const result = await runToolContract(getEphemerisTool, { designation: '  ' });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.message).toContain('designation must not be blank.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    // Live: "Observer geodetic altitude must be LESS than 40000 km" / "MORE than -20 km".
    [40_000_000, false],
    [39_999_999, true],
    [-20_000, false],
    [-19_999, true],
  ])('takes topocentric elevation %d m: %s', async (elevation, accepted) => {
    const fetchSpy = stubOneRow(true);
    const result = await runToolContract(getEphemerisTool, {
      designation: '433;',
      ...SEATTLE,
      elevation,
      start: '2024-01-01T00:00:00Z',
      stop: '2024-01-01T01:00:00Z',
    });
    if (accepted) {
      expect(result.isError).toBeFalsy();
      expect(paramsOf(fetchSpy.mock.calls[0]?.[0]).get('SITE_COORD')).toBe(
        `'${SEATTLE.longitude},${SEATTLE.latitude},${(elevation / 1000).toFixed(6)}'`,
      );
      return;
    }
    const err = errorEnvelope(result);
    const hint = declaredRecovery(getEphemerisTool.errors, 'invalid_elevation');
    expect(result.isError).toBe(true);
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_elevation');
    expect(err?.message).toBe(
      `Observer elevation ${elevation} m is outside the range JPL Horizons accepts for an observer: more than -20000 and less than 40000000 meters.`,
    );
    expect(err?.data?.recovery?.hint).toBe(hint);
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([50_000_000, -50_000])(
    'ignores elevation %d m on a geocentric request',
    async (elevation) => {
      // Elevation only places an observer; with no latitude/longitude there is none, so the
      // observer-altitude range Horizons enforces never applies and the call succeeds.
      const fetchSpy = stubOneRow(false);
      const result = await runToolContract(getEphemerisTool, {
        designation: '433;',
        elevation,
        start: '2024-01-01T00:00:00Z',
        stop: '2024-01-01T01:00:00Z',
      });
      expect(result.isError).toBeFalsy();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const params = paramsOf(fetchSpy.mock.calls[0]?.[0]);
      expect(params.get('CENTER')).toBe("'500@399'");
      expect(params.has('SITE_COORD')).toBe(false);
      expect((result.structuredContent as EphemerisOutputType).points).toHaveLength(1);
    },
  );
});

describe('astronomy_get_ephemeris — dates Horizons cannot read', () => {
  /**
   * Measured live against Horizons' START_TIME parser with the ISO form this tool sends:
   * `+010000-…` comes back "Cannot interpret date", `-000100-…` asks for BC notation, and
   * `0000-…` / `0099-…` are read as 2000 and 1999 — a different instant, answered silently.
   * Years 0100 through 9999 read as written. Anything else is refused before the request.
   */
  it.each([
    [
      'an expanded year past 9999',
      '+010000-01-01T00:00:00.000Z',
      '+010000-01-02T00:00:00.000Z',
      '+010000-01-01T00:00:00.000Z',
    ],
    [
      'a negative year',
      '-000100-01-01T00:00:00Z',
      '-000100-01-02T00:00:00Z',
      '-000100-01-01T00:00:00.000Z',
    ],
    [
      'a year below 0100',
      '0099-01-01T00:00:00Z',
      '0099-01-02T00:00:00Z',
      '0099-01-01T00:00:00.000Z',
    ],
    ['year 0000', '0000-01-01T00:00:00Z', '0000-01-02T00:00:00Z', '0000-01-01T00:00:00.000Z'],
  ])(
    'rejects %s with invalid_time before reaching Horizons, on both surfaces',
    async (_label, start, stop, sentStart) => {
      const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await runToolContract(getEphemerisTool, { designation: '433;', start, stop });
      const err = errorEnvelope(result);
      const hint = declaredRecovery(getEphemerisTool.errors, 'invalid_time');
      expect(result.isError).toBe(true);
      expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err?.data?.reason).toBe('invalid_time');
      expect(err?.message).toBe(
        `start "${sentStart}" is outside years 0100 through 9999, the calendar years JPL Horizons reads.`,
      );
      expect(err?.data?.recovery?.hint).toBe(hint);
      expect(hint).toContain('0100 through 9999');
      expect(firstText(result)).toContain(`Recovery: ${hint}`);
      expect(firstText(result)).not.toMatch(/retry in a few minutes/);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'an explicit stop',
      { stop: '+010000-01-01T00:00:00Z' },
      'stop "+010000-01-01T00:00:00.000Z" is outside years 0100 through 9999, the calendar years JPL Horizons reads.',
    ],
    /**
     * The default 24-hour span carries a late start past the last readable year. The caller
     * passed no stop, so the message says the one it names is the default.
     */
    [
      'the default stop',
      {},
      'stop "+010000-01-01T12:00:00.000Z" (the default, 24 hours after start) is outside years 0100 through 9999, the calendar years JPL Horizons reads.',
    ],
  ])('names the stop when only %s leaves the readable years', async (_label, stop, message) => {
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '10',
      start: '9999-12-31T12:00:00Z',
      ...stop,
    });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('invalid_time');
    expect(err?.message).toBe(message);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the first and last readable years unchanged', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) =>
        new Response(
          horizonsGeocentric([
            '0100-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    for (const [start, stop] of [
      ['0100-01-01T00:00:00Z', '0100-01-02T00:00:00Z'],
      ['9999-12-30T00:00:00Z', '9999-12-31T23:59:59.999Z'],
    ] as const) {
      const ctx = createMockContext({ errors: getEphemerisTool.errors });
      const input = getEphemerisTool.input.parse({ designation: '10', start, stop, step: '1d' });
      await getEphemerisTool.handler(input, ctx);
    }
    const sent = fetchSpy.mock.calls.map((c) => {
      const params = paramsOf(c[0]);
      return [unquote(params.get('START_TIME')), unquote(params.get('STOP_TIME'))];
    });
    expect(sent).toEqual([
      ['0100-01-01T00:00:00.000Z', '0100-01-02T00:00:00.000Z'],
      ['9999-12-30T00:00:00.000Z', '9999-12-31T23:59:59.999Z'],
    ]);
  });
});

describe('astronomy_get_ephemeris — the target Horizons resolved', () => {
  it('reports the resolved target when a bare name matches an unintended object', async () => {
    // Live: COMMAND='Eros' resolves by name search to Pluto's moon Kerberos, not 433 Eros,
    // and succeeds. Echoing only the request's designation hid that on both surfaces.
    stubFetch(
      horizonsWithTarget(
        'Target body name: Kerberos (904)                  {source: plu060_merged}',
      ),
    );
    const result = await runToolContract(getEphemerisTool, {
      designation: 'Eros',
      start: '2026-10-01T00:00:00Z',
      stop: '2026-10-01T02:00:00Z',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { designation?: string; target_name?: string };
    expect(structured.designation).toBe('Eros');
    expect(structured.target_name).toBe('Kerberos (904)');
    const heading = firstText(result).split('\n')[0];
    expect(heading).toContain('Eros');
    expect(heading).toContain('Kerberos (904)');
  });

  it.each([
    ['Target body name: 433 Eros (A898 PA)              {source: JPL#659}', '433 Eros (A898 PA)'],
    [
      'Target body name: Hubble Space Telescope (spacecraft) (-48) {source: hst}',
      'Hubble Space Telescope (spacecraft) (-48)',
    ],
    ['Target body name: 1P/Halley                       {source: JPL#75}', '1P/Halley'],
    ['Target body name: 1P/Halley', '1P/Halley'],
  ])('parses %j to its bare target name', async (line, expected) => {
    stubFetch(horizonsWithTarget(line));
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;' });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(getEphemerisTool.output));
    expect(result.target_name).toBe(expected);
    expect(result.points).toHaveLength(1);
  });

  it('omits target_name on both surfaces when the response carries no such header line', async () => {
    stubFetch(
      horizonsGeocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
      ]),
    );
    const result = await runToolContract(getEphemerisTool, {
      designation: '433;',
      start: '2024-01-01T00:00:00Z',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect('target_name' in structured).toBe(false);
    expect(firstText(result).split('\n')[0]).toBe('## 433; — 1 points');
    expect(firstText(result)).not.toContain('undefined');
  });

  it('no longer claims every bare name is rejected, and points the caller at target_name', () => {
    const designation = getEphemerisTool.input.shape.designation.description ?? '';
    for (const text of [getEphemerisTool.description, designation]) {
      expect(text).not.toMatch(/returns no match or an ambiguous record list and is rejected/);
      expect(text).toContain('target_name');
    }
  });
});

/**
 * A real ISS (NORAD 25544) element set at epoch 2024-01-01T12:00Z, shaped the way
 * CelesTrak serves GP data under `FORMAT=JSON` — used to drive the SGP4 propagation for
 * real over the fixture rather than mocking the math.
 */
const ISS_ELEMENTS = JSON.stringify([
  {
    OBJECT_NAME: 'ISS (ZARYA)',
    OBJECT_ID: '1998-067A',
    EPOCH: '2024-01-01T12:00:00.000000',
    MEAN_MOTION: 15.49447822,
    ECCENTRICITY: 0.0006703,
    INCLINATION: 51.6416,
    RA_OF_ASC_NODE: 247.4627,
    ARG_OF_PERICENTER: 130.536,
    MEAN_ANOMALY: 325.0288,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 25544,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 123,
    BSTAR: 0.0001027,
    MEAN_MOTION_DOT: 0.00016717,
    MEAN_MOTION_DDOT: 0,
  },
]);

/**
 * A synthetic element set standing in for a decayed object: an orbit low and draggy
 * enough that SGP4's mean elements stop describing it about ten days past epoch, well
 * inside the horizon over which a published element set is meant to hold. That is what
 * separates a reentry from a start the element set simply cannot reach. Synthetic
 * rather than a real catalog entry because CelesTrak drops decayed objects from
 * `gp.php?CATNR=` — what triggers the rejection is the drag term, not the identity.
 */
const DECAYED_ELEMENTS = JSON.stringify([
  {
    OBJECT_NAME: 'DECAYED TEST OBJECT',
    OBJECT_ID: '1999-001A',
    EPOCH: '2020-01-01T12:00:00.000000',
    MEAN_MOTION: 16.3,
    ECCENTRICITY: 0.0005,
    INCLINATION: 51.6,
    RA_OF_ASC_NODE: 100,
    ARG_OF_PERICENTER: 100,
    MEAN_ANOMALY: 260,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 88888,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 1,
    BSTAR: 0.0008687,
    MEAN_MOTION_DOT: 0.00016717,
    MEAN_MOTION_DDOT: 0,
  },
]);

/**
 * A real ISS (NORAD 25544) element set at epoch 2026-10-14T08:06:39Z, as CelesTrak serves
 * it. Ten days from 2026-10-14T16:00Z over Seattle hold six morning passes that come out
 * of Earth's shadow after peak — sunlit for minutes over a dark sky while dark at the peak
 * instant itself — and one whose sunlit stretch is a glimpse below 2° just before it sets.
 */
const ISS_ELEMENTS_2026 = JSON.stringify([
  {
    OBJECT_NAME: 'ISS (ZARYA)',
    OBJECT_ID: '1998-067A',
    EPOCH: '2026-10-14T08:06:39.057984',
    MEAN_MOTION: 15.48861773,
    ECCENTRICITY: 0.00067245,
    INCLINATION: 51.6325,
    RA_OF_ASC_NODE: 70.4557,
    ARG_OF_PERICENTER: 261.592,
    MEAN_ANOMALY: 98.4307,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 25544,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 59022,
    BSTAR: 0.00011949953,
    MEAN_MOTION_DOT: 6.109e-5,
    MEAN_MOTION_DDOT: 0,
  },
]);

/**
 * The exact pass geometry the ISS fixture yields over a three-day window from
 * 2024-01-01. Pinned rather than asserted structurally so a change to how the element
 * set reaches SGP4 has to reproduce the same orbit, down to the azimuths — a
 * structural assertion would pass on a subtly different propagation. The second and
 * fourth are lit from their rise until they enter Earth's shadow just before peak.
 */
const ISS_BASELINE_PASSES = [
  {
    rise_utc: '2024-01-01T01:05:49.000Z',
    peak_utc: '2024-01-01T01:11:00.000Z',
    set_utc: '2024-01-01T01:16:37.000Z',
    peak_altitude_degrees: 47.88101721069092,
    rise_azimuth_degrees: 290.1645601711657,
    set_azimuth_degrees: 95.86939455210046,
    peak_azimuth_degrees: 357.5385040257746,
    duration_seconds: 648,
    sunlit: true,
    visible_start_utc: '2024-01-01T01:07:12.000Z',
    visible_end_utc: '2024-01-01T01:14:52.000Z',
    visible_start_altitude_degrees: 5.8384832729708664,
    visible_end_altitude_degrees: 7.746476227979738,
    visible_start_azimuth_degrees: 293.4044264119559,
    visible_end_azimuth_degrees: 91.42189531430563,
  },
  {
    rise_utc: '2024-01-01T02:42:41.000Z',
    peak_utc: '2024-01-01T02:48:00.000Z',
    set_utc: '2024-01-01T02:53:23.000Z',
    peak_altitude_degrees: 47.84535628978751,
    rise_azimuth_degrees: 292.5579899048589,
    set_azimuth_degrees: 131.46174800469095,
    peak_azimuth_degrees: 214.54116837578965,
    duration_seconds: 642,
    sunlit: false,
    visible_start_utc: '2024-01-01T02:42:41.000Z',
    visible_end_utc: '2024-01-01T02:47:51.000Z',
    visible_start_altitude_degrees: 0,
    visible_end_altitude_degrees: 47.15182500537231,
    visible_start_azimuth_degrees: 292.5579899048589,
    visible_end_azimuth_degrees: 224.6167861119709,
  },
  {
    rise_utc: '2024-01-02T01:54:48.000Z',
    peak_utc: '2024-01-02T02:00:00.000Z',
    set_utc: '2024-01-02T02:05:38.000Z',
    peak_altitude_degrees: 68.43510558663432,
    rise_azimuth_degrees: 293.38176763227557,
    set_azimuth_degrees: 121.40388837022255,
    peak_azimuth_degrees: 244.21337319425083,
    duration_seconds: 650,
    sunlit: true,
    visible_start_utc: '2024-01-02T01:54:48.000Z',
    visible_end_utc: '2024-01-02T02:02:28.000Z',
    visible_start_altitude_degrees: 0,
    visible_end_altitude_degrees: 19.05125870667367,
    visible_start_azimuth_degrees: 293.38176763227557,
    visible_end_azimuth_degrees: 125.36779875978817,
  },
  {
    rise_utc: '2024-01-02T03:31:54.000Z',
    peak_utc: '2024-01-02T03:36:30.000Z',
    set_utc: '2024-01-02T03:41:07.000Z',
    peak_altitude_degrees: 13.71553619636664,
    rise_azimuth_degrees: 283.7663581970861,
    set_azimuth_degrees: 166.0126003096907,
    peak_azimuth_degrees: 225.30818926176948,
    duration_seconds: 553,
    sunlit: false,
    visible_start_utc: '2024-01-02T03:31:54.000Z',
    visible_end_utc: '2024-01-02T03:35:27.000Z',
    visible_start_altitude_degrees: 0,
    visible_end_altitude_degrees: 12.210035448530144,
    visible_start_azimuth_degrees: 283.7663581970861,
    visible_end_azimuth_degrees: 245.76089255998818,
  },
  {
    rise_utc: '2024-01-03T01:06:55.000Z',
    peak_utc: '2024-01-03T01:12:30.000Z',
    set_utc: '2024-01-03T01:17:47.000Z',
    peak_altitude_degrees: 77.21974981116315,
    rise_azimuth_degrees: 293.23855724506166,
    set_azimuth_degrees: 112.02870967096754,
    peak_azimuth_degrees: 64.43069916478123,
    duration_seconds: 652,
    sunlit: true,
    visible_start_utc: '2024-01-03T01:09:00.000Z',
    visible_end_utc: '2024-01-03T01:17:19.000Z',
    visible_start_altitude_degrees: 10.012451415939521,
    visible_end_altitude_degrees: 1.7837723640269771,
    visible_start_azimuth_degrees: 294.7307346777993,
    visible_end_azimuth_degrees: 111.78315361640915,
  },
  {
    rise_utc: '2024-01-03T02:43:51.000Z',
    peak_utc: '2024-01-03T02:49:00.000Z',
    set_utc: '2024-01-03T02:53:49.000Z',
    peak_altitude_degrees: 21.01892580792883,
    rise_azimuth_degrees: 287.9758465013465,
    set_azimuth_degrees: 153.29909990961266,
    peak_azimuth_degrees: 216.31588576206866,
    duration_seconds: 598,
    sunlit: true,
    visible_start_utc: '2024-01-03T02:43:51.000Z',
    visible_end_utc: '2024-01-03T02:50:19.000Z',
    visible_start_altitude_degrees: 0,
    visible_end_altitude_degrees: 15.999792284182645,
    visible_start_azimuth_degrees: 287.9758465013465,
    visible_end_azimuth_degrees: 185.34647611355285,
  },
];

/**
 * A pass with every number loosened to nine decimal places. The same propagation lands a
 * few bits apart in its last digits depending on what else has already run in the test
 * worker, so an exact float pin fails on test order rather than on a change to the orbit;
 * nine places still catch any real change in how the element set reaches SGP4.
 */
function approximately<P extends object>(pass: P): P {
  return Object.fromEntries(
    Object.entries(pass).map(([key, value]) => [
      key,
      typeof value === 'number' ? expect.closeTo(value, 9) : value,
    ]),
  ) as P;
}

/** The peak fields of a reported pass. */
interface PeakFields {
  peak_altitude_degrees: number;
  peak_azimuth_degrees: number;
  peak_utc: string;
}

/**
 * A pass minus its peak. The peak is the highest 30-second scan sample, so a scan started
 * off that grid — at a rise refined to the second — samples it at other instants; every
 * other field is bisected to the second on the scan's own second grid and lands on the
 * same instant from any whole-second start.
 */
function withoutPeak<P extends PeakFields>(pass: P | undefined) {
  if (!pass) throw new Error('Expected a pass.');
  const { peak_utc: _utc, peak_altitude_degrees: _alt, peak_azimuth_degrees: _az, ...rest } = pass;
  return rest;
}

/** The two peaks are samples of the same pass, at most one scan step apart. */
function expectPeakWithinOneStep(actual: PeakFields | undefined, expected: PeakFields | undefined) {
  expect(
    Math.abs(Date.parse(actual?.peak_utc ?? '') - Date.parse(expected?.peak_utc ?? '')),
  ).toBeLessThanOrEqual(30_000);
}

describe('astronomy_get_satellite_passes — happy path', () => {
  it('reproduces the pinned ISS pass geometry over a three-day window', async () => {
    stubFetch(ISS_ELEMENTS);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      days: 3,
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getSatellitePassesTool.handler(input, ctx);
    expect(result.passes).toEqual(ISS_BASELINE_PASSES.map(approximately));
  });

  it('fetches a TLE, propagates with SGP4, and returns a schema-conforming result', async () => {
    stubFetch(ISS_ELEMENTS);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      days: 3,
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getSatellitePassesTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(getSatellitePassesTool.output));
    expect(result.norad_id).toBe(25544);
    expect(result.satellite_name).toBe('ISS (ZARYA)');
    for (const p of result.passes) {
      expect(p.peak_altitude_degrees).toBeGreaterThanOrEqual(10);
      expect(new Date(p.set_utc).getTime()).toBeGreaterThan(new Date(p.rise_utc).getTime());
    }
  });

  it('caches the TLE so a second call within the TTL does not refetch', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      days: 1,
      start: '2024-01-01T00:00:00Z',
    });
    await getSatellitePassesTool.handler(input, ctx);
    await getSatellitePassesTool.handler(input, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('format() renders a header and the no-passes branch when none are visible', async () => {
    stubFetch(ISS_ELEMENTS);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    // A 1-day window from an instant; if no visible passes occur, the empty
    // branch must render rather than producing a bare header.
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      days: 1,
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getSatellitePassesTool.handler(input, ctx);
    const block = getSatellitePassesTool.format!(result)[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('NORAD 25544');
    if (result.passes.length === 0) {
      expect(text).toMatch(/No visible passes/i);
    } else {
      expect(text).toMatch(/rise_utc/);
    }
  });

  it('omits a pass already underway at start rather than reporting start as its rise', async () => {
    stubFetch(ISS_ELEMENTS);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const baseline = await getSatellitePassesTool.handler(
      getSatellitePassesTool.input.parse({
        norad_id: 25544,
        ...SEATTLE,
        days: 10,
        start: '2024-01-01T00:00:00Z',
      }),
      ctx,
    );
    const firstRise = baseline.passes[0]?.rise_utc;
    const second = baseline.passes[1];
    expect(firstRise).toBeTypeOf('string');
    expect(second).toBeDefined();

    // Re-ask from an instant two steps after that first pass's true acquisition, so the
    // window opens mid-pass. The scan used to treat its first above-horizon sample as a
    // rise, reporting the query boundary as rise_utc with a clipped duration.
    const midPassStart = new Date(new Date(firstRise as string).getTime() + 60_000).toISOString();
    const midCtx = createMockContext({ errors: getSatellitePassesTool.errors });
    const mid = await getSatellitePassesTool.handler(
      getSatellitePassesTool.input.parse({
        norad_id: 25544,
        ...SEATTLE,
        days: 10,
        start: midPassStart,
      }),
      midCtx,
    );
    // The partial pass is dropped; reporting resumes at the next complete one.
    expect(mid.passes[0]?.rise_utc).toBe(second?.rise_utc);
    expect(mid.passes[0]?.duration_seconds).toBe(second?.duration_seconds);
    for (const p of mid.passes) {
      expect(new Date(p.rise_utc).getTime()).toBeGreaterThan(new Date(midPassStart).getTime());
    }
  });

  it('keeps a pass that rises exactly at start, so a reported rise_utc round-trips', async () => {
    // Feeding a reported rise_utc back as start is the natural way to narrow a window.
    // At that instant the satellite is above the horizon but has not been up for a full
    // step, so it is rising, not underway — dropping it would silently lose the pass the
    // previous call just advertised.
    stubFetch(ISS_ELEMENTS);
    const baseline = await getSatellitePassesTool.handler(
      getSatellitePassesTool.input.parse({
        norad_id: 25544,
        ...SEATTLE,
        days: 10,
        start: '2024-01-01T00:00:00Z',
      }),
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    const first = baseline.passes[0];
    expect(first).toBeDefined();

    const resumed = await getSatellitePassesTool.handler(
      getSatellitePassesTool.input.parse({
        norad_id: 25544,
        ...SEATTLE,
        days: 10,
        start: first?.rise_utc,
      }),
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    expect(withoutPeak(resumed.passes[0])).toEqual(approximately(withoutPeak(first)));
    expectPeakWithinOneStep(resumed.passes[0], first);
  });

  it('keeps a pass that rises one step after start', async () => {
    stubFetch(ISS_ELEMENTS);
    const baseline = await getSatellitePassesTool.handler(
      getSatellitePassesTool.input.parse({
        norad_id: 25544,
        ...SEATTLE,
        days: 10,
        start: '2024-01-01T00:00:00Z',
      }),
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    const first = baseline.passes[0];
    expect(first).toBeDefined();
    const oneStepBefore = new Date(
      new Date(first?.rise_utc as string).getTime() - 30_000,
    ).toISOString();

    const shifted = await getSatellitePassesTool.handler(
      getSatellitePassesTool.input.parse({
        norad_id: 25544,
        ...SEATTLE,
        days: 10,
        start: oneStepBefore,
      }),
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    expect(withoutPeak(shifted.passes[0])).toEqual(approximately(withoutPeak(first)));
    expectPeakWithinOneStep(shifted.passes[0], first);
  });

  /**
   * The baseline's first pass rises 2024-01-01T01:05:49Z — first seen above the horizon by
   * the 01:06:00Z scan sample — and sets at 01:16:37Z. A one-day window placed so it
   * closes at or around that rise tests the trailing edge; every start below sits on the
   * same 30-second grid as the baseline's, so the samples coincide and the geometry has
   * to match exactly.
   */
  const TRAILING_PASS = ISS_BASELINE_PASSES[0]!;

  it('reports a pass that rises inside the window but sets after it ends', async () => {
    // Window ends 2024-01-01T01:08:00Z, two minutes into the pass. The scan used to stop
    // at the window's last step with the pass still open and never record it.
    stubFetch(ISS_ELEMENTS);
    const result = await runToolContract(getSatellitePassesTool, {
      norad_id: 25544,
      ...SEATTLE,
      days: 1,
      start: '2023-12-31T01:08:00Z',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { passes: (typeof TRAILING_PASS)[] };
    expect(structured.passes.at(-1)).toEqual(approximately(TRAILING_PASS));
    // The pass is followed to its real set, past the window's end.
    expect(new Date(TRAILING_PASS.set_utc).getTime()).toBeGreaterThan(
      new Date('2024-01-01T01:08:00Z').getTime(),
    );
    const text = firstText(result);
    expect(text).toContain(`rise_utc ${TRAILING_PASS.rise_utc}`);
    expect(text).toContain(`set_utc ${TRAILING_PASS.set_utc}`);
  });

  it('reports a pass rising exactly on the window’s last step', async () => {
    stubFetch(ISS_ELEMENTS);
    const result = await getSatellitePassesTool.handler(
      getSatellitePassesTool.input.parse({
        norad_id: 25544,
        ...SEATTLE,
        days: 1,
        start: '2023-12-31T01:06:00Z',
      }),
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    expect(result.passes.at(-1)).toEqual(approximately(TRAILING_PASS));
  });

  it('leaves out a pass rising one step after the window ends', async () => {
    // A window that closes with no pass in progress answers exactly as before: the next
    // pass has not risen inside it, so extending the scan must not reach for it.
    stubFetch(ISS_ELEMENTS);
    const result = await getSatellitePassesTool.handler(
      getSatellitePassesTool.input.parse({
        norad_id: 25544,
        ...SEATTLE,
        days: 1,
        start: '2023-12-31T01:05:30Z',
      }),
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    const windowEnd = new Date('2024-01-01T01:05:30Z').getTime();
    for (const p of result.passes) {
      expect(new Date(p.rise_utc).getTime()).toBeLessThanOrEqual(windowEnd);
      expect(new Date(p.set_utc).getTime()).toBeLessThanOrEqual(windowEnd);
    }
    expect(result.passes.map((p) => p.rise_utc)).not.toContain(TRAILING_PASS.rise_utc);
  });

  it('format() rounds pass azimuths, altitude, and duration and carries the exact values', () => {
    // The original repro: az 230.26515812203434° must display as az 230.3°, and the
    // exact value must still be recoverable from content[] alone.
    const block = getSatellitePassesTool.format!({
      norad_id: 25544,
      satellite_name: 'ISS (ZARYA)',
      passes: [
        {
          rise_utc: '2024-01-01T00:00:00.000Z',
          peak_utc: '2024-01-01T00:05:00.000Z',
          set_utc: '2024-01-01T00:10:00.000Z',
          peak_altitude_degrees: 45.6789012,
          rise_azimuth_degrees: 230.26515812203434,
          set_azimuth_degrees: 130.98765,
          peak_azimuth_degrees: 180.5555,
          duration_seconds: 372.48,
          sunlit: true,
          visible_start_utc: '2024-01-01T00:02:13.000Z',
          visible_end_utc: '2024-01-01T00:10:00.000Z',
          visible_start_altitude_degrees: 21.98765432,
          visible_end_altitude_degrees: 0,
          visible_start_azimuth_degrees: 251.123456789,
          visible_end_azimuth_degrees: 130.98765,
        },
      ],
    })[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('az 230.3°');
    expect(text).toContain('alt 45.7°');
    expect(text).toContain('duration 372s');
    // No display value carries four or more decimal places…
    expect(displayValuesOf(text)).not.toMatch(/\.\d{4,}/);
    // …and every rounded value still names its exact counterpart.
    expect(text).toContain('az 230.3° [230.26515812203434]');
    expect(text).toContain('alt 45.7° [45.6789012]');
    expect(text).toContain('duration 372s [372.48]');
    expectExactCarried(text, 130.98765);
    expectExactCarried(text, 180.5555);
    expect(text).toContain(
      'visible_start_utc 2024-01-01T00:02:13.000Z alt 22.0° [21.98765432] az 251.1° [251.123456789]',
    );
    expect(text).toContain(
      'visible_end_utc 2024-01-01T00:10:00.000Z alt 0.0° az 131.0° [130.98765]',
    );
  });
});

const RAD = Math.PI / 180;

/**
 * An independent second-by-second rescan of one element set from one observer, built
 * directly on satellite.js and astronomy-engine with the thresholds the tool documents:
 * above the horizon, Earth covering less than half the solar disc, and the Sun below −6°.
 * It shares no code with the service's scan, so each edge the tool reports is checked
 * against the 1 s answer rather than against itself.
 */
function oneSecondRescan(elementsJson: string, site: { latitude: number; longitude: number }) {
  const [record] = OmmResponseSchema.parse(JSON.parse(elementsJson));
  if (!record) throw new Error('The fixture carries no element set.');
  const satrec = json2satrec(record);
  const geodetic = { latitude: site.latitude * RAD, longitude: site.longitude * RAD, height: 0 };
  const sky = new Observer(site.latitude, site.longitude, 0);
  const state = (ms: number) => {
    const t = new Date(ms);
    const pv = propagate(satrec, t);
    if (!pv) throw new Error(`The fixture does not propagate to ${t.toISOString()}.`);
    const look = ecfToLookAngles(geodetic, eciToEcf(pv.position, gstime(t)));
    return {
      t,
      position: pv.position,
      elevation: look.elevation / RAD,
      azimuth: (((look.azimuth / RAD) % 360) + 360) % 360,
    };
  };
  const up = (ms: number) => state(ms).elevation > 0;
  const visible = (ms: number) => {
    const s = state(ms);
    if (shadowFraction(sunPos(jday(s.t)).rsun, s.position) >= 0.5) return false;
    const time = MakeTime(s.t);
    const sun = Equator(Body.Sun, time, sky, true, true);
    return Horizon(time, sky, sun.ra, sun.dec, 'normal').altitude < -6;
  };
  /**
   * The whole second nearest `iso` at which `test` changes value — the first second on
   * the far side of the change — from a 1 s scan across ±45 s.
   */
  const changeNear = (iso: string, test: (ms: number) => boolean): number => {
    const around = Date.parse(iso);
    let nearest: number | undefined;
    let before = test(around - 46_000);
    for (let ms = around - 45_000; ms <= around + 45_000; ms += 1000) {
      const now = test(ms);
      if (
        now !== before &&
        (nearest === undefined || Math.abs(ms - around) < Math.abs(nearest - around))
      ) {
        nearest = ms;
      }
      before = now;
    }
    if (nearest === undefined) throw new Error(`Nothing changes within 45 s of ${iso}.`);
    return nearest;
  };
  return {
    elevation: (iso: string) => state(Date.parse(iso)).elevation,
    azimuth: (iso: string) => state(Date.parse(iso)).azimuth,
    visible: (iso: string) => visible(Date.parse(iso)),
    horizonCrossingNear: (iso: string) => changeNear(iso, up),
    visibilityChangeNear: (iso: string) => changeNear(iso, visible),
  };
}

/** Run the tool over one element set from Seattle, through the handler. */
async function seattlePasses(
  elementsJson: string,
  args: { start: string; days: number; timezone?: string },
) {
  stubFetch(elementsJson);
  return getSatellitePassesTool.handler(
    getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE, ...args }),
    createMockContext({ errors: getSatellitePassesTool.errors }),
  );
}

/** The two windows the pass-geometry checks run over: one per real element set. */
const PASS_WINDOWS = [
  {
    label: 'the 2024 fixture, three days',
    elements: ISS_ELEMENTS,
    start: '2024-01-01T00:00:00Z',
    days: 3,
    passCount: 6,
  },
  {
    label: 'the 2026 element set, ten days',
    elements: ISS_ELEMENTS_2026,
    start: '2026-10-14T16:00:00Z',
    days: 10,
    passCount: 17,
  },
];

describe('astronomy_get_satellite_passes — rise and set to the second', () => {
  it.each(PASS_WINDOWS)(
    'reports every rise and set within 1 s of a 1 s rescan, with the azimuth there and the duration between ($label)',
    async ({ elements, start, days, passCount }) => {
      const { passes } = await seattlePasses(elements, { start, days });
      const rescan = oneSecondRescan(elements, SEATTLE);
      expect(passes).toHaveLength(passCount);
      for (const p of passes) {
        const rise = rescan.horizonCrossingNear(p.rise_utc);
        const set = rescan.horizonCrossingNear(p.set_utc);
        expect(Math.abs(Date.parse(p.rise_utc) - rise), p.rise_utc).toBeLessThanOrEqual(1000);
        expect(Math.abs(Date.parse(p.set_utc) - set), p.set_utc).toBeLessThanOrEqual(1000);
        expect(p.rise_azimuth_degrees, p.rise_utc).toBeCloseTo(rescan.azimuth(p.rise_utc), 9);
        expect(p.set_azimuth_degrees, p.set_utc).toBeCloseTo(rescan.azimuth(p.set_utc), 9);
        expect(p.duration_seconds).toBe((Date.parse(p.set_utc) - Date.parse(p.rise_utc)) / 1000);
      }
    },
  );
});

/** The 30-second-scan peak of each 2026-window pass that is sunlit at its peak. */
const PEAK_LIT_2026 = [
  '2026-10-15T13:47:30.000Z',
  '2026-10-16T13:00:30.000Z',
  '2026-10-17T12:13:30.000Z',
  '2026-10-17T13:49:30.000Z',
  '2026-10-18T13:02:30.000Z',
  '2026-10-19T13:52:00.000Z',
  '2026-10-20T13:04:30.000Z',
  '2026-10-21T13:54:00.000Z',
  '2026-10-22T13:06:30.000Z',
  '2026-10-23T13:56:00.000Z',
  '2026-10-24T13:08:30.000Z',
];

/** Passes in the 2026 window dark at peak but sunlit over a dark sky afterwards, past 10°. */
const SHADOW_EXIT_2026 = [
  '2026-10-19T12:15:00.000Z',
  '2026-10-20T11:28:00.000Z',
  '2026-10-21T12:17:00.000Z',
  '2026-10-22T11:29:30.000Z',
  '2026-10-23T12:19:00.000Z',
  '2026-10-24T11:31:30.000Z',
];

describe('astronomy_get_satellite_passes — passes chosen by their visible stretch', () => {
  it.each(PASS_WINDOWS)(
    'bounds every visible stretch inside its pass and has it reach 10° ($label)',
    async ({ elements, start, days }) => {
      const { passes } = await seattlePasses(elements, { start, days });
      for (const p of passes) {
        const [rise, from, to, set, peak] = [
          p.rise_utc,
          p.visible_start_utc,
          p.visible_end_utc,
          p.set_utc,
          p.peak_utc,
        ].map(Date.parse) as [number, number, number, number, number];
        expect(rise, p.peak_utc).toBeLessThanOrEqual(from);
        expect(from, p.peak_utc).toBeLessThan(to);
        expect(to, p.peak_utc).toBeLessThanOrEqual(set);
        // Altitude rises to the peak and falls after it, so the stretch's highest point is
        // the peak when the stretch contains it and one of its two ends otherwise.
        const highest =
          from <= peak && peak <= to
            ? p.peak_altitude_degrees
            : Math.max(p.visible_start_altitude_degrees, p.visible_end_altitude_degrees);
        expect(highest, p.peak_utc).toBeGreaterThanOrEqual(10);
      }
    },
  );

  it.each(PASS_WINDOWS)(
    'puts every visible-stretch edge within 1 s of a 1 s rescan ($label)',
    async ({ elements, start, days }) => {
      const { passes } = await seattlePasses(elements, { start, days });
      const rescan = oneSecondRescan(elements, SEATTLE);
      let shadowOrTwilightEdges = 0;
      for (const p of passes) {
        const edges = [
          {
            at: p.visible_start_utc,
            altitude: p.visible_start_altitude_degrees,
            azimuth: p.visible_start_azimuth_degrees,
            horizon: { at: p.rise_utc, azimuth: p.rise_azimuth_degrees },
          },
          {
            at: p.visible_end_utc,
            altitude: p.visible_end_altitude_degrees,
            azimuth: p.visible_end_azimuth_degrees,
            horizon: { at: p.set_utc, azimuth: p.set_azimuth_degrees },
          },
        ];
        for (const edge of edges) {
          if (edge.at === edge.horizon.at) {
            // An edge on the horizon is that crossing: altitude 0 and the crossing's azimuth.
            expect(edge.altitude, edge.at).toBe(0);
            expect(edge.azimuth, edge.at).toBe(edge.horizon.azimuth);
            continue;
          }
          shadowOrTwilightEdges++;
          const change = rescan.visibilityChangeNear(edge.at);
          expect(Math.abs(Date.parse(edge.at) - change), edge.at).toBeLessThanOrEqual(1000);
          expect(rescan.visible(edge.at), edge.at).toBe(true);
          expect(edge.altitude, edge.at).toBeCloseTo(rescan.elevation(edge.at), 9);
          expect(edge.azimuth, edge.at).toBeCloseTo(rescan.azimuth(edge.at), 9);
        }
      }
      expect(shadowOrTwilightEdges).toBeGreaterThan(0);
    },
  );

  it('returns exactly the 2026 passes whose visible stretch reaches 10°, dark-at-peak ones included', async () => {
    /**
     * Left out: a pass peaking at 34.7° on 2026-10-23, dark at peak, that comes out of
     * shadow about 50 s before it sets — sunlit over a dark sky, but never above 2° while
     * it is.
     */
    const rescan = oneSecondRescan(ISS_ELEMENTS_2026, SEATTLE);
    expect(rescan.visible('2026-10-23T10:47:20Z')).toBe(true);
    expect(rescan.elevation('2026-10-23T10:47:20Z')).toBeLessThan(2);
    expect(rescan.elevation('2026-10-23T10:42:30Z')).toBeGreaterThan(10);
    const { passes } = await seattlePasses(ISS_ELEMENTS_2026, {
      start: '2026-10-14T16:00:00Z',
      days: 10,
    });
    expect(passes.map((p) => p.peak_utc)).toEqual([...PEAK_LIT_2026, ...SHADOW_EXIT_2026].sort());
    expect(passes.filter((p) => !p.sunlit).map((p) => p.peak_utc)).toEqual(SHADOW_EXIT_2026);
  });

  it('carries the visible stretch through structuredContent and content[] alike', async () => {
    stubFetch(ISS_ELEMENTS);
    const result = await runToolContract(getSatellitePassesTool, {
      norad_id: 25544,
      ...SEATTLE,
      days: 3,
      start: '2024-01-01T00:00:00Z',
      timezone: 'America/Los_Angeles',
    });
    expect(result.isError).toBeFalsy();
    const parsed = getSatellitePassesTool.output.parse(result.structuredContent);
    expect(parsed.passes).toHaveLength(6);
    const text = firstText(result);
    for (const p of parsed.passes) {
      expect(p.visible_start_local).toBeTypeOf('string');
      expect(p.visible_end_local).toBeTypeOf('string');
      expect(text).toContain(
        `visible_start_utc ${p.visible_start_utc} (local ${p.visible_start_local})`,
      );
      expect(text).toContain(`visible_end_utc ${p.visible_end_utc} (local ${p.visible_end_local})`);
      for (const value of [
        p.visible_start_altitude_degrees,
        p.visible_end_altitude_degrees,
        p.visible_start_azimuth_degrees,
        p.visible_end_azimuth_degrees,
      ]) {
        expectExactCarried(text, value);
      }
      expect(text).toContain(`sunlit ${p.sunlit}`);
    }
    expectRoundedDisplay(text);
  });

  /**
   * A synthetic object on a GPS-like twelve-hour orbit whose plane holds the Sun at the
   * March 2024 equinox. Its passes last hours and cross Earth's shadow mid-pass, so a
   * pass is lit, eclipsed for about an hour, then lit again — two visible stretches in
   * one pass, which a low orbit almost never shows. Synthetic because the case needs an
   * eclipse shorter than the pass, not a particular catalog object.
   */
  const MEO_ELEMENTS = JSON.stringify([
    {
      OBJECT_NAME: 'MEO TEST OBJECT',
      OBJECT_ID: '2000-001A',
      EPOCH: '2024-03-20T00:00:00.000000',
      MEAN_MOTION: 2.00563,
      ECCENTRICITY: 0.001,
      INCLINATION: 55,
      RA_OF_ASC_NODE: 0,
      ARG_OF_PERICENTER: 0,
      MEAN_ANOMALY: 0,
      NORAD_CAT_ID: 77777,
      ELEMENT_SET_NO: 999,
      BSTAR: 0,
      MEAN_MOTION_DOT: 0,
      MEAN_MOTION_DDOT: 0,
    },
  ]);

  it.each([
    {
      label: 'the later stretch climbs higher',
      site: { latitude: 0, longitude: -80 },
      peak: '2024-03-20T06:00:30.000Z',
      // The earlier stretch rises toward the eclipse and tops out where it enters it.
      skipped: '2024-03-20T05:00:00Z',
      skippedShadowEdge: '2024-03-20T05:31:20Z',
      reportedShadowEdge: 'start' as const,
    },
    {
      label: 'the earlier stretch climbs higher',
      site: { latitude: 20, longitude: -140 },
      peak: '2024-03-21T01:29:00.000Z',
      // The later stretch starts where it leaves the eclipse and sinks from there.
      skipped: '2024-03-21T06:40:00Z',
      skippedShadowEdge: '2024-03-21T06:24:50Z',
      reportedShadowEdge: 'end' as const,
    },
  ])(
    'reports the visible stretch reaching higher when a pass has two ($label)',
    async ({ site, peak, skipped, skippedShadowEdge, reportedShadowEdge }) => {
      stubFetch(MEO_ELEMENTS);
      const { passes } = await getSatellitePassesTool.handler(
        getSatellitePassesTool.input.parse({
          norad_id: 77777,
          ...site,
          days: 1,
          start: '2024-03-20T00:00:00Z',
        }),
        createMockContext({ errors: getSatellitePassesTool.errors }),
      );
      const pass = passes.find((p) => p.peak_utc === peak);
      expect(pass, peak).toBeDefined();
      if (!pass) return;
      const rescan = oneSecondRescan(MEO_ELEMENTS, site);
      const [from, to, skippedAt] = [pass.visible_start_utc, pass.visible_end_utc, skipped].map(
        Date.parse,
      ) as [number, number, number];
      // The other stretch is real: visible, inside the pass, outside the one reported.
      expect(rescan.visible(skipped)).toBe(true);
      expect(skippedAt > to || skippedAt < from).toBe(true);
      expect(Date.parse(pass.rise_utc)).toBeLessThan(skippedAt);
      expect(skippedAt).toBeLessThan(Date.parse(pass.set_utc));
      // The reported stretch meets the eclipse in the sky, at an edge bisected to the second.
      const shadowEdge =
        reportedShadowEdge === 'start' ? pass.visible_start_utc : pass.visible_end_utc;
      expect(
        Math.abs(Date.parse(shadowEdge) - rescan.visibilityChangeNear(shadowEdge)),
      ).toBeLessThanOrEqual(1000);
      // Neither stretch holds the peak, which falls in the eclipse or before both, so each
      // tops out at one of its ends. The skipped one's top is its eclipse edge: the highest
      // visible second within a minute of it.
      expect(Date.parse(pass.peak_utc) < from || Date.parse(pass.peak_utc) > to).toBe(true);
      const reportedTop = Math.max(
        pass.visible_start_altitude_degrees,
        pass.visible_end_altitude_degrees,
      );
      let skippedTop = -90;
      for (let ms = -60_000; ms <= 60_000; ms += 1000) {
        const at = new Date(Date.parse(skippedShadowEdge) + ms).toISOString();
        if (rescan.visible(at)) skippedTop = Math.max(skippedTop, rescan.elevation(at));
      }
      expect(skippedTop).toBeGreaterThan(0);
      expect(skippedTop).toBeLessThan(reportedTop);
    },
  );

  it('states the visibility rule and its thresholds in the tool description', () => {
    const description = getSatellitePassesTool.description;
    expect(description).toContain('10°');
    expect(description).toContain('−6°');
    expect(description).toContain('visible_start_utc');
  });
});

describe('astronomy_get_satellite_passes — days past the per-call cap', () => {
  interface SatelliteCall {
    notice?: string;
    passes: SatellitePassesOutputType['passes'];
    totalCount?: number;
  }
  const call = async (input: Record<string, unknown>) => {
    const result = await runToolContract(getSatellitePassesTool, {
      norad_id: 25544,
      ...SEATTLE,
      ...input,
    });
    expect(result.isError).toBeFalsy();
    return { result, out: result.structuredContent as unknown as SatelliteCall };
  };
  /** The resume `start` and `days` a notice names. */
  const resumeOf = (notice: string | undefined) => {
    const match = /Re-call with start (\S+) and days (\d+) for the rest\./.exec(notice ?? '');
    if (!match?.[1] || !match[2]) throw new Error(`No resume instruction in notice: ${notice}`);
    return { start: match[1], days: Number(match[2]) };
  };

  it('searches 10 of 14 requested days and names the exact continuation on both surfaces', async () => {
    stubFetch(ISS_ELEMENTS);
    const { result, out } = await call({ days: 14, start: '2024-01-01T00:00:00Z' });
    expect(out.notice).toBe(
      'Searched 10 of the 14 requested days (10 per call), through 2024-01-11T00:00:00.000Z. Re-call with start 2024-01-11T00:00:30.000Z and days 4 for the rest.',
    );
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(out.notice!);
    const tenDays = await call({ days: 10, start: '2024-01-01T00:00:00Z' });
    expect(out.passes).toEqual(tenDays.out.passes.map(approximately));
    expect(out.totalCount).toBe(out.passes.length);
  });

  it('continues from the named start with no pass repeated or missed', async () => {
    /**
     * Three placements of the boundary against one uncapped 14-day scan at the service
     * seam: an arbitrary instant, the window closing mid-pass (call 1 follows that pass
     * to its set, call 2 omits it as already up), and a pass rising inside the 30 s
     * between the window's end and the resume start (call 2 reports it).
     */
    const [record] = OmmResponseSchema.parse(JSON.parse(ISS_ELEMENTS));
    const elements = { name: 'ISS (ZARYA)', noradId: 25544, omm: record! };
    const observer = { ...SEATTLE, elevation: 0 };
    /** Every instant a pass reports, so a pass moved by a second does not pass as the same. */
    const instants = (p: {
      rise_utc: string;
      peak_utc: string;
      set_utc: string;
      visible_start_utc: string;
      visible_end_utc: string;
    }) => [p.rise_utc, p.peak_utc, p.set_utc, p.visible_start_utc, p.visible_end_utc].join(' ');
    const uncapped = (start: string) =>
      new SatelliteService('https://example.test/celestrak', 5000, 0)
        .predictPasses(elements, observer, 14, new Date(start))
        .passes.map((p) =>
          instants({
            rise_utc: p.riseUtc,
            peak_utc: p.peakUtc,
            set_utc: p.setUtc,
            visible_start_utc: p.visibleStartUtc,
            visible_end_utc: p.visibleEndUtc,
          }),
        );
    const tenDaysBefore = (iso: string) =>
      new Date(Date.parse(iso) - 10 * 86_400_000).toISOString();

    // A pass ten days into the boundary scans: its peak sample, and its rise rounded up to
    // the scan's 30-second grid.
    const target = (await seattlePasses(ISS_ELEMENTS, { start: '2024-01-03T00:00:00Z', days: 1 }))
      .passes[0];
    expect(target).toBeDefined();
    if (!target) return;
    const firstSampleUp = Math.ceil(Date.parse(target.rise_utc) / 30_000) * 30_000;
    const placements = [
      { start: '2023-12-25T00:00:00Z', boundary: 'arbitrary' },
      { start: tenDaysBefore(target.peak_utc), boundary: 'mid-pass' },
      {
        start: tenDaysBefore(new Date(firstSampleUp - 30_000).toISOString()),
        boundary: 'rise before resume',
      },
    ] as const;

    for (const { start, boundary } of placements) {
      stubFetch(ISS_ELEMENTS);
      const first = await call({ days: 14, start });
      const resume = resumeOf(first.out.notice);
      expect(resume.days, boundary).toBe(4);
      const rest = await call(resume);
      expect(rest.out.notice, boundary).toBeUndefined();
      const joined = [...first.out.passes, ...rest.out.passes].map(instants);
      expect(new Set(joined).size, boundary).toBe(joined.length);
      expect(joined, boundary).toEqual(uncapped(start));
      // Each placement lands the target pass where it is meant to.
      const targetKey = instants(target);
      if (boundary === 'mid-pass') {
        expect(first.out.passes.map(instants).at(-1), boundary).toBe(targetKey);
      }
      if (boundary === 'rise before resume') {
        expect(rest.out.passes.map(instants)[0], boundary).toBe(targetKey);
        expect(Date.parse(target.rise_utc)).toBeLessThan(Date.parse(resume.start));
      }
    }
  });

  it('names a continuation only while its start stays inside the epoch horizon', async () => {
    /**
     * The ISS fixture's epoch is 2024-01-01T12:00Z and the horizon is 30 days. A window
     * whose resume instant lands exactly 30 days out still names it, and that call
     * succeeds; one 30 s later names no start, since that call fails time_out_of_range and
     * its recovery cannot reach the remaining days.
     */
    const cases = [
      { start: '2024-01-21T11:59:30Z', resume: '2024-01-31T12:00:00.000Z', inRange: true },
      { start: '2024-01-21T12:00:00Z', resume: '2024-01-31T12:00:30.000Z', inRange: false },
    ];
    for (const { start, resume, inRange } of cases) {
      stubFetch(ISS_ELEMENTS);
      const { result, out } = await call({ days: 14, start });
      const windowEnd = new Date(Date.parse(resume) - 30_000).toISOString();
      const expected = inRange
        ? `Searched 10 of the 14 requested days (10 per call), through ${windowEnd}. Re-call with start ${resume} and days 4 for the rest.`
        : `Searched 10 of the 14 requested days (10 per call), through ${windowEnd}. The remaining 4 days start more than about a month from the element set's epoch, where it no longer describes the orbit, so no call can search them.`;
      expect(out.notice, start).toBe(expected);
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text, start).toContain(expected);

      // What the continuation from that instant does: succeeds inside, fails beyond.
      stubFetch(ISS_ELEMENTS);
      const next = await runToolContract(getSatellitePassesTool, {
        norad_id: 25544,
        ...SEATTLE,
        start: resume,
        days: 4,
      });
      if (inRange) {
        expect(next.isError, start).toBeFalsy();
      } else {
        expect(errorEnvelope(next)?.data?.reason, start).toBe('time_out_of_range');
      }
    }
  });

  it('names the whole remainder at the ceiling', async () => {
    stubFetch(ISS_ELEMENTS);
    const { out } = await call({ days: 30, start: '2024-01-01T00:00:00Z' });
    expect(out.notice).toBe(
      'Searched 10 of the 30 requested days (10 per call), through 2024-01-11T00:00:00.000Z. Re-call with start 2024-01-11T00:00:30.000Z and days 20 for the rest.',
    );
  });

  it('adds no notice at or under the cap', async () => {
    for (const days of [1, 10]) {
      stubFetch(ISS_ELEMENTS);
      const { out } = await call({ days, start: '2024-01-01T00:00:00Z' });
      expect('notice' in out, `days ${days}`).toBe(false);
    }
  });

  it('accepts days through the ceiling of 30 and rejects 31, 0, and a non-integer', () => {
    const parse = (days: unknown) =>
      getSatellitePassesTool.input.safeParse({ norad_id: 25544, ...SEATTLE, days }).success;
    expect(parse(30)).toBe(true);
    expect(parse(11)).toBe(true);
    expect(parse(31)).toBe(false);
    expect(parse(0)).toBe(false);
    expect(parse(2.5)).toBe(false);
  });

  it('states the per-call cap and the ceiling on the days input', () => {
    const days = toJSONSchema(getSatellitePassesTool.input).properties?.days as {
      description?: string;
      maximum?: number;
    };
    expect(days.maximum).toBe(30);
    expect(days.description).toContain(
      'At most 10 are searched per call; a value up to 30 searches the first 10',
    );
  });
});

describe('astronomy_get_satellite_passes — error contracts', () => {
  it('fails tle_not_found when CelesTrak has no element set', async () => {
    stubFetch('No GP data found');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 99999, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('tle_not_found');
    expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('fails tle_not_found on an empty CelesTrak body', async () => {
    stubFetch('   ');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 99999, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('tle_not_found');
  });

  it('maps a CelesTrak 404 to tle_not_found without leaking HTTP internals', async () => {
    // CelesTrak answers a missing object with HTTP 404 (not a 200 sentinel), so
    // fetchWithTimeout throws a NotFound McpError carrying the status and raw body
    // in its data. The service must reclassify into the typed contract with
    // leak-free data — no statusCode/responseBody/url/requestId.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('No GP data found', { status: 404 })),
    );
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 999999, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('tle_not_found');
    expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err?.data).toEqual({
      reason: 'tle_not_found',
      recovery: { hint: expect.stringContaining('celestrak.org') },
    });
  });

  it('fails celestrak_unavailable when the response is not a parsable TLE', async () => {
    stubFetch('some text that is neither an error sentinel nor a two-line element set');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('celestrak_unavailable');
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('maps a CelesTrak HTTP failure to celestrak_unavailable without leaking HTTP internals', async () => {
    // A 5xx (not a 404, not a 200 sentinel) reaches the fetch catch as a status-mapped
    // McpError carrying the URL, statusCode, and raw body. classifyFetchError must map
    // it to the typed contract with leak-free data — internals stay on `cause` only.
    stubFetchThrowsUpstream();
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err?.data).toEqual({
      reason: 'celestrak_unavailable',
      recovery: { hint: expect.stringContaining('retry') },
    });
    expectNoUpstreamLeak(err?.data);
  });

  it('maps a CelesTrak fetch timeout to celestrak_unavailable, not tle_not_found', async () => {
    // classifyFetchError branches only on NotFound; a Timeout must fall through to
    // the unavailable arm rather than being read as "no such object".
    stubFetchThrowsTimeout();
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err?.data).toEqual({
      reason: 'celestrak_unavailable',
      recovery: { hint: expect.stringContaining('retry') },
    });
    expectNoUpstreamLeak(err?.data);
  });

  it('fails object_decayed instead of returning an empty pass list for a decayed object', async () => {
    // SGP4 refuses an element set that no longer describes an orbit by answering null,
    // and the scan loop used to swallow that per timestep, so the caller saw
    // `passes: []`, indistinguishable from "nothing visible in this window". The window
    // sits inside the element set's own validity horizon, so the object is what changed.
    stubFetch(DECAYED_ELEMENTS);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 88888,
      ...SEATTLE,
      days: 3,
      start: '2020-01-15T00:00:00Z',
    });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err).toBeInstanceOf(McpError);
    expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err?.data?.reason).toBe('object_decayed');
    expect(err?.data?.recovery?.hint).toMatch(/still in orbit/i);
    expect(err?.message).toContain('88888');
  });

  it('blames the start, not the object, when it lies beyond the element set epoch', async () => {
    // Rejected on the epoch distance alone, before any propagation is attempted —
    // reporting it as a decay would be a false statement with a recovery the caller
    // cannot act on for a satellite that may well still be in orbit; the actionable
    // fact is that the element set does not reach that far.
    stubFetch(ISS_ELEMENTS);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      days: 3,
      start: '2040-01-01T00:00:00Z',
    });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err).toBeInstanceOf(McpError);
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(err?.message).not.toMatch(/decayed/i);
    expect(err?.data?.recovery?.hint).toMatch(/epoch/i);
  });

  /**
   * Sixty days past the ISS fixture's epoch of 2024-01-01T12:00Z: twice the horizon the
   * tool documents, far enough out that the mean elements have stopped describing the
   * orbit, and — the part that makes it the decisive case — close enough that SGP4 still
   * answers with a well-formed state vector. The sixteen-year start above trips the
   * propagation probe as well, so it cannot tell an epoch-distance guard apart from the
   * probe that used to gate one.
   */
  const EPOCH_DISTANT_START = '2024-03-01T12:00:00Z';
  /** The same distance on the other side of the epoch, which the horizon is symmetric about. */
  const EPOCH_DISTANT_START_BEFORE = '2023-11-02T12:00:00Z';
  /** Exactly MAX_EPOCH_DISTANCE_DAYS out — the last instant inside the horizon. */
  const EPOCH_HORIZON_START = '2024-01-31T12:00:00Z';

  it('propagates the epoch-distant start rather than refusing it', () => {
    // Characterization of the propagator, not of the tool: SGP4 keeps returning
    // numerically well-formed positions from mean elements that stopped describing the
    // real orbit weeks earlier. That is why a horizon check gated behind a null
    // propagation never ran for the requests it exists to catch, and why the rejection
    // tests below prove anything at all. If satellite.js ever starts refusing this
    // instant they would degrade into a re-test of the probe, and this assertion is what
    // says so.
    const record = OmmResponseSchema.parse(JSON.parse(ISS_ELEMENTS))[0];
    if (!record) throw new Error('The ISS fixture carries no element set.');
    const satrec = json2satrec(record);
    for (const instant of [EPOCH_DISTANT_START, EPOCH_DISTANT_START_BEFORE]) {
      const pv = propagate(satrec, new Date(instant), { communityDecayCheckEnabled: true });
      expect(pv).not.toBeNull();
      expect(Number.isFinite(pv?.position.x)).toBe(true);
    }
  });

  it('rejects a start past the epoch horizon that SGP4 would still have propagated', async () => {
    // The reported defect: a confident, fully-formed pass list built on elements SGP4 has
    // no basis to trust that far from epoch. Which of the two 200-shaped answers appeared
    // — fabricated passes or a falsely-empty list — varied with the element set's drag
    // terms, so neither is what this pins; what the horizon promises is a named rejection.
    stubFetch(ISS_ELEMENTS);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      days: 3,
      start: EPOCH_DISTANT_START,
    });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err).toBeInstanceOf(McpError);
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('time_out_of_range');
    // The distance is the actionable fact — it says how far the start has to move.
    expect(err?.message).toContain('60 days');
    expect(err?.message).toContain('25544');
    expect(err?.message).not.toMatch(/decayed/i);
    expect(err?.data?.recovery?.hint).toMatch(/epoch/i);
  });

  it('rejects a start the same distance before the epoch', async () => {
    // The horizon is symmetric about the epoch: an element set describes the orbit for
    // weeks on either side of it, so a start in the past overreaches it the same way.
    stubFetch(ISS_ELEMENTS);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      days: 3,
      start: EPOCH_DISTANT_START_BEFORE,
    });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(err?.message).toContain('60 days');
  });

  it('scans a start sitting exactly on the epoch horizon', async () => {
    // Characterization of the boundary: the guard compares with `>`, so a start exactly
    // MAX_EPOCH_DISTANCE_DAYS out is admitted rather than rejected. A guard that
    // overshot by a step would withdraw a window the tool documents as in range.
    // The equality holds exactly here only because this fixture's epoch sits on a clean
    // Julian half-day and survives the `jdsatepoch` round-trip unchanged; a real element
    // set's fractional epoch shifts the distance by ~0.01 ms, so which side of the
    // boundary an exactly-30-day start lands on is decided by that residue. Immaterial
    // against a horizon the tool documents as "about a month" — but it is why this pins
    // the comparison operator and not a promise about the 30-day instant itself.
    stubFetch(ISS_ELEMENTS);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      days: 1,
      start: EPOCH_HORIZON_START,
    });
    const result = await getSatellitePassesTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(getSatellitePassesTool.output));
    expect(result.norad_id).toBe(25544);
  });

  it('carries the epoch-horizon rejection to structuredContent and content[] alike', async () => {
    // structuredContent-only clients read data.recovery.hint, format()-only clients read
    // the Recovery: line. The service overrides the declared hint with one naming the
    // epoch, so both surfaces have to carry that override rather than the contract's.
    stubFetch(ISS_ELEMENTS);
    const result = await runToolContract(getSatellitePassesTool, {
      norad_id: 25544,
      ...SEATTLE,
      days: 3,
      start: EPOCH_DISTANT_START,
    });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.data?.reason).toBe('time_out_of_range');
    const hint = errorEnvelope(result)?.data?.recovery?.hint;
    expect(hint).toMatch(/epoch/i);
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
    expect(firstText(result)).toContain('60 days');
  });

  it('rejects a non-positive NORAD id at schema validation', () => {
    expect(() => getSatellitePassesTool.input.parse({ norad_id: 0, ...SEATTLE })).toThrow();
  });

  it('rejects a non-integer NORAD id', () => {
    expect(() => getSatellitePassesTool.input.parse({ norad_id: 25544.5, ...SEATTLE })).toThrow();
  });

  it('rejects an unparseable start with invalid_time instead of a false empty result', async () => {
    // Bare new Date('not-a-date') is an Invalid Date; SGP4 turns it into NaN positions so
    // every candidate pass fails the elevation/sunlit filters — a silent, falsely-successful
    // "0 passes". resolveTime() must reject it up front, before any TLE fetch or propagation.
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      start: 'not-a-date',
    });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_time');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a start outside the 1900–2100 span with time_out_of_range', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      start: '1850-01-01T00:00:00Z',
    });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('time_out_of_range');
    expect(fetchSpy).not.toHaveBeenCalled();
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

/**
 * The `retryable` flag a definition declares for one of its contract reasons — the
 * field a client reads to decide whether a failure is worth trying again. Absent is
 * "infer from the code", which for a non-transient code means do not retry.
 */
function declaredRetryable(
  errors: readonly ErrorContract[] | undefined,
  reason: string,
): boolean | undefined {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No contract entry declares reason "${reason}".`);
  return entry.retryable;
}

describe('astronomy_get_satellite_passes — invalid_time recovery reaches both surfaces', () => {
  it('carries the declared hint in structuredContent and in content[] text', async () => {
    // Clients split on which surface they forward: structuredContent-only clients read
    // data.recovery.hint, format()-only clients read the Recovery: line. A hint on one
    // surface and not the other leaves half the clients with no next move.
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runToolContract(getSatellitePassesTool, {
      norad_id: 25544,
      ...SEATTLE,
      start: 'not-a-date',
    });
    const hint = declaredRecovery(getSatellitePassesTool.errors, 'invalid_time');

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.data?.reason).toBe('invalid_time');
    expect(errorEnvelope(result)?.data?.recovery?.hint).toBe(hint);
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['before 1900', '1850-01-01T00:00:00Z', '1850-01-01T00:00:00.000Z'],
    ['past 2100', '2101-01-01T00:00:00Z', '2101-01-01T00:00:00.000Z'],
  ])(
    'sends the declared time_out_of_range hint for a start %s, on both surfaces',
    async (_side, start, echoed) => {
      /**
       * The shared resolver rejects a start outside 1900–2100. A hint to pick a date inside
       * that span would fail again here on the element set's epoch distance, so this tool
       * sends its declared recovery — which covers both checks — while the message keeps
       * naming the span the start fell outside.
       */
      const fetchSpy = vi.fn(
        async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const result = await runToolContract(getSatellitePassesTool, {
        norad_id: 25544,
        ...SEATTLE,
        start,
      });
      const hint = declaredRecovery(getSatellitePassesTool.errors, 'time_out_of_range');
      const message = `Time ${echoed} is outside the high-accuracy span (1900–2100).`;

      expect(result.isError).toBe(true);
      expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(errorEnvelope(result)?.data?.reason).toBe('time_out_of_range');
      expect(errorEnvelope(result)?.message).toBe(message);
      expect(errorEnvelope(result)?.data?.recovery?.hint).toBe(hint);
      expect(firstText(result)).toContain(message);
      expect(firstText(result)).toContain(`Recovery: ${hint}`);
      expect(firstText(result)).not.toContain('Use a date between 1900 and 2100');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('rejects an impossible calendar date in start before any TLE fetch', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      start: '2026-02-30T00:00:00Z',
    });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.reason).toBe('invalid_time');
    expect(err?.data?.recovery?.hint).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('astronomy_get_ephemeris — calendar validity without a year range', () => {
  /** A one-row Horizons block, enough for the handler to return a parsed point. */
  function stubOnePoint(): ReturnType<typeof vi.fn> {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          horizonsGeocentric([
            '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 9.50, 5.0, 1.500000, 0.0',
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  it.each(['2026-02-30T00:00:00Z', '2023-02-29T00:00:00Z', '2026-04-31T00:00:00Z'])(
    'rejects the impossible start %s with invalid_time',
    async (start) => {
      const fetchSpy = stubOnePoint();
      const result = await runToolContract(getEphemerisTool, { designation: '433;', start });
      const err = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err?.data?.reason).toBe('invalid_time');
      expect(err?.data?.recovery?.hint).toBeTruthy();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('rejects an impossible stop with invalid_time', async () => {
    const fetchSpy = stubOnePoint();
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2026-02-01T00:00:00Z',
      stop: '2026-02-30T00:00:00Z',
    });
    const err = await captureRejected(() => getEphemerisTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('invalid_time');
    expect(err?.message).toContain('stop');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * Horizons covers epochs far outside the in-process engine's 1900–2100 high-accuracy
   * span, so this tool deliberately validates parseability and calendar validity only.
   * Tightening calendar validity must not smuggle in a year range.
   */
  it.each([
    ['1850-01-01T00:00:00Z', '1850-01-02T00:00:00Z'],
    ['2200-01-01T00:00:00Z', '2200-01-02T00:00:00Z'],
    ['+002026-01-01T00:00:00Z', '+002026-01-02T00:00:00Z'],
  ])('accepts the out-of-engine-span span %s → %s', async (start, stop) => {
    const fetchSpy = stubOnePoint();
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', start, stop });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result.points).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('accepts a real leap day on both ends of the span', async () => {
    const fetchSpy = stubOnePoint();
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2000-02-29T00:00:00Z',
      stop: '2024-02-29T00:00:00Z',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result.points).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalled();
  });
});

/**
 * A live-shaped OMM record for a six-digit catalog object, transcribed from
 * `gp.php?CATNR=100269&FORMAT=JSON`. CelesTrak refuses to serve this object as TLE at
 * all — the legacy format cannot encode a catalog number above 99999 — so the JSON
 * element set is the only one there is.
 */
const STARLINK_OMM = JSON.stringify([
  {
    OBJECT_NAME: 'STARLINK-38255',
    OBJECT_ID: '2026-181Z',
    EPOCH: '2026-08-18T06:06:04.961376',
    MEAN_MOTION: 15.81947338,
    ECCENTRICITY: 9.836e-5,
    INCLINATION: 97.2823,
    RA_OF_ASC_NODE: 272.1614,
    ARG_OF_PERICENTER: 152.0908,
    MEAN_ANOMALY: 208.0413,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 100269,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 271,
    BSTAR: -0.0032427123,
    MEAN_MOTION_DOT: -0.00610774,
    MEAN_MOTION_DDOT: 0,
  },
]);

/**
 * Build a candidate set the way a broad `NAME=` substring query returns one — CelesTrak
 * matches case-insensitively anywhere in `OBJECT_NAME`, so an ordinary query resolves to
 * thousands of objects. `noradIds` overrides the default ascending run so a fixture can
 * arrive in an order other than the one the candidate list must come back in.
 */
function ommCandidates(
  names: readonly string[],
  firstNoradId = 44714,
  noradIds?: readonly number[],
): string {
  return JSON.stringify(
    names.map((name, i) => ({
      OBJECT_NAME: name,
      OBJECT_ID: `2026-${100 + i}A`,
      EPOCH: '2026-08-18T06:06:04.961376',
      MEAN_MOTION: 15.81947338,
      ECCENTRICITY: 9.836e-5,
      INCLINATION: 97.2823,
      RA_OF_ASC_NODE: 272.1614,
      ARG_OF_PERICENTER: 152.0908,
      MEAN_ANOMALY: 208.0413,
      EPHEMERIS_TYPE: 0,
      CLASSIFICATION_TYPE: 'U',
      NORAD_CAT_ID: noradIds?.[i] ?? firstNoradId + i,
      ELEMENT_SET_NO: 999,
      REV_AT_EPOCH: 271,
      BSTAR: -0.0032427123,
      MEAN_MOTION_DOT: -0.00610774,
      MEAN_MOTION_DDOT: 0,
    })),
  );
}

describe('astronomy_get_satellite_passes — six-digit catalog numbers', () => {
  it('asks CelesTrak for JSON, the only format that carries six-digit objects', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      start: '2024-01-01T00:00:00Z',
    });
    await getSatellitePassesTool.handler(input, ctx);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('CATNR=25544');
    expect(url).toContain('FORMAT=JSON');
    expect(url).not.toContain('FORMAT=TLE');
  });

  it('predicts passes for a six-digit catalog object instead of reporting it uncatalogued', async () => {
    stubFetch(STARLINK_OMM);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 100269,
      ...SEATTLE,
      days: 3,
      start: '2026-08-18T00:00:00Z',
    });
    const result = await getSatellitePassesTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(getSatellitePassesTool.output));
    expect(result.norad_id).toBe(100269);
    expect(result.satellite_name).toBe('STARLINK-38255');
    expect(result.passes.length).toBeGreaterThan(0);
  });

  it('fails celestrak_unavailable on a 200 body that is neither JSON nor a miss sentinel', async () => {
    stubFetch('<html>CelesTrak is down for maintenance</html>');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('celestrak_unavailable');
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('fails tle_not_found on an empty JSON array under a 200', async () => {
    stubFetch('[]');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 99999, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('tle_not_found');
  });
});

describe('astronomy_get_satellite_passes — name resolution', () => {
  it('resolves a name matching exactly one object and predicts its passes', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      name: 'ISS (ZARYA)',
      ...SEATTLE,
      days: 3,
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getSatellitePassesTool.handler(input, ctx);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain(`NAME=${encodeURIComponent('ISS (ZARYA)')}`);
    expect(url).toContain('FORMAT=JSON');
    // One round trip: a single-match NAME= response already carries the element set.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.norad_id).toBe(25544);
    expect(result.satellite_name).toBe('ISS (ZARYA)');
    expect(result.resolved_from_name).toBe('ISS (ZARYA)');
    // Identical geometry to the norad_id path — the input path does not change the orbit.
    expect(result.passes).toEqual(ISS_BASELINE_PASSES.map(approximately));
  });

  it('fails satellite_name_not_found, not tle_not_found, when no object carries the name', async () => {
    stubFetch('No GP data found');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ name: 'nonexistentxyz123', ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('satellite_name_not_found');
    expect(err?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err?.data?.recovery?.hint).toBe(
      declaredRecovery(getSatellitePassesTool.errors, 'satellite_name_not_found'),
    );
  });

  it('caps an ambiguous candidate list and discloses how many were left out', async () => {
    // A realistically broad query: NAME=STARLINK matched 10,930 current objects live.
    const names = Array.from({ length: 10_930 }, (_, i) => `STARLINK-${1000 + i}`);
    stubFetch(ommCandidates(names));
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ name: 'STARLINK', ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('ambiguous_satellite_name');
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    const data = err?.data as unknown as {
      candidates?: { name: string; norad_id: number }[];
      match_count?: number;
      shown?: number;
      truncated?: boolean;
    };
    expect(data.match_count).toBe(10_930);
    expect(data.shown).toBe(data.candidates?.length);
    expect(data.truncated).toBe(true);
    expect(data.shown).toBe(20);
    expect(data.candidates?.length).toBe(20);
    // The count reaches a content[]-only client too, which reads the message and hint.
    expect(err?.message).toContain('10930');
    /**
     * A truncated list is a slice, so the hint must lead with narrowing rather than with
     * the declared "pick one of the listed candidates" — following that against a
     * constellation query yields a confident prediction for an arbitrary member.
     */
    expect(err?.data?.recovery?.hint).toMatch(/^Supply a longer, more specific name/);
    expect(err?.data?.recovery?.hint).not.toBe(
      declaredRecovery(getSatellitePassesTool.errors, 'ambiguous_satellite_name'),
    );
  });

  it('lists every candidate, with no truncation claim, when the match set fits the cap', async () => {
    // Served out of catalog order, so the ascending order the candidates come back in is
    // the service's doing rather than the upstream response's. The query is a substring of
    // all four names; "Hubble" itself now resolves through the alias table instead.
    stubFetch(
      ommCandidates(
        ['HUBBLE 7', 'HUBBLE 6', 'LEMUR-2-HUBBLE-5', 'LEMUR-2-HUBBLE-4'],
        64562,
        [64564, 64562, 64565, 64563],
      ),
    );
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ name: 'UBBLE', ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('ambiguous_satellite_name');
    const data = err?.data as unknown as {
      candidates?: { name: string; norad_id: number }[];
      match_count?: number;
      truncated?: boolean;
    };
    expect(data.match_count).toBe(4);
    expect(data.truncated).toBe(false);
    expect(data.candidates).toEqual([
      { name: 'HUBBLE 6', norad_id: 64562 },
      { name: 'LEMUR-2-HUBBLE-4', norad_id: 64563 },
      { name: 'HUBBLE 7', norad_id: 64564 },
      { name: 'LEMUR-2-HUBBLE-5', norad_id: 64565 },
    ]);
    expect(err?.message).toContain('HUBBLE 6 (64562)');
    // A complete list is something to pick from, so it keeps the declared hint.
    expect(err?.data?.recovery?.hint).toBe(
      declaredRecovery(getSatellitePassesTool.errors, 'ambiguous_satellite_name'),
    );
  });

  it('rejects supplying both norad_id and name before any CelesTrak request', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runToolContract(getSatellitePassesTool, {
      norad_id: 25544,
      name: 'ISS (ZARYA)',
      ...SEATTLE,
    });
    const err = errorEnvelope(result);
    expect(result.isError).toBe(true);
    expect(err?.data?.reason).toBe('invalid_target');
    expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err?.data?.recovery?.hint).toBe(
      declaredRecovery(getSatellitePassesTool.errors, 'invalid_target'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects supplying neither norad_id nor name before any CelesTrak request', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('invalid_target');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/** The catalog name CelesTrak serves for each object the alias table points at. */
const ALIASED_OBJECTS: Record<number, string> = {
  25544: 'ISS (ZARYA)',
  20580: 'HST',
  48274: 'CSS (TIANHE)',
};

/**
 * Answer each `CATNR=` query with that object's element set and fail anything else, so a
 * test proves which lookup the alias path took rather than whatever a canned body allows.
 */
function stubCatalogByNumber(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string | URL) => {
    const catnr = Number(paramsOf(url).get('CATNR'));
    const name = ALIASED_OBJECTS[catnr];
    if (!name) return new Response('No GP data found', { status: 404 });
    return new Response(ommCandidates([name], catnr), { status: 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('astronomy_get_satellite_passes — well-known name aliases', () => {
  it.each([
    ['iss', 25544],
    ['international space station', 25544],
    ['hubble', 20580],
    ['hubble space telescope', 20580],
    ['hst', 20580],
    ['tiangong', 48274],
    ['css', 48274],
    ['chinese space station', 48274],
  ])('resolves "%s" to NORAD %i by catalog number, not by a NAME= search', async (alias, id) => {
    const fetchSpy = stubCatalogByNumber();
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      name: alias,
      ...SEATTLE,
      days: 1,
      start: '2026-08-18T00:00:00Z',
    });
    const result = await getSatellitePassesTool.handler(input, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain(`CATNR=${id}`);
    expect(url).not.toContain('NAME=');
    expect(result.norad_id).toBe(id);
    expect(result.satellite_name).toBe(ALIASED_OBJECTS[id]);
    expect(result.resolved_from_name).toBe(alias);
  });

  it.each([
    ['ISS', 25544],
    ['  Hubble  ', 20580],
    ['HST', 20580],
    ['International Space Station', 25544],
    ['\tTiangong\n', 48274],
    ['CSS', 48274],
  ])(
    'normalizes case and surrounding whitespace in %j before the alias lookup',
    async (name, id) => {
      const fetchSpy = stubCatalogByNumber();
      const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
      const input = getSatellitePassesTool.input.parse({
        name,
        ...SEATTLE,
        days: 1,
        start: '2026-08-18T00:00:00Z',
      });
      const result = await getSatellitePassesTool.handler(input, ctx);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(`CATNR=${id}`);
      expect(result.norad_id).toBe(id);
      // The echo is the caller's query with its surrounding whitespace trimmed, as before.
      expect(result.resolved_from_name).toBe(name.trim());
    },
  );

  it('carries an alias-resolved object through structuredContent and content[] alike', async () => {
    stubCatalogByNumber();
    const result = await runToolContract(getSatellitePassesTool, {
      name: 'Tiangong',
      ...SEATTLE,
      days: 1,
      start: '2026-08-18T00:00:00Z',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      norad_id?: number;
      resolved_from_name?: string;
      satellite_name?: string;
    };
    expect(structured.norad_id).toBe(48274);
    expect(structured.satellite_name).toBe('CSS (TIANHE)');
    expect(structured.resolved_from_name).toBe('Tiangong');
    expect(firstText(result)).toContain('CSS (TIANHE) (NORAD 48274)');
    expect(firstText(result)).toContain('Resolved from the name query "Tiangong"');
  });

  it('reuses the catalog-number cache for an alias, so a repeat call does not refetch', async () => {
    const fetchSpy = stubCatalogByNumber();
    const input = getSatellitePassesTool.input.parse({
      name: 'ISS',
      ...SEATTLE,
      days: 1,
      start: '2026-08-18T00:00:00Z',
    });
    await getSatellitePassesTool.handler(
      input,
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    await getSatellitePassesTool.handler(
      getSatellitePassesTool.input.parse({ ...input, name: undefined, norad_id: 25544 }),
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports tle_not_found naming the catalog number when an aliased object has no element set', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response('No GP data found', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ name: 'Tiangong', ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('tle_not_found');
    expect(err?.message).toContain('48274');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('CATNR=48274');
  });

  it.each(['STARLINK', 'ISS (ZARYA)', 'issx', 'hubble 6'])(
    'keeps %j, which is not an alias, on the CelesTrak NAME= path',
    async (name) => {
      const fetchSpy = vi.fn(
        async (_url: string | URL) => new Response(ommCandidates([name]), { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
      const input = getSatellitePassesTool.input.parse({
        name,
        ...SEATTLE,
        days: 1,
        start: '2026-08-18T00:00:00Z',
      });
      await getSatellitePassesTool.handler(input, ctx);
      const url = String(fetchSpy.mock.calls[0]?.[0]);
      expect(url).toContain(`NAME=${encodeURIComponent(name)}`);
      expect(url).not.toContain('CATNR=');
    },
  );

  it('names the aliases in the tool and name descriptions', () => {
    const nameDescription = getSatellitePassesTool.input.shape.name.description ?? '';
    for (const text of [getSatellitePassesTool.description, nameDescription]) {
      expect(text).toMatch(/Hubble/);
      expect(text).toMatch(/Tiangong/);
    }
  });
});

describe('astronomy_get_satellite_passes — name resolution on both client surfaces', () => {
  it('carries the resolved object through structuredContent and content[] alike', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 })),
    );
    const result = await runToolContract(getSatellitePassesTool, {
      name: 'ISS (ZARYA)',
      ...SEATTLE,
      days: 3,
      start: '2024-01-01T00:00:00Z',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      norad_id?: number;
      resolved_from_name?: string;
      satellite_name?: string;
    };
    expect(structured.norad_id).toBe(25544);
    expect(structured.satellite_name).toBe('ISS (ZARYA)');
    expect(structured.resolved_from_name).toBe('ISS (ZARYA)');
    // A content[]-only client must be able to read the same three facts.
    expect(firstText(result)).toContain('ISS (ZARYA) (NORAD 25544)');
    expect(firstText(result)).toContain('Resolved from the name query "ISS (ZARYA)"');
  });

  it('puts the candidate list and the match count on both surfaces of the ambiguity error', async () => {
    stubFetch(ommCandidates(['NOAA 15', 'NOAA 16', 'NOAA 17'], 25338));
    const result = await runToolContract(getSatellitePassesTool, { name: 'NOAA 1', ...SEATTLE });
    const hint = declaredRecovery(getSatellitePassesTool.errors, 'ambiguous_satellite_name');

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.data?.reason).toBe('ambiguous_satellite_name');
    expect(errorEnvelope(result)?.data?.recovery?.hint).toBe(hint);
    expect(errorEnvelope(result)?.message).toContain('NOAA 15 (25338)');
    // structuredContent-only clients read the structured candidates…
    const envelopeData = errorEnvelope(result)?.data as unknown as { candidates?: unknown[] };
    expect(envelopeData.candidates).toHaveLength(3);
    // …and content[]-only clients read the same objects out of the message plus the hint.
    expect(firstText(result)).toContain('NOAA 15 (25338)');
    expect(firstText(result)).toContain('NOAA 17 (25340)');
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
  });
});

describe('astronomy_get_satellite_passes — name resolution edge cases', () => {
  it('resolves a name that is one match’s whole name even when longer names contain it', async () => {
    // CelesTrak matches NAME= as a substring, so "NOAA 1" also returns NOAA 10..19. A
    // caller that typed a catalog name in full asked for that object, not for its
    // namesakes.
    stubFetch(ommCandidates(['NOAA 1', 'NOAA 10', 'NOAA 11'], 4793));
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      name: 'noaa 1',
      ...SEATTLE,
      start: '2026-08-18T00:00:00Z',
    });
    const result = await getSatellitePassesTool.handler(input, ctx);
    expect(result.norad_id).toBe(4793);
    expect(result.satellite_name).toBe('NOAA 1');
    expect(result.resolved_from_name).toBe('noaa 1');
  });

  it('stays ambiguous when two objects share the queried name outright', async () => {
    stubFetch(ommCandidates(['NOAA 7 DEB', 'NOAA 7 DEB'], 12559));
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ name: 'NOAA 7 DEB', ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('ambiguous_satellite_name');
  });

  it('caches a resolved name so a second call within the TTL does not refetch', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const input = getSatellitePassesTool.input.parse({
      name: 'ISS (ZARYA)',
      ...SEATTLE,
      days: 1,
      start: '2024-01-01T00:00:00Z',
    });
    await getSatellitePassesTool.handler(
      input,
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    await getSatellitePassesTool.handler(
      input,
      createMockContext({ errors: getSatellitePassesTool.errors }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a blank name from a form client as no name at all, not a catalog-wide query', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      name: '   ',
      ...SEATTLE,
      days: 1,
      start: '2024-01-01T00:00:00Z',
    });
    const result = await getSatellitePassesTool.handler(input, ctx);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('CATNR=25544');
    expect(result.resolved_from_name).toBeUndefined();
  });

  it('url-encodes a name carrying spaces and parentheses', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ISS_ELEMENTS, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      name: '  ISS (ZARYA)  ',
      ...SEATTLE,
      start: '2024-01-01T00:00:00Z',
    });
    await getSatellitePassesTool.handler(input, ctx);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('NAME=ISS%20(ZARYA)');
  });

  it('format() renders the resolving name query alongside the pass list', () => {
    const block = getSatellitePassesTool.format!({
      norad_id: 25544,
      satellite_name: 'ISS (ZARYA)',
      resolved_from_name: 'ISS',
      passes: [],
    })[0];
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('ISS (ZARYA) (NORAD 25544)');
    expect(text).toContain('Resolved from the name query "ISS".');
    expect(text).toMatch(/No visible passes/i);
  });

  it('format() heading agrees in number with the pass count', () => {
    const pass = {
      rise_utc: '2024-01-01T03:00:00.000Z',
      rise_azimuth_degrees: 300,
      peak_utc: '2024-01-01T03:05:00.000Z',
      peak_altitude_degrees: 50,
      peak_azimuth_degrees: 210,
      set_utc: '2024-01-01T03:10:00.000Z',
      set_azimuth_degrees: 120,
      duration_seconds: 600,
      sunlit: true,
      visible_start_utc: '2024-01-01T03:00:00.000Z',
      visible_end_utc: '2024-01-01T03:10:00.000Z',
      visible_start_altitude_degrees: 0,
      visible_end_altitude_degrees: 0,
      visible_start_azimuth_degrees: 300,
      visible_end_azimuth_degrees: 120,
    };
    const heading = (passes: (typeof pass)[]) => {
      const block = getSatellitePassesTool.format!({ norad_id: 25544, passes })[0];
      return (block && block.type === 'text' ? block.text : '').split('\n')[0];
    };
    expect(heading([pass])).toBe('## (NORAD 25544) — 1 visible pass');
    expect(heading([pass, pass])).toBe('## (NORAD 25544) — 2 visible passes');
    expect(heading([])).toBe('## (NORAD 25544) — 0 visible passes');
  });
});

/**
 * The ISS element set with one required OMM field dropped — a well-formed 200 whose GP
 * record parses as JSON but does not match `OmmRecordSchema`. Built from the live-shaped
 * fixture rather than hand-written, so the record stays valid in every other respect:
 * what makes it fail is the one named field and nothing else, and if the schema stopped
 * requiring that field the call would succeed and the tests below would fail.
 */
function ommWithout(field: string, source: string = ISS_ELEMENTS): string {
  const records = JSON.parse(source) as Record<string, unknown>[];
  for (const record of records) delete record[field];
  return JSON.stringify(records);
}

describe('astronomy_get_satellite_passes — a record that fails OMM validation is not an outage', () => {
  it('fails malformed_element_set, not celestrak_unavailable, for a GP record missing a required field', async () => {
    // The body is a 200 carrying JSON CelesTrak really served; only the OMM shape is
    // wrong. Nothing about that is transient — the same request returns the same record
    // — so the outage reason, whose whole guidance is "retry in a few minutes", would
    // send the caller into a loop that can only fail again.
    stubFetch(ommWithout('OBJECT_ID'));
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('malformed_element_set');
    expect(err?.code).toBe(JsonRpcErrorCode.SerializationError);
    // The message names the record that did not validate, and the field that did it.
    expect(err?.message).toContain('NORAD ID 25544');
    expect(err?.message).toContain('OBJECT_ID');
    // …without handing the client the validator's own vocabulary.
    expect(err?.message).not.toMatch(/zod|invalid_type|expected|received|issues/i);
    // data carries the contract pair and nothing else — no issue list, no upstream body.
    expect(err?.data).toEqual({
      reason: 'malformed_element_set',
      recovery: { hint: declaredRecovery(getSatellitePassesTool.errors, 'malformed_element_set') },
    });
  });

  it('declares the schema failure non-retryable and the outage retryable', () => {
    // The two arms differ in exactly one client-visible way: whether retrying is worth
    // anything. A shared reason cannot express that, which is why the split exists.
    expect(declaredRetryable(getSatellitePassesTool.errors, 'malformed_element_set')).not.toBe(
      true,
    );
    expect(declaredRetryable(getSatellitePassesTool.errors, 'celestrak_unavailable')).toBe(true);
  });

  it('keeps a body that is not GP data at all on the retryable outage arm', async () => {
    // Characterization: an HTML maintenance page is a genuine CelesTrak failure and must
    // stay retryable. The fix narrows what the outage reason covers, not what it means.
    stubFetch('<html>CelesTrak is down for maintenance</html>');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('celestrak_unavailable');
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(declaredRetryable(getSatellitePassesTool.errors, 'celestrak_unavailable')).toBe(true);
  });

  it('keeps a transport failure on the retryable outage arm', async () => {
    // Characterization: nothing was parsed at all here, so the outage classification is
    // the honest one and its retry guidance is the right next move.
    stubFetchThrowsUpstream();
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe('celestrak_unavailable');
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expectNoUpstreamLeak(err?.data);
  });

  it('classifies a NAME= lookup the same way as a CATNR= one', async () => {
    // Both lookups run through the same parse, so a name query hitting a malformed
    // record must not fall back to the outage reason on the resolution path.
    const fetchSpy = vi.fn(
      async (_url: string | URL) => new Response(ommWithout('ELEMENT_SET_NO'), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ name: 'ISS (ZARYA)', ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('NAME=');
    expect(err?.data?.reason).toBe('malformed_element_set');
    expect(err?.message).toContain('ISS (ZARYA)');
    expect(err?.message).toContain('ELEMENT_SET_NO');
  });

  it('carries the hint on both client surfaces', async () => {
    // structuredContent-only clients read data.recovery.hint, format()-only clients read
    // the Recovery: line; a caller that only sees one of them still gets the same move.
    stubFetch(ommWithout('OBJECT_ID'));
    const result = await runToolContract(getSatellitePassesTool, {
      norad_id: 25544,
      ...SEATTLE,
    });
    const hint = declaredRecovery(getSatellitePassesTool.errors, 'malformed_element_set');

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(errorEnvelope(result)?.data?.reason).toBe('malformed_element_set');
    expect(errorEnvelope(result)?.data?.recovery?.hint).toBe(hint);
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
  });
});

describe('astronomy_get_satellite_passes — contract wording matches what the service throws', () => {
  it.each([
    ['tle_not_found', 'No GP data found', { norad_id: 99999 }],
    ['satellite_name_not_found', 'No GP data found', { name: 'nonexistentxyz123' }],
    ['celestrak_unavailable', '<html>not GP data</html>', { norad_id: 25544 }],
    ['malformed_element_set', ommWithout('OBJECT_ID'), { norad_id: 25544 }],
  ])('throws the declared %s recovery verbatim', async (reason, body, target) => {
    stubFetch(body);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ ...target, ...SEATTLE });
    const err = await captureRejected(() => getSatellitePassesTool.handler(input, ctx));
    expect(err?.data?.reason).toBe(reason);
    expect(err?.data?.recovery?.hint).toBe(declaredRecovery(getSatellitePassesTool.errors, reason));
  });

  it('declares norad_id and name as mutually exclusive in the emitted JSON Schema', () => {
    const json = toJSONSchema(getSatellitePassesTool.input) as {
      oneOf?: { required?: string[]; not?: { required?: string[] }; type?: string }[];
      required?: string[];
      additionalProperties?: boolean;
    };
    // Neither is required on its own — the exclusivity is what the schema states.
    expect(json.required ?? []).not.toContain('norad_id');
    expect(json.required ?? []).not.toContain('name');
    expect(json.oneOf).toEqual([
      { type: 'object', required: ['norad_id'], not: { required: ['name'] } },
      { type: 'object', required: ['name'], not: { required: ['norad_id'] } },
    ]);
    /**
     * Both constraints have to survive together. `tool()` strictens an input that
     * declares no catchall, and that rebuild drops `.meta()` — so a schema carrying
     * `additionalProperties: false` and no `oneOf` is the signature of the
     * exclusivity having been silently thrown away on the advertised surface.
     */
    expect(json.additionalProperties).toBe(false);
  });

  it('rejects an unrecognized top-level argument by name', () => {
    const result = getSatellitePassesTool.input.safeParse({ norad_id: 25544, ...SEATTLE, dayz: 3 });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
    expect(issue?.message).toContain('dayz');
  });

  it('still accepts each declared selector on its own', () => {
    expect(getSatellitePassesTool.input.safeParse({ norad_id: 25544, ...SEATTLE }).success).toBe(
      true,
    );
    expect(
      getSatellitePassesTool.input.safeParse({ name: 'ISS (ZARYA)', ...SEATTLE }).success,
    ).toBe(true);
  });
});
