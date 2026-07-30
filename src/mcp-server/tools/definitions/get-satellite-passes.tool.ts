/**
 * @fileoverview astronomy_get_satellite_passes — gated extension. Visible passes of a
 *   satellite (by NORAD ID) over an observer, via a CelesTrak TLE propagated with
 *   SGP4 offline. Registered only when ASTRONOMY_ENABLE_SATELLITES is set.
 * @module mcp-server/tools/definitions/get-satellite-passes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { getSatelliteService } from '@/services/satellite/satellite-service.js';

export const SatellitePassesOutput = z.object({
  norad_id: z.number().describe('The NORAD catalog number echoed from the request.'),
  satellite_name: z
    .string()
    .optional()
    .describe('Satellite name from the TLE header, when present.'),
  passes: z
    .array(
      z
        .object({
          rise_utc: z
            .string()
            .describe('Acquisition of signal (rise above horizon) in ISO 8601 UTC.'),
          peak_utc: z.string().describe('Time of maximum elevation in ISO 8601 UTC.'),
          set_utc: z.string().describe('Loss of signal (set below horizon) in ISO 8601 UTC.'),
          rise_local: z
            .string()
            .optional()
            .describe(
              'Rise time in observer-local time, present only when a timezone was supplied.',
            ),
          peak_local: z
            .string()
            .optional()
            .describe(
              'Peak time in observer-local time, present only when a timezone was supplied.',
            ),
          set_local: z
            .string()
            .optional()
            .describe(
              'Set time in observer-local time, present only when a timezone was supplied.',
            ),
          peak_altitude_degrees: z
            .number()
            .describe('Maximum elevation angle during the pass, in degrees.'),
          rise_azimuth_degrees: z
            .number()
            .describe('Azimuth at rise, in degrees (0=N, 90=E, 180=S, 270=W).'),
          set_azimuth_degrees: z.number().describe('Azimuth at set, in degrees.'),
          peak_azimuth_degrees: z.number().describe('Azimuth at peak elevation, in degrees.'),
          duration_seconds: z.number().describe('Pass duration from rise to set, in seconds.'),
          sunlit: z
            .boolean()
            .describe(
              'True when the satellite is in sunlight at peak — a precondition for naked-eye visibility.',
            ),
        })
        .describe('One visible pass with rise/peak/set geometry and illumination.'),
    )
    .describe(
      'Visible passes (sunlit satellite over a dark-enough sky) in the requested window, chronological.',
    ),
});

export type SatellitePassesOutputType = z.infer<typeof SatellitePassesOutput>;

export const getSatellitePassesTool = tool('astronomy_get_satellite_passes', {
  title: 'astronomy-mcp-server: get satellite passes',
  description:
    "Predict visible passes of a satellite (e.g. the ISS, NORAD 25544) over an observer in the next `days`. Fetches the current TLE from CelesTrak, propagates it with SGP4 in-process, and returns each pass's rise, peak, and set times with azimuths and the peak elevation. Only passes that are naked-eye-plausible are returned — the satellite must be sunlit at peak while the observer's sky is dark. Every returned pass rises within the requested window: a pass already underway at `start` is omitted rather than reported with `start` as its rise, so back up `start` to see it. An element set that will not propagate to the window is rejected by name rather than returning an empty list, so an empty `passes` means only that nothing was visible. `start` must be within about a month of today — an element set describes the orbit for weeks around its epoch and cannot be propagated further. NORAD catalog numbers are found at celestrak.org or heavens-above.com. This is a gated, network-backed extension (CelesTrak is keyless but rate-limited; TLEs are cached briefly). Default elevation 0 m; pass an IANA timezone for observer-local pass times.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    norad_id: z
      .number()
      .int()
      .positive()
      .describe(
        'NORAD catalog number of the satellite, e.g. 25544 for the ISS. Found at celestrak.org or heavens-above.com.',
      ),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe('Observer latitude in decimal degrees, north positive.'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe('Observer longitude in decimal degrees, east positive.'),
    elevation: z
      .number()
      .default(0)
      .describe('Observer elevation in meters above sea level. Default 0.'),
    days: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(7)
      .describe('Number of days ahead to search for passes. Default 7, max 10.'),
    start: z
      .string()
      .optional()
      .describe(
        'Search start as an ISO 8601 UTC string, within about a month of today — the current element set cannot be propagated further. Defaults to now.',
      ),
    timezone: z
      .string()
      .optional()
      .describe(
        'IANA timezone for localized pass times, e.g. "America/Los_Angeles". When omitted, output is UTC-only.',
      ),
  }),
  output: SatellitePassesOutput,
  enrichment: {
    totalCount: z.number().describe('Number of visible passes found in the window.'),
  },
  errors: [
    {
      reason: 'invalid_time',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The start timestamp is not a parseable ISO 8601 instant.',
      recovery: 'Pass start as an ISO 8601 UTC timestamp, e.g. 2024-01-01T00:00:00Z, then retry.',
    },
    {
      reason: 'time_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The start instant is outside the SGP4 high-accuracy span (≈1900–2100), or too far from the epoch of the current element set for SGP4 to reach.',
      recovery:
        'Request a start within about a month of today — element sets only describe the orbit for weeks around their epoch.',
    },
    {
      reason: 'tle_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CelesTrak has no current element set for the NORAD ID.',
      recovery:
        'Verify the catalog number at celestrak.org; the object may have decayed or never been catalogued.',
    },
    {
      reason: 'object_decayed',
      code: JsonRpcErrorCode.NotFound,
      when: 'A current element set will not propagate to a window near its own epoch — the signature of an object that has reentered.',
      recovery:
        'Pick an object that is still in orbit; confirm its status at celestrak.org before requesting passes.',
    },
    {
      reason: 'celestrak_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The TLE fetch failed after retries.',
      retryable: true,
      recovery: 'CelesTrak is degraded or timed out; retry in a few minutes.',
    },
  ],

  async handler(input, ctx) {
    const satSvc = getSatelliteService();
    const ephSvc = getEphemerisService();
    const timezone = ephSvc.resolveTimezone(input.timezone ?? getServerConfig().defaultTimezone);
    /**
     * resolveTime() validates the instant (invalid_time / time_out_of_range) and returns
     * now when start is omitted — an Invalid Date here would yield NaN SGP4 positions and a
     * silently empty, falsely-successful pass list.
     */
    const start = ephSvc.resolveTime(input.start);
    const observer = {
      latitude: input.latitude,
      longitude: input.longitude,
      elevation: input.elevation,
    };

    const tle = await satSvc.fetchTle(input.norad_id, ctx);
    const formatLocal = timezone ? (d: Date) => ephSvc.formatLocal(d, timezone) : undefined;
    const result = satSvc.predictPasses(
      tle,
      input.norad_id,
      observer,
      input.days,
      start,
      formatLocal,
    );

    ctx.log.info('Predicted satellite passes', {
      noradId: input.norad_id,
      passes: result.passes.length,
    });
    ctx.enrich.total(result.passes.length);

    const out: SatellitePassesOutputType = {
      norad_id: result.noradId,
      ...(result.satelliteName ? { satellite_name: result.satelliteName } : {}),
      passes: result.passes.map((p) => ({
        rise_utc: p.riseUtc,
        peak_utc: p.peakUtc,
        set_utc: p.setUtc,
        ...(p.riseLocal ? { rise_local: p.riseLocal } : {}),
        ...(p.peakLocal ? { peak_local: p.peakLocal } : {}),
        ...(p.setLocal ? { set_local: p.setLocal } : {}),
        peak_altitude_degrees: p.peakAltitudeDegrees,
        rise_azimuth_degrees: p.riseAzimuthDegrees,
        set_azimuth_degrees: p.setAzimuthDegrees,
        peak_azimuth_degrees: p.peakAzimuthDegrees,
        duration_seconds: p.durationSeconds,
        sunlit: p.sunlit,
      })),
    };
    return out;
  },

  format: (r) => {
    const lines: string[] = [];
    const nameLabel = r.satellite_name ? `${r.satellite_name} ` : '';
    lines.push(`## ${nameLabel}(NORAD ${r.norad_id}) — ${r.passes.length} visible passes`);
    if (r.passes.length === 0)
      lines.push('No visible passes in the requested window (sunlit satellite over a dark sky).');
    for (const p of r.passes) {
      lines.push(
        `- rise_utc ${p.rise_utc}${p.rise_local ? ` (local ${p.rise_local})` : ''} az ${p.rise_azimuth_degrees.toFixed(1)}° → peak_utc ${p.peak_utc}${p.peak_local ? ` (local ${p.peak_local})` : ''} alt ${p.peak_altitude_degrees.toFixed(1)}° az ${p.peak_azimuth_degrees.toFixed(1)}° → set_utc ${p.set_utc}${p.set_local ? ` (local ${p.set_local})` : ''} az ${p.set_azimuth_degrees.toFixed(1)}°, duration ${p.duration_seconds.toFixed(0)}s, sunlit ${p.sunlit}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
