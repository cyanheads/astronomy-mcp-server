/**
 * @fileoverview HorizonsService — gated extension wrapping the keyless JPL Horizons
 *   HTTP API for small-body (asteroid/comet) and spacecraft ephemerides that the
 *   in-process major-body engine cannot cover. The only network-touching code here
 *   besides the satellite extension: it carries its own timeout + retry boundary and
 *   degrades loudly (throws serviceUnavailable / notFound / invalidParams), never
 *   substituting core output. Parses the OBSERVER ephemeris table between Horizons' $$SOE/$$EOE markers.
 * @module services/horizons/horizons-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  invalidParams,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ObserverInput } from '../ephemeris/types.js';
import type { EphemerisPoint, EphemerisResult } from './types.js';

/** Cap on inline ephemeris rows; beyond this the result truncates with disclosure. */
const MAX_ROWS = 200;

/**
 * Horizons' designation-miss signatures. A small-body index search that finds nothing
 * prints "No matches found."; one that finds several prints its "Matching small-bodies"
 * list with no ephemeris. Two date failures are deliberately absent, because the
 * designation resolved in both and blaming it would send the caller to change the one
 * input that was right: a refused START_TIME/STOP_TIME ("Cannot interpret date"), and a
 * span outside the target's data ("No ephemeris for target …", matched by `OUT_OF_SPAN`).
 */
const DESIGNATION_MISS = /No matches found|Matching small-bodies/i;

/**
 * The line Horizons prints instead of an ephemeris when a name matches several major bodies
 * or spacecraft, e.g. `Multiple major-bodies match string "MARS*"` for `Mars`. A table of the
 * candidates follows, one per line, keyed by the ID number that selects each one.
 */
const MAJOR_BODY_MULTI_MATCH = /Multiple major-bodies match string/;

/** Most candidates an ambiguous-designation error lists; the message states the full count. */
const MAX_DESIGNATION_CANDIDATES = 20;

/**
 * Recovery hint for a designation matching several major bodies, byte-identical to the
 * `recovery` the tool declares for `ambiguous_designation`.
 */
const AMBIGUOUS_DESIGNATION_RECOVERY =
  'Re-call with designation set to the ID number of the intended body from the listed candidates — e.g. "499" for the planet Mars — or a more specific name when it is not listed.';

/** One body a multi-match listed: the ID number that selects it, and the name Horizons printed. */
interface DesignationCandidate {
  id: string;
  name: string;
}

/**
 * Read the candidate table under Horizons' multi-match line. The table is fixed-width under
 * a separator of dash runs, one run per column; the ID# and Name columns are the first two.
 * A long name fills its column and the gap after it, so the name runs up to where the next
 * column starts, cut there exactly as Horizons cut it. Rows run until the first line with
 * no ID number in the ID# column.
 */
function multiMatchCandidates(text: string): DesignationCandidate[] {
  const lines = text.split('\n');
  const separatorAt = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.includes(' ') && /^[- ]+$/.test(trimmed);
  });
  if (separatorAt === -1) return [];
  const columns = [...(lines[separatorAt] ?? '').matchAll(/-+/g)].map((m) => ({
    from: m.index,
    to: m.index + m[0].length,
  }));
  const [idColumn, nameColumn, nextColumn] = columns;
  if (!idColumn || !nameColumn) return [];
  const candidates: DesignationCandidate[] = [];
  for (const line of lines.slice(separatorAt + 1)) {
    // An ID right-aligned in its column can start before the dashes do, so read from 0.
    const id = line.slice(0, idColumn.to).trim();
    if (!/^-?\d+$/.test(id)) break;
    candidates.push({ id, name: line.slice(nameColumn.from, nextColumn?.from).trim() });
  }
  return candidates;
}

/**
 * The line Horizons prints when the requested span leaves the target's data, e.g.
 * `No ephemeris for target "Mars" after A.D. 2599-DEC-31 23:58:50.8164 UT`. Captures the
 * target name, the direction, and the bound (era included) exactly as Horizons wrote them.
 */
const OUT_OF_SPAN =
  /^No ephemeris for target "([^"]*)" (prior to|after) ((?:A\.D\.|B\.C\.) \S.*?)[ \t]*$/m;

/**
 * Recovery hint for a span outside the target's data, byte-identical to the `recovery`
 * the tool declares for `time_out_of_range`. The bound itself rides in the message.
 */
const OUT_OF_SPAN_RECOVERY =
  "Move start and stop inside the target's Horizons data span — the message names the bound the request crossed — then retry.";

/**
 * The refusal Horizons prints when STEP_SIZE spans more than the target's whole data span,
 * e.g. `2147483647d` for 433 Eros. Which steps that is depends on the target, so it cannot
 * be checked before the request.
 */
const STEP_TOO_BIG = /STEP_SIZE too big/;

/** Recovery hint for an over-long step, byte-identical to the tool's `invalid_step` recovery. */
const INVALID_STEP_RECOVERY =
  'Pass step as a count up to 2147483647 plus m, h, d, mo, or y — for example "10m", "1h", or "1d" — and shorter than the span of data Horizons holds for the target, then retry.';

/**
 * The refusal Horizons prints when the target is the body the observer stands on — every
 * request here observes from Earth, so this is a target that resolves to Earth.
 */
const OBSERVER_IS_TARGET = /Observer table for observer=target disallowed/;

/** Recovery hint for Earth as the target, byte-identical to the tool's declared recovery. */
const OBSERVER_IS_TARGET_RECOVERY =
  'Choose a target other than Earth: this tool observes from Earth, geocentric or from the supplied latitude and longitude, and Horizons computes no ephemeris of the observer’s own body.';

/**
 * How Horizons names a request parameter whose value it refuses with HTTP 400, e.g.
 * `invalid value specified for query parameter 'COMMAND': invalid character(s) found (must be
 * ASCII hex code 0x20-0x7f)`. The capture is the parameter name.
 */
const REFUSED_PARAMETER = /query parameter '([A-Z_]+)'/;

/** The tool input each refusable Horizons query parameter carries. */
const PARAMETER_INPUTS: Partial<Record<string, string>> = {
  COMMAND: 'designation',
  START_TIME: 'start',
  STOP_TIME: 'stop',
  STEP_SIZE: 'step',
  SITE_COORD: 'the observer coordinates',
};

/** Recovery hint for a request Horizons refused, byte-identical to the tool's declared recovery. */
const REQUEST_REJECTED_RECOVERY =
  'Horizons refuses this request the same way on every attempt, so do not retry it unchanged: correct the input the message names — the designation as a record-resolving form such as "433;", or the start, stop, step, or observer coordinates — then call again.';

/**
 * The header line naming the object Horizons resolved, e.g.
 * "Target body name: 433 Eros (A898 PA)              {source: JPL#659}". The capture is
 * the name alone, without the padding and the trailing `{source: …}` tag.
 */
const TARGET_BODY_NAME = /^Target body name:[ \t]*(.*?)[ \t]*(?:\{source:[^}]*\})?[ \t]*$/m;

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
    const url = this.buildUrl(designation, start, stop, step, observer);

    let text: string;
    try {
      text = await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
            signal: ctx.signal,
          });
          return response.text();
        },
        {
          operation: 'HorizonsService.ephemeris',
          context: ctx,
          baseDelayMs: 2000,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      /**
       * fetchWithTimeout throws a status-mapped McpError on any non-2xx whose data
       * carries raw upstream internals (status/statusText/body plus the legacy
       * statusCode/responseBody aliases), and a Timeout McpError when its own deadline
       * fires. Horizons signals a genuine no-match with a 200 body (handled in parse); its
       * one deterministic HTTP refusal is a 400 for a parameter value it will not accept,
       * which no retry changes, so that becomes a typed input refusal naming the input.
       * Everything else is horizons_unavailable. Either way the error is rebuilt with clean
       * data so nothing upstream leaks to the client: the captured body echoes the query,
       * so the data is replaced rather than forwarded.
       */
      if (err instanceof McpError && err.data?.status === 400) {
        throw this.requestRejected(designation, err);
      }
      throw serviceUnavailable(
        `Failed to fetch an ephemeris for "${designation}" from JPL Horizons.`,
        {
          reason: 'horizons_unavailable',
          recovery: { hint: 'JPL Horizons is degraded or timed out; retry in a few minutes.' },
        },
        { cause: err instanceof Error ? err : undefined },
      );
    }

    return this.parse(designation, step, text, !!observer);
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
      // ISO 8601 dates are proleptic Gregorian. Horizons' default mixed calendar reads a
      // date before 1582-10-15 as Julian — 1500-01-01 lands on Gregorian 1500-01-10 — and
      // labels its rows the same way, so START_TIME, STOP_TIME, and every row's date
      // would name instants other than the ones computed. One calendar end to end;
      // after 1582-10-15 the two agree and nothing changes.
      CAL_TYPE: 'GREGORIAN',
    });
    if (observer) {
      params.set('COORD_TYPE', 'GEODETIC');
      // SITE_COORD is E-longitude, latitude, height(km): "lon,lat,km".
      params.set(
        'SITE_COORD',
        `'${observer.longitude},${observer.latitude},${(observer.elevation / 1000).toFixed(6)}'`,
      );
      // APPARENT toggles refraction correction and defaults to AIRLESS, so without it
      // the elevation column is geometric while altitude_degrees is advertised as
      // refraction-corrected — a gap that widens toward the horizon, where a caller
      // reads rise and set off that column. Horizons applies the toggle to Earth
      // topocentric requests only, which is this branch, and the core sky-position
      // tools already report refracted altitude.
      params.set('APPARENT', 'REFRACTED');
    }
    return `${this.baseUrl}?${params.toString()}`;
  }

  /**
   * Parse the CSV OBSERVER table between $$SOE and $$EOE. A response with no table is
   * matched against the refusals Horizons gives identically on every attempt, each typed
   * so the caller is not told to retry; only an answer none of them explains falls to
   * the retryable outage. Refusals the tool prevents before the request — a date it
   * cannot read, a stop not after start, a step count it cannot read, a blank target, an
   * observer altitude out of range, a span past its row ceiling — are not matched here.
   */
  private parse(
    designation: string,
    step: string,
    text: string,
    hasObserver: boolean,
  ): EphemerisResult {
    const hasBlock = text.includes('$$SOE');
    if (!hasBlock && STEP_TOO_BIG.test(text)) {
      throw invalidParams(
        `Step "${step}" is longer than the span of data JPL Horizons holds for "${designation}".`,
        { reason: 'invalid_step', recovery: { hint: INVALID_STEP_RECOVERY } },
      );
    }
    if (!hasBlock && OBSERVER_IS_TARGET.test(text)) {
      throw invalidParams(
        `"${designation}" resolves to Earth, the body the observer is on, and JPL Horizons has no observer table for it.`,
        { reason: 'observer_is_target', recovery: { hint: OBSERVER_IS_TARGET_RECOVERY } },
      );
    }
    const outOfSpan = hasBlock ? null : OUT_OF_SPAN.exec(text);
    if (outOfSpan) {
      const [, target, direction, bound] = outOfSpan;
      throw invalidParams(`Horizons has no ephemeris for ${target} ${direction} ${bound}.`, {
        reason: 'time_out_of_range',
        recovery: { hint: OUT_OF_SPAN_RECOVERY },
      });
    }
    if (!hasBlock && MAJOR_BODY_MULTI_MATCH.test(text)) {
      throw this.ambiguousDesignation(designation, multiMatchCandidates(text));
    }
    if (DESIGNATION_MISS.test(text) && !hasBlock) {
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

    const targetName = TARGET_BODY_NAME.exec(text)?.[1];
    return {
      designation,
      points,
      truncated,
      dropped,
      ...(targetName ? { targetName } : {}),
    };
  }

  /**
   * A name matching several major bodies is a fixed answer, not an outage: Horizons lists
   * the same candidates every time, so the error hands them over for the caller to pick
   * one ID from. The list is capped, and the message says so when it is.
   */
  private ambiguousDesignation(designation: string, matched: DesignationCandidate[]): McpError {
    const candidates = matched.slice(0, MAX_DESIGNATION_CANDIDATES);
    const listing = candidates.map((c) => `${c.id} (${c.name})`).join(', ');
    const message =
      matched.length === 0
        ? `"${designation}" matches several JPL Horizons major bodies.`
        : matched.length > candidates.length
          ? `"${designation}" matches ${matched.length} JPL Horizons major bodies. The first ${candidates.length}: ${listing}.`
          : `"${designation}" matches ${matched.length} JPL Horizons major bodies: ${listing}.`;
    return invalidParams(message, {
      reason: 'ambiguous_designation',
      recovery: { hint: AMBIGUOUS_DESIGNATION_RECOVERY },
      ...(matched.length > 0 ? { match_count: matched.length, candidates } : {}),
    });
  }

  /**
   * A 400 names the query parameter Horizons refused; the error names the tool input that
   * parameter carries, and neither Horizons' text nor the HTTP details reach the client.
   */
  private requestRejected(designation: string, err: McpError): McpError {
    const body = typeof err.data?.body === 'string' ? err.data.body : '';
    const parameter = REFUSED_PARAMETER.exec(body)?.[1];
    const input = (parameter && PARAMETER_INPUTS[parameter]) ?? 'a request parameter';
    return invalidParams(
      `JPL Horizons refused the request for "${designation}": it rejected the value sent for ${input}.`,
      { reason: 'request_rejected', recovery: { hint: REQUEST_REJECTED_RECOVERY } },
      { cause: err },
    );
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
   * steps, so seconds are optional. A START_TIME carrying a fraction of a second comes
   * back on every row ("2026-Jan-01 00:00:30.500"), and the fraction is kept — rounded to
   * the millisecond an ISO instant holds — so `time_utc` names the instant Horizons
   * computed, and a resume start derived from it stays on the caller's time grid.
   * Horizons dates are always UT — parse them as UTC explicitly; never let a bare
   * string fall to local-time `new Date(...)`.
   */
  private parseHorizonsDate(raw: string): string | null {
    const cleaned = raw.replace(/^A\.D\.\s*/, '').trim();
    const match = cleaned.match(
      /^(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?/,
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
    const [, year, monName, day, hh, mm, ss, fraction] = match;
    const monNum = monName ? months[monName] : undefined;
    if (!monNum) return null;
    const iso = `${year}-${monNum}-${day}T${hh}:${mm}:${ss ?? '00'}Z`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    // Added to the epoch rather than written into the string, so a fraction that rounds up
    // to a whole second carries into the next minute instead of naming second 60.
    const ms = fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000);
    return new Date(d.getTime() + ms).toISOString();
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
