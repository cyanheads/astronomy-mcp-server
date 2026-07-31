/**
 * @fileoverview Tests for the two gated, network-backed extension tools —
 *   astronomy_get_ephemeris (JPL Horizons) and astronomy_get_satellite_passes
 *   (CelesTrak TLE + SGP4). The network boundary (`fetchWithTimeout` → global
 *   `fetch`) is stubbed with canned upstream text so no live request is made; the
 *   SGP4 propagation and the Horizons CSV parse run for real against the fixtures.
 *
 *   Covers every declared `ctx.fail` reason (invalid_time, invalid_time_range,
 *   incomplete_observer, invalid_step, body_not_found, horizons_unavailable,
 *   tle_not_found, object_decayed, time_out_of_range, celestrak_unavailable), the
 *   happy-path parse, a sparse upstream payload (Horizons "n.a." magnitude → null),
 *   rows the parse cannot turn into a point (short layout, "n.a." distance, an
 *   unparseable position) being dropped and disclosed rather than shipped as a
 *   schema-invalid NaN that fails the whole call, the drop and truncation caveats
 *   composing into one notice, the truncation-disclosure enrichment as it reaches a
 *   client (domain payload merged with enrichment and parsed against the effective
 *   output schema, not the bare handler return), pass-boundary detection at all three positions of `start` relative
 *   to a rise (before, exactly on, mid-pass), the split between a decayed object and a
 *   start the element set cannot reach, observer alt/az inclusion, the TLE cache, and
 *   format() completeness including the empty-result branch.
 * @module tests/tools/extension-tools.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EphemerisOutputType,
  getEphemerisTool,
} from '@/mcp-server/tools/definitions/get-ephemeris.tool.js';
import { getSatellitePassesTool } from '@/mcp-server/tools/definitions/get-satellite-passes.tool.js';
import { initEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { initHorizonsService } from '@/services/horizons/horizons-service.js';
import { initSatelliteService } from '@/services/satellite/satellite-service.js';
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
    .extend(getEphemerisTool.enrichment)
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
      async () =>
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
      async () =>
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
    const resumeFrom = result.points.at(-1)?.time_utc;
    expect(resumeFrom).toBeTypeOf('string');
    // The notice must name the instant to resume from — the last row actually returned —
    // and keep the caller on the same step, since widening it drops samples the original
    // range asked for instead of retrieving them.
    expect(merged.notice).toContain(resumeFrom as string);
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
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data.reason).toBe('horizons_unavailable');
    expect(err.data.recovery.hint).toMatch(/distance/i);
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
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('body_not_found');
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('fails horizons_unavailable when the response has no ephemeris block', async () => {
    stubFetch('Garbled response with no SOE marker and nothing parseable.');
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433 Eros' });
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('horizons_unavailable');
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('fails horizons_unavailable when the block has no parsable rows', async () => {
    // A $$SOE/$$EOE block whose only line is too short to parse.
    stubFetch(horizonsGeocentric(['x, y']));
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433 Eros' });
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('horizons_unavailable');
  });

  it('maps a Horizons HTTP failure to horizons_unavailable without leaking HTTP internals', async () => {
    // fetchWithTimeout throws a status-mapped McpError whose data carries the request
    // URL, statusCode, and raw body. The service catches it and re-throws the typed
    // contract with leak-free data — the framework error rides only as `cause`
    // (server-side logs), never reaching the client surface.
    stubFetchThrowsUpstream();
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;' });
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toEqual({
      reason: 'horizons_unavailable',
      recovery: { hint: expect.stringContaining('retry') },
    });
    expectNoUpstreamLeak(err.data);
  });

  it('maps a Horizons fetch timeout to horizons_unavailable, not the framework Timeout code', async () => {
    stubFetchThrowsTimeout();
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;' });
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toEqual({
      reason: 'horizons_unavailable',
      recovery: { hint: expect.stringContaining('retry') },
    });
    expectNoUpstreamLeak(err.data);
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
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('invalid_time');
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
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('invalid_time');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a latitude without a longitude with incomplete_observer', async () => {
    // A lone coordinate used to fall through to a geocentric query: the observer the
    // caller supplied was dropped along with the alt/az columns it would have produced,
    // and the call still reported success.
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      latitude: SEATTLE.latitude,
    });
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('incomplete_observer');
    expect(err.data.recovery.hint).toMatch(/latitude and longitude together/i);
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
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('incomplete_observer');
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
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('invalid_time_range');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a zero-length span (stop equal to start) with invalid_time_range', async () => {
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433;',
      start: '2024-01-01T00:00:00Z',
      stop: '2024-01-01T00:00:00Z',
    });
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('invalid_time_range');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed step with invalid_step, not an upstream outage', async () => {
    const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({ designation: '433;', step: 'nonsense' });
    const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('invalid_step');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['0m', '1w', '10', 'm', '1 1h', '1.5h', '1om', '1 mo d'])(
    'rejects step "%s" with invalid_step',
    async (step) => {
      const fetchSpy = vi.fn(async () => new Response('unused', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = createMockContext({ errors: getEphemerisTool.errors });
      const input = getEphemerisTool.input.parse({ designation: '433;', step });
      const err = await getEphemerisTool.handler(input, ctx).catch((e) => e);
      expect(err.data.reason).toBe('invalid_step');
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
 * A real ISS (NORAD 25544) TLE epoch 2024-01-01 — used to drive the SGP4
 * propagation for real over the fixture rather than mocking the math.
 */
const ISS_TLE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9006',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49447822  1234',
].join('\n');

/**
 * A synthetic element set standing in for a decayed object: an orbit low and draggy
 * enough that SGP4's mean elements stop describing it about ten days past epoch, well
 * inside the horizon over which a published element set is meant to hold. That is what
 * separates a reentry from a start the element set simply cannot reach. Synthetic
 * rather than a real catalog entry because CelesTrak drops decayed objects from
 * `gp.php?CATNR=` — what triggers the rejection is the drag term, not the identity.
 */
const DECAYED_TLE = [
  'DECAYED TEST OBJECT',
  '1 88888U 99001A   20001.50000000  .00016717  00000+0  86870-3 0  9990',
  '2 88888  51.6000 100.0000 0005000 100.0000 260.0000 16.30000000    10',
].join('\n');

describe('astronomy_get_satellite_passes — happy path', () => {
  it('fetches a TLE, propagates with SGP4, and returns a schema-conforming result', async () => {
    stubFetch(ISS_TLE);
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
    // Every returned pass is sunlit by contract (visible-only filter).
    for (const p of result.passes) {
      expect(p.sunlit).toBe(true);
      expect(p.peak_altitude_degrees).toBeGreaterThanOrEqual(10);
      expect(new Date(p.set_utc).getTime()).toBeGreaterThan(new Date(p.rise_utc).getTime());
    }
  });

  it('caches the TLE so a second call within the TTL does not refetch', async () => {
    const fetchSpy = vi.fn(async () => new Response(ISS_TLE, { status: 200 }));
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
    stubFetch(ISS_TLE);
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
    stubFetch(ISS_TLE);
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
    stubFetch(ISS_TLE);
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
    expect(resumed.passes[0]).toEqual(first);
  });

  it('keeps a pass that rises one step after start', async () => {
    stubFetch(ISS_TLE);
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
    expect(shifted.passes[0]).toEqual(first);
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
  });
});

describe('astronomy_get_satellite_passes — error contracts', () => {
  it('fails tle_not_found when CelesTrak has no element set', async () => {
    stubFetch('No GP data found');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 99999, ...SEATTLE });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('tle_not_found');
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('fails tle_not_found on an empty CelesTrak body', async () => {
    stubFetch('   ');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 99999, ...SEATTLE });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('tle_not_found');
  });

  it('maps a CelesTrak 404 to tle_not_found without leaking HTTP internals', async () => {
    // CelesTrak answers a missing object with HTTP 404 (not a 200 sentinel), so
    // fetchWithTimeout throws a NotFound McpError carrying the URL, status, and
    // raw body in its data. The service must reclassify into the typed contract
    // with leak-free data — no statusCode/responseBody/url/requestId.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('No GP data found', { status: 404 })),
    );
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 999999, ...SEATTLE });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('tle_not_found');
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toEqual({
      reason: 'tle_not_found',
      recovery: { hint: expect.stringContaining('celestrak.org') },
    });
  });

  it('fails celestrak_unavailable when the response is not a parsable TLE', async () => {
    stubFetch('some text that is neither an error sentinel nor a two-line element set');
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('celestrak_unavailable');
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('maps a CelesTrak HTTP failure to celestrak_unavailable without leaking HTTP internals', async () => {
    // A 5xx (not a 404, not a 200 sentinel) reaches the fetch catch as a status-mapped
    // McpError carrying the URL, statusCode, and raw body. classifyFetchError must map
    // it to the typed contract with leak-free data — internals stay on `cause` only.
    stubFetchThrowsUpstream();
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toEqual({
      reason: 'celestrak_unavailable',
      recovery: { hint: expect.stringContaining('retry') },
    });
    expectNoUpstreamLeak(err.data);
  });

  it('maps a CelesTrak fetch timeout to celestrak_unavailable, not tle_not_found', async () => {
    // classifyFetchError branches only on NotFound; a Timeout must fall through to
    // the unavailable arm rather than being read as "no such object".
    stubFetchThrowsTimeout();
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toEqual({
      reason: 'celestrak_unavailable',
      recovery: { hint: expect.stringContaining('retry') },
    });
    expectNoUpstreamLeak(err.data);
  });

  it('fails object_decayed instead of returning an empty pass list for a decayed object', async () => {
    // SGP4 refuses an element set that no longer describes an orbit by answering null,
    // and the scan loop used to swallow that per timestep, so the caller saw
    // `passes: []`, indistinguishable from "nothing visible in this window". The window
    // sits inside the element set's own validity horizon, so the object is what changed.
    stubFetch(DECAYED_TLE);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 88888,
      ...SEATTLE,
      days: 3,
      start: '2020-01-15T00:00:00Z',
    });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('object_decayed');
    expect(err.data.recovery.hint).toMatch(/still in orbit/i);
    expect(err.message).toContain('88888');
  });

  it('blames the start, not the object, when it lies beyond the element set epoch', async () => {
    // A start far from the epoch stops SGP4 for a satellite that is plainly still in
    // orbit, so reporting it as a decay would be a false statement with a recovery the
    // caller cannot act on — the actionable fact is that the element set does not reach
    // that far.
    stubFetch(ISS_TLE);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      days: 3,
      start: '2040-01-01T00:00:00Z',
    });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('time_out_of_range');
    expect(err.message).not.toMatch(/decayed/i);
    expect(err.data.recovery.hint).toMatch(/epoch/i);
  });

  it('rejects a non-positive NORAD id at schema validation', () => {
    expect(() => getSatellitePassesTool.input.parse({ norad_id: 0, ...SEATTLE })).toThrow();
  });

  it('rejects a days value above the maximum of 10', () => {
    expect(() =>
      getSatellitePassesTool.input.parse({ norad_id: 25544, ...SEATTLE, days: 15 }),
    ).toThrow();
  });

  it('rejects a non-integer NORAD id', () => {
    expect(() => getSatellitePassesTool.input.parse({ norad_id: 25544.5, ...SEATTLE })).toThrow();
  });

  it('rejects an unparseable start with invalid_time instead of a false empty result', async () => {
    // Bare new Date('not-a-date') is an Invalid Date; SGP4 turns it into NaN positions so
    // every candidate pass fails the elevation/sunlit filters — a silent, falsely-successful
    // "0 passes". resolveTime() must reject it up front, before any TLE fetch or propagation.
    const fetchSpy = vi.fn(async () => new Response(ISS_TLE, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      start: 'not-a-date',
    });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('invalid_time');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a start outside the 1900–2100 span with time_out_of_range', async () => {
    const fetchSpy = vi.fn(async () => new Response(ISS_TLE, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: getSatellitePassesTool.errors });
    const input = getSatellitePassesTool.input.parse({
      norad_id: 25544,
      ...SEATTLE,
      start: '1850-01-01T00:00:00Z',
    });
    const err = await getSatellitePassesTool.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('time_out_of_range');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
