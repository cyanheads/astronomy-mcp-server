/**
 * @fileoverview HorizonsService — gated extension wrapping the keyless JPL Horizons
 *   HTTP API for small-body (asteroid/comet) and spacecraft ephemerides that the
 *   in-process major-body engine cannot cover. The only network-touching code here
 *   besides the satellite extension: it carries its own timeout + retry boundary and
 *   degrades loudly (throws serviceUnavailable / notFound), never substituting core
 *   output. Parses the OBSERVER ephemeris table between Horizons' $$SOE/$$EOE markers.
 * @module services/horizons/horizons-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ObserverInput } from '../ephemeris/types.js';
import type { EphemerisPoint, EphemerisResult } from './types.js';

/** Cap on inline ephemeris rows; beyond this the result truncates with disclosure. */
const MAX_ROWS = 200;

export class HorizonsService {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Fetch an OBSERVER ephemeris for a small body. When an observer is supplied the
   * coordinates are topocentric and alt/az is included; otherwise geocentric.
   */
  async ephemeris(
    designation: string,
    start: string,
    stop: string,
    step: string,
    ctx: Context,
    observer?: ObserverInput,
  ): Promise<EphemerisResult> {
    const reqCtx = requestContextService.createRequestContext({
      operation: 'HorizonsService.ephemeris',
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId },
    });

    const url = this.buildUrl(designation, start, stop, step, observer);

    let text: string;
    try {
      text = await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
            signal: ctx.signal,
          });
          return response.text();
        },
        {
          operation: 'HorizonsService.ephemeris',
          context: reqCtx,
          baseDelayMs: 2000,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      // fetchWithTimeout throws a status-mapped McpError on any non-2xx whose data
      // carries raw upstream internals (URL, status/body plus the legacy
      // statusCode/responseBody aliases), and a Timeout McpError when its own
      // deadline fires. Either way the failure is horizons_unavailable here —
      // Horizons signals a genuine no-match with a 200 body (handled in parse), not
      // an HTTP error status. Map to the typed contract with clean data so nothing
      // upstream leaks to the client.
      throw serviceUnavailable(
        `Failed to fetch an ephemeris for "${designation}" from JPL Horizons.`,
        {
          reason: 'horizons_unavailable',
          recovery: { hint: 'JPL Horizons is degraded or timed out; retry in a few minutes.' },
        },
        { cause: err instanceof Error ? err : undefined },
      );
    }

    return this.parse(designation, text, !!observer);
  }

  /** Build the Horizons GET URL with quoted, URL-encoded parameters. */
  private buildUrl(
    designation: string,
    start: string,
    stop: string,
    step: string,
    observer?: ObserverInput,
  ): string {
    const params = new URLSearchParams({
      format: 'text',
      COMMAND: `'${designation}'`,
      EPHEM_TYPE: 'OBSERVER',
      CENTER: observer ? "'coord@399'" : "'500@399'",
      START_TIME: `'${start}'`,
      STOP_TIME: `'${stop}'`,
      STEP_SIZE: `'${step}'`,
      // QUANTITIES 1=RA/Dec, 9=APmag/S-brt, 20=delta/deldot. Add 4=azimuth/elevation
      // for a topocentric observer so the response carries the alt/az columns parseRow
      // reads when hasObserver — without it the columns shift and delta lands undefined.
      QUANTITIES: observer ? "'1,4,9,20'" : "'1,9,20'",
      CSV_FORMAT: 'YES',
      ANG_FORMAT: 'DEG',
      EXTRA_PREC: 'YES',
    });
    if (observer) {
      params.set('COORD_TYPE', 'GEODETIC');
      // SITE_COORD is E-longitude, latitude, height(km): "lon,lat,km".
      params.set(
        'SITE_COORD',
        `'${observer.longitude},${observer.latitude},${(observer.elevation / 1000).toFixed(6)}'`,
      );
    }
    return `${this.baseUrl}?${params.toString()}`;
  }

  /** Parse the CSV OBSERVER table between $$SOE and $$EOE. */
  private parse(designation: string, text: string, hasObserver: boolean): EphemerisResult {
    const hasBlock = text.includes('$$SOE');
    const looksUnmatched =
      /No matches found|Cannot interpret|No ephemeris|Matching small-bodies/i.test(text);
    if (looksUnmatched && !hasBlock) {
      throw notFound(`JPL Horizons has no match for designation "${designation}".`, {
        reason: 'body_not_found',
        recovery: {
          hint: 'Use a record-resolving form: a numbered asteroid as "<number>;" (e.g. "433;"), a periodic comet as "DES=<designation>;CAP" (e.g. "DES=1P;CAP"), or a spacecraft as its negative SPK-ID. Verify the designation at ssd.jpl.nasa.gov/tools/sbdb_lookup.html.',
        },
      });
    }

    const soe = text.indexOf('$$SOE');
    const eoe = text.indexOf('$$EOE');
    if (soe === -1 || eoe === -1) {
      throw serviceUnavailable(
        'JPL Horizons returned an unexpected response with no ephemeris block.',
        {
          reason: 'horizons_unavailable',
          recovery: {
            hint: 'Horizons may be degraded or rejected the request; retry in a few minutes.',
          },
        },
      );
    }

    const block = text.slice(soe + 5, eoe).trim();
    const rows = block.split('\n').filter((line) => line.trim().length > 0);

    const points: EphemerisPoint[] = [];
    let truncated = false;
    let dropped = 0;
    for (const row of rows) {
      if (points.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      const point = this.parseRow(row, hasObserver);
      if (point) points.push(point);
      else dropped++;
    }

    if (points.length === 0) {
      throw serviceUnavailable('JPL Horizons returned an ephemeris block with no usable rows.', {
        reason: 'horizons_unavailable',
        recovery: {
          hint: 'No row carried a time, a position, and a distance. Confirm the designation resolves to a single record and that the step and time span are ones Horizons accepts; if they are, retry in a few minutes.',
        },
      });
    }

    return { designation, points, truncated, dropped };
  }

  /**
   * Parse one CSV row (CSV_FORMAT YES). The column layout depends on whether an
   * observer was supplied, because buildUrl requests azimuth/elevation (QUANTITIES
   * '4') only for a topocentric observer:
   *   geocentric  ('1,9,20'):   date, flag, flag, RA(deg), DEC(deg), APmag, S-brt, delta(AU), deldot
   *   topocentric ('1,4,9,20'): date, flag, flag, RA(deg), DEC(deg), Azimuth(deg), Elevation(deg), APmag, S-brt, delta(AU), deldot
   * Columns 1-2 are solar-presence / lunar-illumination flags, often blank.
   * Returns null for any row that does not carry a time, a position, and a distance —
   * such a row is not an ephemeris point, and the caller counts the discards.
   */
  private parseRow(row: string, hasObserver: boolean): EphemerisPoint | null {
    const cols = row.split(',').map((c) => c.trim());
    if (cols.length < 5) return null;
    // Column 0 is the calendar date; columns 1-2 are presence flags (often blank).
    const dateStr = cols[0];
    if (!dateStr) return null;
    const time = this.parseHorizonsDate(dateStr);
    if (!time) return null;

    /**
     * After the date + two flag columns, the angular quantities begin. A column is
     * usable only when it parses to a finite number — Horizons writes "n.a." for a
     * quantity it cannot supply for this target, and a layout narrower than the
     * requested one leaves trailing columns absent. Mapping every unusable column to
     * null keeps NaN, which the output schema rejects, out of the row by construction.
     */
    const numeric = cols.slice(3).map((c) => {
      const value = Number.parseFloat(c);
      return Number.isFinite(value) ? value : null;
    });

    let idx = 0;
    const ra = numeric[idx++];
    const dec = numeric[idx++];
    let azimuth: number | null = null;
    let altitude: number | null = null;
    if (hasObserver) {
      azimuth = numeric[idx++] ?? null;
      altitude = numeric[idx++] ?? null;
    }
    const apMag = numeric[idx++];
    // s-brt is skipped; delta (distance AU) follows.
    idx++; // s-brt column
    const delta = numeric[idx++];

    // Distance is as load-bearing as the position: without it the row is not a point.
    if (ra == null || dec == null || delta == null) return null;

    const point: EphemerisPoint = {
      timeUtc: time,
      raHours: ra / 15, // Horizons RA is in degrees; convert to sidereal hours.
      decDegrees: dec,
      distanceAu: delta,
      magnitude: apMag ?? null,
    };
    if (hasObserver && altitude !== null && azimuth !== null) {
      point.altitudeDegrees = altitude;
      point.azimuthDegrees = azimuth;
    }
    return point;
  }

  /**
   * Convert a Horizons calendar date to ISO 8601 UTC. The OBSERVER table emits
   * "2024-Apr-08 18:00" (HH:MM) at hour/day steps and "…18:00:00.0000" at finer
   * steps, so seconds are optional. Horizons dates are always UT — parse them as
   * UTC explicitly; never let a bare string fall to local-time `new Date(...)`.
   */
  private parseHorizonsDate(raw: string): string | null {
    const cleaned = raw.replace(/^A\.D\.\s*/, '').trim();
    const match = cleaned.match(
      /^(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?/,
    );
    if (!match) {
      // Append Z so an unzoned fallback string is read as UTC, not host-local time.
      const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(cleaned) ? cleaned : `${cleaned}Z`);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const months: Record<string, string> = {
      Jan: '01',
      Feb: '02',
      Mar: '03',
      Apr: '04',
      May: '05',
      Jun: '06',
      Jul: '07',
      Aug: '08',
      Sep: '09',
      Oct: '10',
      Nov: '11',
      Dec: '12',
    };
    const [, year, monName, day, hh, mm, ss] = match;
    const monNum = monName ? months[monName] : undefined;
    if (!monNum) return null;
    const iso = `${year}-${monNum}-${day}T${hh}:${mm}:${ss ?? '00'}Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
}

// --- Init / accessor pattern ------------------------------------------------

let _service: HorizonsService | undefined;

/** Initialize the Horizons service with the configured endpoint and timeout. */
export function initHorizonsService(baseUrl: string, timeoutMs: number): void {
  _service = new HorizonsService(baseUrl, timeoutMs);
}

/** Accessor — throws if not initialized (the gate is off). */
export function getHorizonsService(): HorizonsService {
  if (!_service) {
    throw new Error('HorizonsService not initialized — enable ASTRONOMY_ENABLE_HORIZONS');
  }
  return _service;
}
