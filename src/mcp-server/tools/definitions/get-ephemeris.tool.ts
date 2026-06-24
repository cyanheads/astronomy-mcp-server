/**
 * @fileoverview astronomy_get_ephemeris — gated extension. Ephemeris for a small body
 *   (asteroid/comet) or spacecraft via JPL Horizons. Covers what the in-process
 *   major-body engine cannot. Registered only when ASTRONOMY_ENABLE_HORIZONS is set.
 * @module mcp-server/tools/definitions/get-ephemeris.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getHorizonsService } from '@/services/horizons/horizons-service.js';

/** Inline ephemeris-row cap disclosed via enrichment — mirrors HorizonsService MAX_ROWS. */
const INLINE_ROW_CAP = 200;

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
    'Fetch a time-series ephemeris for a small body (asteroid or comet) or spacecraft from JPL Horizons — RA/Dec, distance, and apparent magnitude over a span, optionally with observer-relative altitude/azimuth. This covers objects the in-process major-body set cannot: pass a designation like "433 Eros", "1P/Halley", or an SPK-ID. `start` and `stop` are ISO 8601 UTC; `step` is a Horizons step string such as "1d", "1h", or "10m". Supplying observer latitude/longitude yields topocentric coordinates and adds alt/az. This is a gated, network-backed extension (JPL Horizons is keyless but rate-limited and best-effort); large spans truncate inline — widen the step to reduce rows.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    designation: z
      .string()
      .min(1)
      .describe(
        'JPL Horizons target designation, e.g. "433 Eros", "1P/Halley", or an SPK-ID. Find designations at ssd.jpl.nasa.gov.',
      ),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Observer latitude in decimal degrees — supply with longitude for topocentric coordinates and alt/az.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Observer longitude in decimal degrees.'),
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
      .describe('Ephemeris stop as an ISO 8601 UTC string. Defaults to 24 hours after start.'),
    step: z
      .string()
      .default('1h')
      .describe('Horizons step size string, e.g. "1d", "1h", "10m". Default "1h".'),
  }),
  output: EphemerisOutput,
  enrichment: {
    truncated: z.boolean().describe('True when Horizons returned more rows than the inline cap.'),
    shown: z.number().describe('Number of ephemeris rows returned.'),
    cap: z.number().describe('The inline row cap that was applied.'),
  },
  errors: [
    {
      reason: 'body_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'JPL Horizons has no match for the designation.',
      recovery:
        "Check the designation against JPL's small-body database at ssd.jpl.nasa.gov; try the SPK-ID form.",
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
    const start = input.start ?? new Date().toISOString();
    const stop = input.stop ?? new Date(new Date(start).getTime() + 24 * 3600 * 1000).toISOString();
    const observer =
      typeof input.latitude === 'number' && typeof input.longitude === 'number'
        ? { latitude: input.latitude, longitude: input.longitude, elevation: input.elevation }
        : undefined;

    const result = await svc.ephemeris(input.designation, start, stop, input.step, ctx, observer);
    ctx.log.info('Fetched Horizons ephemeris', {
      designation: input.designation,
      points: result.points.length,
    });

    /**
     * Emit the truncation enrichment on every call — the declared block requires
     * `truncated`/`shown`/`cap`, so a non-truncated result must still populate them
     * or the effective-output parse fails. INLINE_ROW_CAP mirrors the service's MAX_ROWS.
     */
    ctx.enrich({ truncated: result.truncated, shown: result.points.length, cap: INLINE_ROW_CAP });
    if (result.truncated) {
      ctx.enrich.notice(
        'Widen the step (e.g. from "10m" to "1h") or shorten the time span to fit within the inline row cap.',
      );
    }

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
        p.altitude_degrees !== undefined
          ? `, alt ${p.altitude_degrees.toFixed(1)}°, az ${p.azimuth_degrees?.toFixed(1)}°`
          : '';
      lines.push(
        `- ${p.time_utc}: RA ${p.ra_hours.toFixed(4)} h, Dec ${p.dec_degrees.toFixed(4)}°, ${p.distance_au.toFixed(4)} AU, mag ${p.magnitude === null ? 'n/a' : p.magnitude.toFixed(1)}${altAz}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
