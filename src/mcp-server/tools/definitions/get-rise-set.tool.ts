/**
 * @fileoverview astronomy_get_rise_set — rise, set, and culmination times for a body
 *   at a location, plus the Sun's three twilight pairs per cycle and for the night under
 *   way at the start. Handles circumpolar / never-rises cases as null fields with an
 *   explanatory note. Serves at most `RISE_SET_PER_CALL` cycles per call and names the
 *   exact `start` and `count` that continue a longer request, while that start lies
 *   inside the supported span.
 * @module mcp-server/tools/definitions/get-rise-set.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { num } from '@/mcp-server/tools/format-numbers.js';
import { getEphemerisService, SUPPORTED_SPAN } from '@/services/ephemeris/ephemeris-service.js';
import { BODY_NAMES, type TwilightPair, type TwilightSet } from '@/services/ephemeris/types.js';

/** Cycles computed per call; a larger `count` is served this many with a resume notice. */
const RISE_SET_PER_CALL = 31;

/** Largest `count` accepted — a year of daily cycles. Past it the schema rejects. */
const RISE_SET_COUNT_CEILING = 366;

/** Map the service's camelCase twilight pair to the snake_case wire shape. */
function toTwilightPair(p: TwilightPair): z.infer<typeof TwilightPairSchema> {
  return {
    dawn_utc: p.dawnUtc,
    dusk_utc: p.duskUtc,
    ...(p.dawnLocal !== undefined ? { dawn_local: p.dawnLocal } : {}),
    ...(p.duskLocal !== undefined ? { dusk_local: p.duskLocal } : {}),
  };
}

/** Map all three depths of a twilight set to the wire shape. */
function toTwilightSet(t: TwilightSet): z.infer<typeof TwilightSetSchema> {
  return {
    civil: toTwilightPair(t.civil),
    nautical: toTwilightPair(t.nautical),
    astronomical: toTwilightPair(t.astronomical),
  };
}

const TwilightPairSchema = z.object({
  dawn_utc: z
    .string()
    .nullable()
    .describe(
      "Dawn (Sun ascending through the depth) in ISO 8601 UTC, or null when the night never reaches the depth. It ends the night that begins at the dusk beside it: in a cycle, the morning after that cycle's set, or after its culmination when it has no set — a day later than the cycle's rise, not the dawn before it.",
    ),
  dusk_utc: z
    .string()
    .nullable()
    .describe(
      "Dusk (Sun descending through the depth) in ISO 8601 UTC, or null when the night never reaches the depth. It is the evening the night begins: in a cycle, the evening of that cycle's set, or after its culmination when it has no set.",
    ),
  dawn_local: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Dawn in observer-local time — the morning that ends the night — present only when a timezone was supplied.',
    ),
  dusk_local: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Dusk in observer-local time — the evening that begins the night — present only when a timezone was supplied.',
    ),
});

const TwilightSetSchema = z.object({
  civil: TwilightPairSchema.describe('Civil twilight (Sun at −6°): dusk and the following dawn.'),
  nautical: TwilightPairSchema.describe(
    'Nautical twilight (Sun at −12°): dusk and the following dawn.',
  ),
  astronomical: TwilightPairSchema.describe(
    'Astronomical twilight (Sun at −18°): dusk and the following dawn, bounding the dark-sky window.',
  ),
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
              'Rise time in ISO 8601 UTC, or null when the body does not rise in this cycle — because it is circumpolar, or because it was already above the horizon when the cycle opened (at the search start, or after a day it never set on), so its rise precedes the cycle. The accompanying note says which.',
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
            .describe(
              'Culmination (highest point) time in ISO 8601 UTC, or null when it falls outside this cycle — before its rise, after its set, or before the search start.',
            ),
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
          twilight: TwilightSetSchema.optional().describe(
            "The three twilight pairs, present only when body is \"sun\". Each pair spans one night: dusk is the evening of this cycle's set — or, in a cycle with no set, the evening after its culmination — and dawn is the following morning, so a cycle's dawn falls a day after its rise. Each is searched only up to the start of the next cycle's day (its sunrise, or its culmination when it has no rise), so a depth the night never reaches is null. A first cycle with no rise, set, or transit is the rest of the day the search started in, inside or at the edge of a polar night; its pairs can include times before `start` that have passed. The dawn before a given sunrise is in the previous cycle's pair; before the first cycle's sunrise it is in `night_in_progress` when `start` falls in a night that began with a sunset, and otherwise start the search a day earlier to get it.",
          ),
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
  night_in_progress: TwilightSetSchema.optional().describe(
    'The night under way at `start`, present only when body is "sun", the Sun is below the horizon at `start`, it set since its last culmination and within the two days before, and it rises within the two days after. The first cycle then opens with the next day — at its sunrise, or its culmination when the Sun does not rise that day — and its twilight is the night after, so this field holds the night the caller is in: for each depth, dusk on the evening of that sunset and dawn before the day of the first cycle begins. Times earlier than `start` are included and have already passed. Each pair is searched only within that night, so a depth the night never reaches is null. Absent when a day the Sun never rose on fell between the last sunset and `start`: that sunset began an earlier night. A continuation call, started one second past the last set of the previous call, repeats here the night the last cycle of that call carried; its `events` do not repeat. Not one of `events` and not counted by `count`.',
  ),
});

export type RiseSetOutputType = z.infer<typeof RiseSetOutput>;

export const getRiseSetTool = tool('astronomy_get_rise_set', {
  title: 'astronomy-mcp-server: get rise/set times',
  description:
    'Compute rise, set, and culmination (transit) times for a body at an observer location, plus the maximum altitude at culmination. For the Sun, also returns the three twilight pairs (civil −6°, nautical −12°, astronomical −18°) so a single call answers "when does the sun set and when is it truly dark." Each pair covers the night after the cycle\'s set (after its culmination when it has none) — dusk that evening, dawn the next morning — so the dawn listed beside a sunrise is the following day\'s. A depth a night never reaches (astronomical twilight around midsummer at mid-to-high latitudes) is null for that night. When `start` falls between sunset and sunrise, the first cycle opens at the next sunrise and `night_in_progress` carries the night already under way, dusk through dawn, including times before `start` that have passed; otherwise, for the dawn before a sunrise, read the previous cycle or start a day earlier. Searches forward from `start` (default today) and returns the next `count` cycles (default 1), up to 31 per call: a larger `count`, up to 366, returns the first 31 and a notice naming the exact `start` and `count` that continue the series, or saying no call can when the next cycle starts after 2100; a continuation started just past a sunset repeats in `night_in_progress` the night the last cycle of the previous call carried, while its cycles pick up without overlap. When the body is already above the horizon at `start`, the first cycle is the interval in progress: its `set` is the imminent one and its `rise` is null, since that rise precedes the search — so a set is never reported earlier than the rise beside it. Circumpolar or never-rises situations are reported as null rise/set fields with an explanatory note rather than an error — the fact is the answer. One cycle covers one day: a day the body neither rises nor sets on (polar night, midnight sun) is a cycle of its own, so consecutive cycles are consecutive days and each night appears in exactly one cycle. When `start` falls after the culmination of such a polar-night day, or after the last sunset before one, the first cycle is the rest of that day — rise, set, and transit null — carrying the twilight of that night, including times before `start` that have passed. Default elevation is 0 m; pass an IANA `timezone` for observer-local times. This server does not geocode — resolve coordinates upstream first.',
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
        'Search start as an ISO 8601 UTC string, e.g. "2024-06-21T00:00:00Z". Defaults to now. A value with no zone designator is read as UTC, not the local zone of the server process.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(RISE_SET_COUNT_CEILING)
      .default(1)
      .describe(
        `Number of forward rise/set cycles to return. Default 1. At most ${RISE_SET_PER_CALL} are computed per call; a count up to ${RISE_SET_COUNT_CEILING} returns the first ${RISE_SET_PER_CALL} with a notice naming the \`start\` and \`count\` that continue the series.`,
      ),
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
    truncated: z
      .boolean()
      .optional()
      .describe('True when `count` exceeded the per-call cap and only the first cycles came back.'),
    shown: z.number().optional().describe('Number of cycles returned when the cap applied.'),
    cap: z.number().optional().describe('The per-call cycle cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'How to retrieve the cycles the per-call cap held back: the exact `start` and `count` to re-call with, or — when the next cycle starts after 2100, the end of the supported span — that no call can continue the series. Absent when every requested cycle came back.',
      ),
  },
  errors: [
    {
      reason: 'invalid_time',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The `start` value is not a parseable ISO 8601 instant, or names a calendar date that does not exist (e.g. 2026-02-30).',
      // Verbatim the hint EphemerisService.resolveTime() throws with, so the contract
      // documents the same next move the client is handed on the wire.
      recovery:
        'Pass the timestamp as an ISO 8601 UTC instant with a real calendar date, e.g. 2024-01-01T00:00:00Z, then retry.',
      thrownBy: 'service',
    },
    {
      reason: 'time_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: "The requested start instant is outside the engine's high-accuracy span (≈1900–2100).",
      // resolveTime() throws this reason with no hint, so this string is the wire hint.
      recovery: 'Use a start date between 1900 and 2100 and retry.',
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

    const served = Math.min(input.count, RISE_SET_PER_CALL);
    const { events, nightInProgress, resumeAt } = svc.riseSetSearch(
      input.body,
      observer,
      start,
      served,
      timezone,
    );
    ctx.log.info('Computed rise/set', { body: input.body, cycles: events.length });
    ctx.enrich.total(events.length);
    if (input.count > served) {
      /**
       * `resumeAt` is where the cycle loop itself would continue, so a call from there
       * returns the next cycles exactly — none repeated, none skipped. The loop computes
       * cycles past 2100 but `start` must lie inside the span, so a resume instant past it
       * names no call: that one would fail time_out_of_range.
       */
      const returned = `Returned ${events.length} of the ${input.count} requested cycles (${RISE_SET_PER_CALL} per call).`;
      ctx.enrich.truncated({
        shown: events.length,
        cap: RISE_SET_PER_CALL,
        guidance:
          resumeAt.getUTCFullYear() > SUPPORTED_SPAN.lastYear
            ? `${returned} The next cycle starts past the end of the supported span (${SUPPORTED_SPAN.lastYear}), so no call can continue the series.`
            : `${returned} Re-call with start ${resumeAt.toISOString()} and count ${input.count - events.length} for the rest.`,
      });
    }

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
        ...(e.twilight ? { twilight: toTwilightSet(e.twilight) } : {}),
        ...(e.note ? { note: e.note } : {}),
      })),
      ...(nightInProgress ? { night_in_progress: toTwilightSet(nightInProgress) } : {}),
    };
    return out;
  },

  format: (r) => {
    const count = r.events.length;
    const lines: string[] = [`## ${r.body} — ${count} rise/set cycle${count === 1 ? '' : 's'}`];
    const stamp = (utc: string | null, local?: string) =>
      `${utc ?? 'none'}${local ? ` (local ${local})` : ''}`;
    const twilightLines = (t: z.infer<typeof TwilightSetSchema>) => {
      const fmt = (label: string, p: z.infer<typeof TwilightPairSchema>) => {
        let line = `   ${label}: dawn ${p.dawn_utc ?? 'none'}, dusk ${p.dusk_utc ?? 'none'}`;
        if (p.dawn_local) line += `, dawn local ${p.dawn_local}`;
        if (p.dusk_local) line += `, dusk local ${p.dusk_local}`;
        return line;
      };
      return [
        fmt('Civil twilight', t.civil),
        fmt('Nautical twilight', t.nautical),
        fmt('Astronomical twilight', t.astronomical),
      ];
    };
    if (r.night_in_progress) {
      lines.push(
        'Night in progress (under way at the search start; times before the start have already passed):',
        ...twilightLines(r.night_in_progress),
      );
    }
    r.events.forEach((e, i) => {
      const alt =
        e.transit_altitude_degrees === null
          ? ''
          : `, max alt ${num(e.transit_altitude_degrees, 1, '°')}`;
      lines.push(
        `${i + 1}. Rise ${stamp(e.rise_utc, e.rise_local)} · Set ${stamp(e.set_utc, e.set_local)} · Transit ${stamp(e.transit_utc, e.transit_local)}${alt}`,
      );
      if (e.note) lines.push(`   ${e.note}`);
      if (e.twilight) lines.push(...twilightLines(e.twilight));
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
