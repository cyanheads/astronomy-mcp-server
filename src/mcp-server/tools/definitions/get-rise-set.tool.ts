/**
 * @fileoverview astronomy_get_rise_set — rise, set, and culmination times for a body
 *   at a location, plus the Sun's three twilight pairs. Handles circumpolar /
 *   never-rises cases as null fields with an explanatory note.
 * @module mcp-server/tools/definitions/get-rise-set.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { BODY_NAMES, type TwilightPair } from '@/services/ephemeris/types.js';

/** Map the service's camelCase twilight pair to the snake_case wire shape. */
function toTwilightPair(p: TwilightPair): z.infer<typeof TwilightPairSchema> {
  return {
    dawn_utc: p.dawnUtc,
    dusk_utc: p.duskUtc,
    ...(p.dawnLocal !== undefined ? { dawn_local: p.dawnLocal } : {}),
    ...(p.duskLocal !== undefined ? { dusk_local: p.duskLocal } : {}),
  };
}

const TwilightPairSchema = z.object({
  dawn_utc: z
    .string()
    .nullable()
    .describe(
      'Dawn (Sun ascending through the depth) in ISO 8601 UTC, or null if it does not occur.',
    ),
  dusk_utc: z
    .string()
    .nullable()
    .describe(
      'Dusk (Sun descending through the depth) in ISO 8601 UTC, or null if it does not occur.',
    ),
  dawn_local: z
    .string()
    .nullable()
    .optional()
    .describe('Dawn in observer-local time, present only when a timezone was supplied.'),
  dusk_local: z
    .string()
    .nullable()
    .optional()
    .describe('Dusk in observer-local time, present only when a timezone was supplied.'),
});

export const RiseSetOutput = z.object({
  body: z.string().describe('The body these rise/set cycles are for, echoed from the request.'),
  events: z
    .array(
      z
        .object({
          rise_utc: z
            .string()
            .nullable()
            .describe(
              'Rise time in ISO 8601 UTC, or null when the body does not rise in this cycle (e.g. circumpolar).',
            ),
          set_utc: z
            .string()
            .nullable()
            .describe(
              'Set time in ISO 8601 UTC, or null when the body does not set in this cycle.',
            ),
          transit_utc: z
            .string()
            .nullable()
            .describe('Culmination (highest point) time in ISO 8601 UTC, or null when not found.'),
          transit_altitude_degrees: z
            .number()
            .nullable()
            .describe('Maximum altitude in degrees at culmination, or null when not found.'),
          rise_local: z
            .string()
            .optional()
            .describe(
              'Rise time in observer-local time, present only when a timezone was supplied.',
            ),
          set_local: z
            .string()
            .optional()
            .describe(
              'Set time in observer-local time, present only when a timezone was supplied.',
            ),
          transit_local: z
            .string()
            .optional()
            .describe(
              'Culmination time in observer-local time, present only when a timezone was supplied.',
            ),
          twilight: z
            .object({
              civil: TwilightPairSchema.describe('Civil twilight (Sun at −6°) dawn and dusk.'),
              nautical: TwilightPairSchema.describe(
                'Nautical twilight (Sun at −12°) dawn and dusk.',
              ),
              astronomical: TwilightPairSchema.describe(
                'Astronomical twilight (Sun at −18°) dawn and dusk — the dark-sky window.',
              ),
            })
            .optional()
            .describe('The three twilight pairs. Present only when body is "sun".'),
          note: z
            .string()
            .optional()
            .describe(
              'Explanatory note when a rise or set is absent (e.g. "Circumpolar — never sets at this latitude/date.").',
            ),
        })
        .describe('One rise/set/transit cycle, with twilight when the body is the Sun.'),
    )
    .describe('One entry per rise/set/transit cycle, searching forward from the start time.'),
});

export type RiseSetOutputType = z.infer<typeof RiseSetOutput>;

export const getRiseSetTool = tool('astronomy_get_rise_set', {
  title: 'astronomy-mcp-server: get rise/set times',
  description:
    'Compute rise, set, and culmination (transit) times for a body at an observer location, plus the maximum altitude at culmination. For the Sun, also returns the three twilight pairs (civil −6°, nautical −12°, astronomical −18°) so a single call answers "when does the sun set and when is it truly dark." Searches forward from `start` (default today) and returns the next `count` cycles (default 1). Circumpolar or never-rises situations are reported as null rise/set fields with an explanatory note rather than an error — the fact is the answer. Default elevation is 0 m; pass an IANA `timezone` for observer-local times. This server does not geocode — resolve coordinates upstream first.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    body: z
      .enum(BODY_NAMES)
      .describe('The body to compute rise/set for. Twilight is included only when this is "sun".'),
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
    start: z
      .string()
      .optional()
      .describe(
        'Search start as an ISO 8601 UTC string, e.g. "2024-06-21T00:00:00Z". Defaults to now.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(31)
      .default(1)
      .describe('Number of forward rise/set cycles to return. Default 1, max 31.'),
    timezone: z
      .string()
      .optional()
      .describe(
        'IANA timezone for localized output, e.g. "America/Los_Angeles". When omitted, output is UTC-only.',
      ),
  }),
  output: RiseSetOutput,
  enrichment: {
    totalCount: z.number().describe('Number of rise/set cycles returned.'),
  },
  errors: [
    {
      reason: 'time_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: "The requested start instant is outside the engine's high-accuracy span (≈1900–2100).",
      recovery: 'Use a start date between 1900 and 2100 and retry.',
    },
  ],

  handler(input, ctx) {
    const svc = getEphemerisService();
    const timezone = svc.resolveTimezone(input.timezone ?? getServerConfig().defaultTimezone);
    const start = svc.resolveTime(input.start);
    const observer = {
      latitude: input.latitude,
      longitude: input.longitude,
      elevation: input.elevation,
    };

    const events = svc.riseSet(input.body, observer, start, input.count, timezone);
    ctx.log.info('Computed rise/set', { body: input.body, cycles: events.length });
    ctx.enrich.total(events.length);

    const out: RiseSetOutputType = {
      body: input.body,
      events: events.map((e) => ({
        rise_utc: e.riseUtc,
        set_utc: e.setUtc,
        transit_utc: e.transitUtc,
        transit_altitude_degrees: e.transitAltitudeDegrees,
        ...(e.riseLocal ? { rise_local: e.riseLocal } : {}),
        ...(e.setLocal ? { set_local: e.setLocal } : {}),
        ...(e.transitLocal ? { transit_local: e.transitLocal } : {}),
        ...(e.twilight
          ? {
              twilight: {
                civil: toTwilightPair(e.twilight.civil),
                nautical: toTwilightPair(e.twilight.nautical),
                astronomical: toTwilightPair(e.twilight.astronomical),
              },
            }
          : {}),
        ...(e.note ? { note: e.note } : {}),
      })),
    };
    return out;
  },

  format: (r) => {
    const count = r.events.length;
    const lines: string[] = [`## ${r.body} — ${count} rise/set cycle${count === 1 ? '' : 's'}`];
    const stamp = (utc: string | null, local?: string) =>
      `${utc ?? 'none'}${local ? ` (local ${local})` : ''}`;
    r.events.forEach((e, i) => {
      const alt =
        e.transit_altitude_degrees === null
          ? ''
          : `, max alt ${e.transit_altitude_degrees.toFixed(1)}°`;
      lines.push(
        `${i + 1}. Rise ${stamp(e.rise_utc, e.rise_local)} · Set ${stamp(e.set_utc, e.set_local)} · Transit ${stamp(e.transit_utc, e.transit_local)}${alt}`,
      );
      if (e.note) lines.push(`   ${e.note}`);
      if (e.twilight) {
        const fmt = (label: string, p: z.infer<typeof TwilightPairSchema>) => {
          let line = `   ${label}: dawn ${p.dawn_utc ?? 'none'}, dusk ${p.dusk_utc ?? 'none'}`;
          if (p.dawn_local) line += `, dawn local ${p.dawn_local}`;
          if (p.dusk_local) line += `, dusk local ${p.dusk_local}`;
          return line;
        };
        lines.push(fmt('Civil twilight', e.twilight.civil));
        lines.push(fmt('Nautical twilight', e.twilight.nautical));
        lines.push(fmt('Astronomical twilight', e.twilight.astronomical));
      }
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
