/**
 * @fileoverview astronomy_get_ephemeris — gated extension. Ephemeris for a small body
 *   (asteroid/comet) or spacecraft via JPL Horizons. Covers what the in-process
 *   major-body engine cannot. Registered only when ASTRONOMY_ENABLE_HORIZONS is set.
 * @module mcp-server/tools/definitions/get-ephemeris.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { num, sig } from '@/mcp-server/tools/format-numbers.js';
import { getHorizonsService } from '@/services/horizons/horizons-service.js';

/** Inline ephemeris-row cap disclosed via enrichment — mirrors HorizonsService MAX_ROWS. */
const INLINE_ROW_CAP = 200;

/**
 * Accepted `step` shape: a positive count followed by one of Horizons' calendar step
 * units — m (minutes), h (hours), d (days), mo (months), y (years). `mo` precedes `m`
 * in the alternation so "1mo" reads as months rather than a minute step with a stray
 * character. An optional single space is tolerated because Horizons itself writes
 * "1 d". Anything else — a bare number, an unsupported unit, or free text — is a
 * caller mistake that would otherwise be spent on an upstream request and come back
 * mislabelled as a Horizons outage.
 */
const STEP_PATTERN = /^[1-9]\d* ?(?:mo|[mhdy])$/i;

export const EphemerisOutput = z.object({
  designation: z.string().describe('The body designation echoed from the request.'),
  points: z
    .array(
      z
        .object({
          time_utc: z.string().describe('Step instant in ISO 8601 UTC.'),
          ra_hours: z.number().describe('Right ascension in sidereal hours [0,24).'),
          dec_degrees: z.number().describe('Declination in degrees [-90,90].'),
          distance_au: z.number().describe('Observer-to-body distance in astronomical units.'),
          magnitude: z
            .number()
            .nullable()
            .describe('Apparent magnitude, or null when Horizons omits it for this body.'),
          altitude_degrees: z
            .number()
            .optional()
            .describe(
              'Refraction-corrected altitude in degrees. Present only when an observer was supplied.',
            ),
          azimuth_degrees: z
            .number()
            .optional()
            .describe(
              'Azimuth in degrees (0=N, 90=E, 180=S, 270=W). Present only when an observer was supplied.',
            ),
        })
        .describe('One ephemeris step: position and, with an observer, alt/az.'),
    )
    .describe('Time-series of positions, one per step, in chronological order.'),
});

export type EphemerisOutputType = z.infer<typeof EphemerisOutput>;

export const getEphemerisTool = tool('astronomy_get_ephemeris', {
  title: 'astronomy-mcp-server: get small-body ephemeris',
  description:
    'Fetch a time-series ephemeris for a small body (asteroid or comet) or spacecraft from JPL Horizons — RA/Dec, distance, and apparent magnitude over a span, optionally with observer-relative altitude/azimuth. This covers objects the in-process major-body set cannot. The designation is passed to Horizons verbatim, so it must be in a form Horizons resolves to a single record: a numbered asteroid takes a trailing-semicolon record lookup (e.g. "433;" for Eros, "1;" for Ceres), and a periodic comet takes the DES + closest-apparition form (e.g. "DES=1P;CAP" for Halley) — a bare name like "433 Eros" or "1P/Halley" returns no match or an ambiguous record list and is rejected. Spacecraft take their negative SPK-ID. `start` and `stop` are ISO 8601 UTC and `stop` must be after `start`; `step` is a count plus a unit of m, h, d, mo, or y, such as "1d", "1h", or "10m". Supplying observer latitude/longitude yields topocentric coordinates and adds alt/az — supply both or neither. This is a gated, network-backed extension (JPL Horizons is keyless but rate-limited and best-effort); large spans truncate inline at 200 rows, and the truncation notice carries the instant to resume from — re-call from there, or split the range into smaller adjacent spans, keeping the same step so no sample is lost.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    designation: z
      .string()
      .min(1)
      .describe(
        'JPL Horizons target, passed verbatim — use a form that resolves to one record. Numbered asteroid: trailing-semicolon record lookup, e.g. "433;" (Eros), "1;" (Ceres). Periodic comet: DES + closest-apparition flag, e.g. "DES=1P;CAP" (Halley), "DES=2P;CAP" (Encke). Spacecraft: negative SPK-ID, e.g. "-48" (Hubble). A bare name like "433 Eros" or "1P/Halley" fails. Look up designations at ssd.jpl.nasa.gov/tools/sbdb_lookup.html.',
      ),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Observer latitude in decimal degrees — supply together with longitude for topocentric coordinates and alt/az. Supplying one without the other is rejected.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Observer longitude in decimal degrees. Supply together with latitude; one without the other is rejected.',
      ),
    elevation: z
      .number()
      .default(0)
      .describe('Observer elevation in meters above sea level. Default 0.'),
    start: z
      .string()
      .optional()
      .describe(
        'Ephemeris start as an ISO 8601 UTC string, e.g. "2024-01-01T00:00:00Z". Defaults to now.',
      ),
    stop: z
      .string()
      .optional()
      .describe(
        'Ephemeris stop as an ISO 8601 UTC string, and must be later than start. Defaults to 24 hours after start.',
      ),
    step: z
      .string()
      .default('1h')
      .describe(
        'Step size as a positive count plus a unit of m (minutes), h (hours), d (days), mo (months), or y (years), e.g. "10m", "1h", "1d". Default "1h".',
      ),
  }),
  output: EphemerisOutput,
  enrichment: {
    truncated: z.boolean().describe('True when Horizons returned more rows than the inline cap.'),
    shown: z.number().describe('Number of ephemeris rows returned.'),
    cap: z.number().describe('The inline row cap that was applied.'),
    dropped: z
      .number()
      .optional()
      .describe(
        'Rows Horizons returned that carried no usable time, position, or distance and were dropped. Present only when at least one row was dropped, in which case the series has gaps and is shorter than the requested step count.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Caveats on the returned series — how to retrieve rows omitted by the cap, and whether any rows were dropped. Absent when the whole span came back intact.',
      ),
  },
  errors: [
    {
      reason: 'invalid_time',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The start or stop timestamp is not a parseable ISO 8601 instant.',
      recovery:
        'Pass start and stop as ISO 8601 UTC timestamps, e.g. 2024-01-01T00:00:00Z, then retry.',
    },
    {
      reason: 'invalid_time_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The resolved stop instant is at or before the resolved start instant.',
      recovery:
        'Pass a stop that is later than start, or omit stop for a 24-hour span, then retry.',
    },
    {
      reason: 'incomplete_observer',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Exactly one of latitude and longitude was supplied.',
      recovery:
        'Supply latitude and longitude together for a topocentric ephemeris, or omit both for a geocentric one.',
    },
    {
      reason: 'invalid_step',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The step is not a positive count followed by a unit of m, h, d, mo, or y.',
      recovery:
        'Pass step as a count plus m, h, d, mo, or y — for example "10m", "1h", or "1d" — then retry.',
    },
    {
      reason: 'body_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'JPL Horizons has no match for the designation, or the designation is ambiguous (a bare comet name matches multiple apparition records).',
      recovery:
        'Use a record-resolving form: a numbered asteroid as "<number>;" (e.g. "433;"), a periodic comet as "DES=<designation>;CAP" (e.g. "DES=1P;CAP"), or a spacecraft as its negative SPK-ID. Verify the designation at ssd.jpl.nasa.gov/tools/sbdb_lookup.html.',
    },
    {
      reason: 'horizons_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The JPL Horizons API failed after retries.',
      retryable: true,
      recovery: 'JPL Horizons is degraded or timed out; retry in a few minutes.',
    },
  ],

  async handler(input, ctx) {
    const svc = getHorizonsService();
    /**
     * Validate caller-supplied timestamps before they reach `new Date(...).toISOString()`,
     * which throws an opaque RangeError on an unparseable string. Deliberately not routed
     * through the core resolveTime() — JPL Horizons covers historical and future epochs far
     * outside its 1900–2100 high-accuracy span, so only reject genuinely unparseable input.
     */
    if (input.start !== undefined && Number.isNaN(new Date(input.start).getTime())) {
      throw ctx.fail(
        'invalid_time',
        `Invalid start "${input.start}". Expected an ISO 8601 instant, e.g. 2024-01-01T00:00:00Z.`,
        { ...ctx.recoveryFor('invalid_time') },
      );
    }
    if (input.stop !== undefined && Number.isNaN(new Date(input.stop).getTime())) {
      throw ctx.fail(
        'invalid_time',
        `Invalid stop "${input.stop}". Expected an ISO 8601 instant, e.g. 2024-01-02T00:00:00Z.`,
        { ...ctx.recoveryFor('invalid_time') },
      );
    }
    const start = input.start ?? new Date().toISOString();
    const stop = input.stop ?? new Date(new Date(start).getTime() + 24 * 3600 * 1000).toISOString();
    if (new Date(stop).getTime() <= new Date(start).getTime()) {
      throw ctx.fail('invalid_time_range', `stop "${stop}" is not after start "${start}".`, {
        ...ctx.recoveryFor('invalid_time_range'),
      });
    }
    /**
     * A lone coordinate used to fall through to a geocentric query, silently dropping
     * the observer the caller asked for along with the alt/az columns it would have
     * produced. Reject the pair instead of reinterpreting the request.
     */
    const hasLatitude = input.latitude !== undefined;
    const hasLongitude = input.longitude !== undefined;
    if (hasLatitude !== hasLongitude) {
      throw ctx.fail(
        'incomplete_observer',
        `Observer ${hasLatitude ? 'latitude' : 'longitude'} was supplied without ${hasLatitude ? 'longitude' : 'latitude'}.`,
        { ...ctx.recoveryFor('incomplete_observer') },
      );
    }
    if (!STEP_PATTERN.test(input.step)) {
      throw ctx.fail(
        'invalid_step',
        `Invalid step "${input.step}". Expected a positive count plus m, h, d, mo, or y, e.g. "10m".`,
        { ...ctx.recoveryFor('invalid_step') },
      );
    }
    const observer =
      input.latitude !== undefined && input.longitude !== undefined
        ? { latitude: input.latitude, longitude: input.longitude, elevation: input.elevation }
        : undefined;

    const result = await svc.ephemeris(input.designation, start, stop, input.step, ctx, observer);
    ctx.log.info('Fetched Horizons ephemeris', {
      designation: input.designation,
      points: result.points.length,
    });

    /**
     * `truncated`/`shown`/`cap` are required, so every call populates them or the
     * effective-output parse fails; INLINE_ROW_CAP mirrors the service's MAX_ROWS.
     * `dropped` rides along only when a row was discarded, which takes a response
     * whose layout disagrees with the one the parse expects — Horizons pads a
     * quantity it cannot supply with "n.a." rather than shortening the row — so a
     * `0` on every healthy call would be noise on the advertised surface.
     *
     * Both caveats land in `notice`, which is last-wins across enrichment writers, so
     * they are joined and written once. Two writers would leave the later one erasing
     * the earlier.
     */
    const caveats: string[] = [];
    if (result.truncated) {
      // A truncated result is a full page, so its last row is the exact resume instant.
      const resumeFrom = result.points.at(-1)?.timeUtc;
      caveats.push(
        `Capped at ${INLINE_ROW_CAP} rows${resumeFrom ? `, ending at ${resumeFrom}` : ''}. To retrieve the omitted samples, re-call with start set to that instant, or split the requested range into smaller adjacent spans; keep the same step either way and repeat until truncated is false. Widening the step is not equivalent — it discards samples the original range asked for.`,
      );
    }
    if (result.dropped > 0) {
      caveats.push(
        `Dropped ${result.dropped} of the rows Horizons returned — no usable time, position, or distance — so this series is shorter than the requested step count and has a gap where each dropped row would have been.`,
      );
    }
    ctx.enrich({
      truncated: result.truncated,
      shown: result.points.length,
      cap: INLINE_ROW_CAP,
      ...(result.dropped > 0 ? { dropped: result.dropped } : {}),
    });
    if (caveats.length > 0) ctx.enrich.notice(caveats.join(' '));

    const out: EphemerisOutputType = {
      designation: result.designation,
      points: result.points.map((p) => ({
        time_utc: p.timeUtc,
        ra_hours: p.raHours,
        dec_degrees: p.decDegrees,
        distance_au: p.distanceAu,
        magnitude: p.magnitude,
        ...(p.altitudeDegrees !== undefined ? { altitude_degrees: p.altitudeDegrees } : {}),
        ...(p.azimuthDegrees !== undefined ? { azimuth_degrees: p.azimuthDegrees } : {}),
      })),
    };
    return out;
  },

  format: (r) => {
    const lines: string[] = [];
    lines.push(`## ${r.designation} — ${r.points.length} points`);
    for (const p of r.points) {
      const altAz =
        p.altitude_degrees === undefined
          ? ''
          : `, alt ${num(p.altitude_degrees, 1, '°')}, az ${p.azimuth_degrees === undefined ? 'n/a' : num(p.azimuth_degrees, 1, '°')}`;
      lines.push(
        `- ${p.time_utc}: RA ${num(p.ra_hours, 4, ' h')}, Dec ${num(p.dec_degrees, 4, '°')}, ${sig(p.distance_au, 6, ' AU')}, mag ${p.magnitude === null ? 'n/a' : num(p.magnitude, 1)}${altAz}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
