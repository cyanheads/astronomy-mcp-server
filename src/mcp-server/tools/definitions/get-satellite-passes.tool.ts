/**
 * @fileoverview astronomy_get_satellite_passes — gated extension. Visible passes of a
 *   satellite (by NORAD catalog number, or by a name resolved against the catalog) over
 *   an observer, via a CelesTrak GP element set propagated with SGP4 offline, each with
 *   the stretch of it visible to the naked eye. Searches at most
 *   `SATELLITE_DAYS_PER_CALL` days per call and names the exact `start` and `days` that
 *   continue a longer request, while that start stays inside the element set's epoch
 *   horizon. Registered only when ASTRONOMY_ENABLE_SATELLITES is set.
 * @module mcp-server/tools/definitions/get-satellite-passes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { num } from '@/mcp-server/tools/format-numbers.js';
import { getEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { getSatelliteService } from '@/services/satellite/satellite-service.js';

/** Days searched per call; a larger `days` is served this many with a resume notice. */
const SATELLITE_DAYS_PER_CALL = 10;

/** Largest `days` accepted — the element set's own month-long reach. Past it the schema rejects. */
const SATELLITE_DAYS_CEILING = 30;

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
            .describe(
              'Rise above the horizon in ISO 8601 UTC, within 1 s of the true crossing. Can fall up to 30 s before `start` when the satellite rose inside the 30-second scan step ending at `start`.',
            ),
          peak_utc: z
            .string()
            .describe(
              'Time of maximum elevation in ISO 8601 UTC, the highest sample of a 30-second scan.',
            ),
          set_utc: z
            .string()
            .describe('Set below the horizon in ISO 8601 UTC, within 1 s of the true crossing.'),
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
            .describe(
              'Maximum elevation angle during the pass, in degrees, as sampled every 30 seconds.',
            ),
          rise_azimuth_degrees: z
            .number()
            .describe('Azimuth at `rise_utc`, in degrees (0=N, 90=E, 180=S, 270=W).'),
          set_azimuth_degrees: z.number().describe('Azimuth at `set_utc`, in degrees.'),
          peak_azimuth_degrees: z.number().describe('Azimuth at peak elevation, in degrees.'),
          duration_seconds: z
            .number()
            .describe('Pass duration from `rise_utc` to `set_utc`, in seconds.'),
          sunlit: z
            .boolean()
            .describe(
              "True when the satellite is in sunlight at the peak instant. False on a pass that enters Earth's shadow before its peak or leaves it after — the visible_* fields say when it can be seen.",
            ),
          visible_start_utc: z
            .string()
            .describe(
              "Start of the visible stretch — above the horizon, sunlit, over a dark sky — in ISO 8601 UTC. Equals `rise_utc` when the pass is visible from its rise; otherwise within 1 s of the moment it leaves Earth's shadow or the sky darkens.",
            ),
          visible_end_utc: z
            .string()
            .describe(
              "End of the visible stretch in ISO 8601 UTC. Equals `set_utc` when the pass is visible until it sets; otherwise within 1 s of the moment it enters Earth's shadow or the sky brightens.",
            ),
          visible_start_local: z
            .string()
            .optional()
            .describe(
              'Visible-stretch start in observer-local time, present only when a timezone was supplied.',
            ),
          visible_end_local: z
            .string()
            .optional()
            .describe(
              'Visible-stretch end in observer-local time, present only when a timezone was supplied.',
            ),
          visible_start_altitude_degrees: z
            .number()
            .describe(
              'Elevation where the visible stretch starts, in degrees — 0 when it starts at the rise.',
            ),
          visible_end_altitude_degrees: z
            .number()
            .describe(
              'Elevation where the visible stretch ends, in degrees — 0 when it ends at the set.',
            ),
          visible_start_azimuth_degrees: z
            .number()
            .describe(
              'Azimuth where the visible stretch starts, in degrees — where to look first.',
            ),
          visible_end_azimuth_degrees: z
            .number()
            .describe('Azimuth where the visible stretch ends, in degrees.'),
        })
        .describe(
          'One visible pass: horizon-to-horizon rise/peak/set geometry, illumination at peak, and the stretch of the pass that is visible to the naked eye.',
        ),
    )
    .describe(
      'Passes whose visible stretch — the satellite above the horizon and sunlit while the Sun is below −6° for the observer — reaches 10° elevation, in the window searched, chronological.',
    ),
});

export type SatellitePassesOutputType = z.infer<typeof SatellitePassesOutput>;

export const getSatellitePassesTool = tool('astronomy_get_satellite_passes', {
  title: 'astronomy-mcp-server: get satellite passes',
  description:
    "Predict visible passes of a satellite (e.g. the ISS, NORAD 25544) over an observer in the next `days`. Identify the satellite by exactly one of `norad_id` or `name` — supplying both, or neither, is rejected. A few well-known common names resolve directly to their catalog numbers, ignoring case: ISS or International Space Station (25544), Hubble, Hubble Space Telescope, or HST (20580), and Tiangong, CSS, or Chinese Space Station (48274). Any other `name` is matched as a case-insensitive substring of CelesTrak's catalog names, so it resolves only when it picks out a single object: a broader query comes back with the matching objects and their catalog numbers to choose from. Either way the result echoes the query that resolved it as `resolved_from_name`. Fetches the object's current GP element set from CelesTrak, propagates it with SGP4 in-process, and returns each pass's rise, peak, and set times with azimuths and the peak elevation, plus the stretch of the pass visible to the naked eye: `visible_start_utc` through `visible_end_utc`, with the elevation and azimuth at each end. A pass is returned when that visible stretch — the satellite above the horizon and sunlit while the Sun is below −6° for the observer — reaches 10° elevation, wherever in the pass it falls. `sunlit` reports illumination at the peak instant, so it is false on a pass seen only before it enters Earth's shadow or after it leaves. Rise, set, and the visible-stretch edges are within 1 s of the true instants; the peak is the highest sample of a 30-second scan. Every returned pass rises in the requested window or in the 30 s before `start`: a pass up longer than that at `start` is omitted rather than reported with `start` as its rise, so back up `start` to see it, while a pass still up when the window ends is reported through its actual set. Searches at most 10 days per call: a larger `days`, up to 30, searches the first 10 and returns a notice naming the exact `start` and `days` that continue the search with no pass repeated or skipped, while that start stays within about a month of the element set's epoch. A `start` further than about a month from the element set's epoch is rejected as out of range on that distance alone, and an element set that will not propagate to a window inside that horizon is rejected as a reentry — so an empty `passes` means only that nothing was visible. CelesTrak publishes only current element sets, so in practice `start` must be within about a month of today. NORAD catalog numbers and catalog names are found at celestrak.org or heavens-above.com. This is a gated, network-backed extension (CelesTrak is keyless but rate-limited; element sets are cached briefly). Default elevation 0 m; pass an IANA timezone for observer-local pass times.",
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
          'Satellite name to resolve, e.g. "ISS (ZARYA)". The common names ISS, International Space Station, Hubble, Hubble Space Telescope, HST, Tiangong, CSS, and Chinese Space Station resolve directly to their catalog numbers, ignoring case and surrounding whitespace. Any other name is matched against CelesTrak as a case-insensitive substring of the catalog name, so give the fullest name you have — a short one matches many objects and is rejected as ambiguous. Mutually exclusive with `norad_id` — supply exactly one.',
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
        .max(SATELLITE_DAYS_CEILING)
        .default(7)
        .describe(
          `Number of days ahead to search for passes. Default 7. At most ${SATELLITE_DAYS_PER_CALL} are searched per call; a value up to ${SATELLITE_DAYS_CEILING} searches the first ${SATELLITE_DAYS_PER_CALL} with a notice naming the \`start\` and \`days\` that continue the search.`,
        ),
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
     * Strictness is declared here rather than left to `tool()`, which applies its own
     * `.strict()` to an input that declares no catchall. That call builds a new schema,
     * and Zod keys `.meta()` to the instance it was set on — so a framework-applied
     * `.strict()` would drop the `oneOf` below and publish an `inputSchema` that no
     * longer states the exclusivity. Strictening first puts `.meta()` on the schema that
     * survives, so the emitted shape carries both `additionalProperties: false` and the
     * branches. Same semantics either way — `.strict()` is the catchall `tool()` looks for.
     */
    .strict()
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
    totalCount: z.number().describe('Number of visible passes found in the window searched.'),
    notice: z
      .string()
      .optional()
      .describe(
        "How to search the days the per-call cap held back: the exact `start` and `days` to re-call with, or — when that start would lie more than about a month from the element set's epoch — that no call can search them. Absent when every requested day was searched.",
      ),
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
      thrownBy: 'service',
    },
    {
      reason: 'time_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The start instant falls outside the years 1900–2100, or more than about a month from the epoch of the current element set — checked on the epoch distance itself, since SGP4 keeps returning positions well past the point where the mean elements describe the orbit.',
      /**
       * Both checks send this hint: resolveTime()'s year-span rejection carries none, so the
       * framework fills it, and SatelliteService writes it verbatim at the epoch-distance throw.
       */
      recovery:
        'An element set describes the orbit for weeks either side of its epoch — request a start within about a month of today.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_timezone',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The `timezone` value is not an IANA zone this runtime knows.',
      // Verbatim the hint EphemerisService.resolveTimezone() throws with.
      recovery: 'Pass a valid IANA timezone like America/Los_Angeles or UTC.',
      thrownBy: 'service',
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
      thrownBy: 'service',
    },
    {
      reason: 'satellite_name_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No current CelesTrak object has a name containing the `name` value.',
      recovery:
        'Check the spelling, try a shorter distinctive substring, or look the object up at celestrak.org.',
      thrownBy: 'service',
    },
    {
      reason: 'ambiguous_satellite_name',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The `name` value matches more than one current object and none of them carries it as their whole name. The error names the match count and lists the matching objects with their catalog numbers, capped when there are more than the list holds. A capped list carries a hint leading with narrowing instead of with the list, since the wanted object need not be among the ones shown.',
      recovery:
        'Re-call with norad_id set to one of the listed candidates, or supply a longer, more specific name.',
      thrownBy: 'service',
    },
    {
      reason: 'object_decayed',
      code: JsonRpcErrorCode.NotFound,
      when: 'A current element set will not propagate to a window near its own epoch — the signature of an object that has reentered.',
      recovery:
        'Pick an object that is still in orbit; confirm its status at celestrak.org before requesting passes.',
      thrownBy: 'service',
    },
    {
      reason: 'celestrak_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The element-set fetch failed after retries, or returned a body that is not JSON at all.',
      retryable: true,
      recovery: 'CelesTrak is degraded or timed out; retry in a few minutes.',
      thrownBy: 'service',
    },
    {
      reason: 'malformed_element_set',
      code: JsonRpcErrorCode.SerializationError,
      when: 'CelesTrak answered with parsable JSON whose GP record does not carry the fields an OMM element set requires — a permanent property of that record, not the transient outage celestrak_unavailable covers. The same request returns the same record, so retrying it can only fail again.',
      recovery:
        'Retrying returns the same record — request a different object, and report the element set to celestrak.org.',
      thrownBy: 'service',
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
      );
    }
    const timezone = ephSvc.resolveTimezone(input.timezone ?? getServerConfig().defaultTimezone);
    /**
     * resolveTime() validates the instant (invalid_time / time_out_of_range) and returns
     * now when start is omitted — an Invalid Date here would yield NaN SGP4 positions and a
     * silently empty, falsely-successful pass list. Its year-span rejection carries no
     * hint, so this tool's declared recovery fills it — the one that also covers the
     * epoch-distance check.
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
    const searchedDays = Math.min(input.days, SATELLITE_DAYS_PER_CALL);
    const result = satSvc.predictPasses(elements, observer, searchedDays, start, formatLocal);

    ctx.log.info('Predicted satellite passes', {
      noradId: result.noradId,
      resolvedFromName: nameQuery,
      passes: result.passes.length,
    });
    ctx.enrich.total(result.passes.length);
    if (input.days > searchedDays) {
      /**
       * `resumeAt` is one scan step past the window's end: this call already reported every
       * pass rising by then, through its set, so a call from there continues the search
       * with none repeated and none skipped. The epoch horizon checks `start` only, so a
       * window opened late in it can end with the resume instant beyond it — that call
       * would fail time_out_of_range, and its recovery cannot reach the days left, so the
       * notice names no call then.
       */
      const searched = `Searched ${searchedDays} of the ${input.days} requested days (${SATELLITE_DAYS_PER_CALL} per call), through ${result.windowEnd.toISOString()}.`;
      const remaining = input.days - searchedDays;
      ctx.enrich.notice(
        result.resumeInRange
          ? `${searched} Re-call with start ${result.resumeAt.toISOString()} and days ${remaining} for the rest.`
          : `${searched} The remaining ${remaining} days start more than about a month from the element set's epoch, where it no longer describes the orbit, so no call can search them.`,
      );
    }

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
        visible_start_utc: p.visibleStartUtc,
        visible_end_utc: p.visibleEndUtc,
        ...(p.visibleStartLocal ? { visible_start_local: p.visibleStartLocal } : {}),
        ...(p.visibleEndLocal ? { visible_end_local: p.visibleEndLocal } : {}),
        visible_start_altitude_degrees: p.visibleStartAltitudeDegrees,
        visible_end_altitude_degrees: p.visibleEndAltitudeDegrees,
        visible_start_azimuth_degrees: p.visibleStartAzimuthDegrees,
        visible_end_azimuth_degrees: p.visibleEndAzimuthDegrees,
      })),
    };
    return out;
  },

  format: (r) => {
    const lines: string[] = [];
    const nameLabel = r.satellite_name ? `${r.satellite_name} ` : '';
    lines.push(
      `## ${nameLabel}(NORAD ${r.norad_id}) — ${r.passes.length} visible pass${r.passes.length === 1 ? '' : 'es'}`,
    );
    if (r.resolved_from_name) lines.push(`Resolved from the name query "${r.resolved_from_name}".`);
    if (r.passes.length === 0)
      lines.push(
        'No visible passes in the window searched (sunlit satellite over a dark sky, reaching 10°).',
      );
    const local = (stamp: string | undefined) => (stamp ? ` (local ${stamp})` : '');
    for (const p of r.passes) {
      lines.push(
        `- rise_utc ${p.rise_utc}${local(p.rise_local)} az ${num(p.rise_azimuth_degrees, 1, '°')} → peak_utc ${p.peak_utc}${local(p.peak_local)} alt ${num(p.peak_altitude_degrees, 1, '°')} az ${num(p.peak_azimuth_degrees, 1, '°')} → set_utc ${p.set_utc}${local(p.set_local)} az ${num(p.set_azimuth_degrees, 1, '°')}, duration ${num(p.duration_seconds, 0, 's')}, sunlit ${p.sunlit}`,
        `  visible: visible_start_utc ${p.visible_start_utc}${local(p.visible_start_local)} alt ${num(p.visible_start_altitude_degrees, 1, '°')} az ${num(p.visible_start_azimuth_degrees, 1, '°')} → visible_end_utc ${p.visible_end_utc}${local(p.visible_end_local)} alt ${num(p.visible_end_altitude_degrees, 1, '°')} az ${num(p.visible_end_azimuth_degrees, 1, '°')}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
