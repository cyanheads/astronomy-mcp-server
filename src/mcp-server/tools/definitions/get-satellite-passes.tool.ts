/**
 * @fileoverview astronomy_get_satellite_passes — gated extension. Visible passes of a
 *   satellite (by NORAD catalog number, or by a name resolved against the catalog) over
 *   an observer, via a CelesTrak GP element set propagated with SGP4 offline. Registered
 *   only when ASTRONOMY_ENABLE_SATELLITES is set.
 * @module mcp-server/tools/definitions/get-satellite-passes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { num } from '@/mcp-server/tools/format-numbers.js';
import { getEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { getSatelliteService } from '@/services/satellite/satellite-service.js';

export const SatellitePassesOutput = z.object({
  norad_id: z.number().describe('The NORAD catalog number echoed from the request.'),
  satellite_name: z
    .string()
    .optional()
    .describe("Satellite name as CelesTrak catalogs it (the element set's OBJECT_NAME)."),
  resolved_from_name: z
    .string()
    .optional()
    .describe(
      'The name query that resolved this object. Present only when the request supplied `name` rather than `norad_id`.',
    ),
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
    "Predict visible passes of a satellite (e.g. the ISS, NORAD 25544) over an observer in the next `days`. Identify the satellite by exactly one of `norad_id` or `name` — supplying both, or neither, is rejected. `name` is matched as a case-insensitive substring of CelesTrak's catalog names, so it resolves only when it picks out a single object: a broader query comes back with the matching objects and their catalog numbers to choose from, and the result echoes the query that resolved it as `resolved_from_name`. Fetches the object's current GP element set from CelesTrak, propagates it with SGP4 in-process, and returns each pass's rise, peak, and set times with azimuths and the peak elevation. Only passes that are naked-eye-plausible are returned — the satellite must be sunlit at peak while the observer's sky is dark. Every returned pass rises within the requested window: a pass already underway at `start` is omitted rather than reported with `start` as its rise, so back up `start` to see it. A `start` further than about a month from the element set's epoch is rejected as out of range on that distance alone, and an element set that will not propagate to a window inside that horizon is rejected as a reentry — so an empty `passes` means only that nothing was visible. CelesTrak publishes only current element sets, so in practice `start` must be within about a month of today. NORAD catalog numbers and catalog names are found at celestrak.org or heavens-above.com. This is a gated, network-backed extension (CelesTrak is keyless but rate-limited; element sets are cached briefly). Default elevation 0 m; pass an IANA timezone for observer-local pass times.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z
    .object({
      norad_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'NORAD catalog number of the satellite, e.g. 25544 for the ISS. Found at celestrak.org or heavens-above.com. Mutually exclusive with `name` — supply exactly one.',
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Satellite name to resolve against CelesTrak, e.g. "ISS (ZARYA)". Matched as a case-insensitive substring of the catalog name, so give the fullest name you have — a short one matches many objects and is rejected as ambiguous. Mutually exclusive with `norad_id` — supply exactly one.',
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
          "Search start as an ISO 8601 UTC string, within about a month of the current element set's epoch — for a tracked object that epoch is hours old, so in practice within about a month of today. A start further out is rejected rather than answered from elements that no longer describe the orbit. Defaults to now. A value with no zone designator is read as UTC, not the local zone of the server process.",
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          'IANA timezone for localized pass times, e.g. "America/Los_Angeles". When omitted, output is UTC-only.',
        ),
    })
    /**
     * `norad_id` and `name` are two ways of naming one object, so neither can be marked
     * required on its own. `oneOf` carries the exclusivity into the emitted JSON Schema,
     * where a validating client can act on it — with `type` on each branch, since Gemini
     * rejects an untyped one. The handler enforces the same rule with a typed failure, so
     * a client that does not validate still gets a hint rather than a schema error.
     */
    .meta({
      oneOf: [
        { type: 'object', required: ['norad_id'], not: { required: ['name'] } },
        { type: 'object', required: ['name'], not: { required: ['norad_id'] } },
      ],
    }),
  output: SatellitePassesOutput,
  enrichment: {
    totalCount: z.number().describe('Number of visible passes found in the window.'),
  },
  errors: [
    {
      reason: 'invalid_time',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The start timestamp is not a parseable ISO 8601 instant, or names a calendar date that does not exist (e.g. 2026-02-30).',
      // Verbatim the hint EphemerisService.resolveTime() throws with, so the contract
      // documents the same next move the client is handed on the wire.
      recovery:
        'Pass the timestamp as an ISO 8601 UTC instant with a real calendar date, e.g. 2024-01-01T00:00:00Z, then retry.',
    },
    {
      reason: 'time_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The start instant is outside the SGP4 high-accuracy span (≈1900–2100), or more than about a month from the epoch of the current element set — checked on the epoch distance itself, since SGP4 keeps returning positions well past the point where the mean elements describe the orbit.',
      recovery:
        'Request a start within about a month of today — element sets only describe the orbit for weeks around their epoch.',
    },
    {
      reason: 'invalid_timezone',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The `timezone` value is not an IANA zone this runtime knows.',
      // Verbatim the hint EphemerisService.resolveTimezone() throws with.
      recovery: 'Pass a valid IANA timezone like America/Los_Angeles or UTC.',
    },
    {
      reason: 'invalid_target',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither `norad_id` nor `name` was supplied, or both were.',
      // Verbatim the hint the handler throws with, so the contract documents the same
      // next move the client is handed on the wire.
      recovery:
        'Supply exactly one of norad_id or name — norad_id when the catalog number is known, name otherwise.',
    },
    {
      reason: 'tle_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CelesTrak has no current element set for the NORAD ID.',
      // Verbatim the hint SatelliteService throws with, as are the four below.
      recovery:
        'Verify the catalog number at celestrak.org; the object may have decayed or never been catalogued.',
    },
    {
      reason: 'satellite_name_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No current CelesTrak object has a name containing the `name` value.',
      recovery:
        'Check the spelling, try a shorter distinctive substring, or look the object up at celestrak.org.',
    },
    {
      reason: 'ambiguous_satellite_name',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The `name` value matches more than one current object and none of them carries it as their whole name. The error names the match count and lists the matching objects with their catalog numbers, capped when there are more than the list holds. A capped list carries a hint leading with narrowing instead of with the list, since the wanted object need not be among the ones shown.',
      recovery:
        'Re-call with norad_id set to one of the listed candidates, or supply a longer, more specific name.',
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
      when: 'The element-set fetch failed after retries, or returned a body that is not JSON at all.',
      retryable: true,
      recovery: 'CelesTrak is degraded or timed out; retry in a few minutes.',
    },
    {
      reason: 'malformed_element_set',
      code: JsonRpcErrorCode.SerializationError,
      when: 'CelesTrak answered with parsable JSON whose GP record does not carry the fields an OMM element set requires — a permanent property of that record, not the transient outage celestrak_unavailable covers. The same request returns the same record, so retrying it can only fail again.',
      recovery:
        'Retrying returns the same record — request a different object, and report the element set to celestrak.org.',
    },
  ],

  async handler(input, ctx) {
    const satSvc = getSatelliteService();
    const ephSvc = getEphemerisService();
    const noradId = input.norad_id;
    /**
     * Form-based clients send an omitted string as `''`, so a blank `name` is the absence
     * of one rather than a query for every object in the catalog.
     */
    const nameQuery = input.name?.trim() || undefined;
    if ((noradId === undefined) === (nameQuery === undefined)) {
      throw ctx.fail(
        'invalid_target',
        'Identify the satellite with exactly one of `norad_id` or `name`.',
        ctx.recoveryFor('invalid_target'),
      );
    }
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

    /**
     * The guard above is what pairs the two selectors, and TypeScript cannot follow that
     * across two independent optionals — hence the assertion on the arm it rules out.
     */
    const elements =
      noradId === undefined
        ? await satSvc.resolveByName(nameQuery as string, ctx)
        : await satSvc.fetchElementSet(noradId, ctx);
    const formatLocal = timezone ? (d: Date) => ephSvc.formatLocal(d, timezone) : undefined;
    const result = satSvc.predictPasses(elements, observer, input.days, start, formatLocal);

    ctx.log.info('Predicted satellite passes', {
      noradId: result.noradId,
      resolvedFromName: nameQuery,
      passes: result.passes.length,
    });
    ctx.enrich.total(result.passes.length);

    const out: SatellitePassesOutputType = {
      norad_id: result.noradId,
      satellite_name: result.satelliteName,
      ...(nameQuery ? { resolved_from_name: nameQuery } : {}),
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
    if (r.resolved_from_name) lines.push(`Resolved from the name query "${r.resolved_from_name}".`);
    if (r.passes.length === 0)
      lines.push('No visible passes in the requested window (sunlit satellite over a dark sky).');
    for (const p of r.passes) {
      lines.push(
        `- rise_utc ${p.rise_utc}${p.rise_local ? ` (local ${p.rise_local})` : ''} az ${num(p.rise_azimuth_degrees, 1, '°')} → peak_utc ${p.peak_utc}${p.peak_local ? ` (local ${p.peak_local})` : ''} alt ${num(p.peak_altitude_degrees, 1, '°')} az ${num(p.peak_azimuth_degrees, 1, '°')} → set_utc ${p.set_utc}${p.set_local ? ` (local ${p.set_local})` : ''} az ${num(p.set_azimuth_degrees, 1, '°')}, duration ${num(p.duration_seconds, 0, 's')}, sunlit ${p.sunlit}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
