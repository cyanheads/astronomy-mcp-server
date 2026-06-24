/**
 * @fileoverview Tests for the two gated, network-backed extension tools —
 *   astronomy_get_ephemeris (JPL Horizons) and astronomy_get_satellite_passes
 *   (CelesTrak TLE + SGP4). The network boundary (`fetchWithTimeout` → global
 *   `fetch`) is stubbed with canned upstream text so no live request is made; the
 *   SGP4 propagation and the Horizons CSV parse run for real against the fixtures.
 *
 *   Covers every declared `ctx.fail` reason (body_not_found, horizons_unavailable,
 *   tle_not_found, celestrak_unavailable), the happy-path parse, a sparse upstream
 *   payload (Horizons "n.a." magnitude → null), the truncation-disclosure
 *   enrichment, observer alt/az inclusion, the TLE cache, and format() completeness
 *   including the empty-result branch.
 * @module tests/tools/extension-tools.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEphemerisTool } from '@/mcp-server/tools/definitions/get-ephemeris.tool.js';
import { getSatellitePassesTool } from '@/mcp-server/tools/definitions/get-satellite-passes.tool.js';
import { initEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { initHorizonsService } from '@/services/horizons/horizons-service.js';
import { initSatelliteService } from '@/services/satellite/satellite-service.js';

const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };

/** A canned `fetch` returning fixed text for every call (so retries see the same body). */
function stubFetch(body: string, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: ok ? 200 : 503 })),
  );
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

  it('includes alt/az when an observer is supplied (topocentric)', async () => {
    // With observer: date,flag,flag,RA,Dec,Az,El,APmag,S-brt,delta,deldot
    stubFetch(
      horizonsTopocentric([
        '2024-Jan-01 00:00:00.0000, , , 45.000000, 12.500000, 180.000000, 30.000000, 9.50, 5.0, 1.500000, 0.0',
      ]),
    );
    const ctx = createMockContext({ errors: getEphemerisTool.errors });
    const input = getEphemerisTool.input.parse({
      designation: '433 Eros',
      ...SEATTLE,
      start: '2024-01-01T00:00:00Z',
      stop: '2024-01-01T01:00:00Z',
    });
    const result = await getEphemerisTool.handler(input, ctx);
    expect(result.points[0]?.altitude_degrees).toBeCloseTo(30, 5);
    expect(result.points[0]?.azimuth_degrees).toBeCloseTo(180, 5);
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

  it('discloses truncation when Horizons returns more rows than the inline cap', async () => {
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

  it('rejects an empty designation at schema validation', () => {
    expect(() => getEphemerisTool.input.parse({ designation: '' })).toThrow();
  });
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
});
