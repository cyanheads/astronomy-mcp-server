/**
 * @fileoverview astronomy_find_events — consolidated forward search for nine event
 *   classes under one `event` enum. Solar eclipses take an observer for local
 *   circumstances; every other class, lunar eclipses included, is geocentric.
 *   Validation gates fail fast when an event needs a body or an observer that was
 *   not supplied, or when the body has no such event.
 * @module mcp-server/tools/definitions/find-events.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { num, pct, sig } from '@/mcp-server/tools/format-numbers.js';
import { getEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { EVENT_BODY_NAMES, EVENT_NAMES, type EventName } from '@/services/ephemeris/types.js';

const BODY_EVENTS = new Set<EventName>([
  'opposition',
  'conjunction',
  'max_elongation',
  'perigee_apogee',
]);

export const FindEventsOutput = z.object({
  events: z
    .array(
      z
        .object({
          event: z.enum(EVENT_NAMES).describe('The event class this record belongs to.'),
          time_utc: z.string().describe('Time of the event (peak, for eclipses) in ISO 8601 UTC.'),
          time_local: z
            .string()
            .optional()
            .describe(
              'Event time in observer-local time, present only when a timezone was supplied.',
            ),
          kind: z
            .string()
            .optional()
            .describe(
              'Eclipse classification: "penumbral", "partial", "annular", or "total". Present for eclipses.',
            ),
          obscuration: z
            .number()
            .nullable()
            .optional()
            .describe(
              'Peak fraction of the disc obscured, 0 to 1. Null/absent when undefined for a global partial solar eclipse.',
            ),
          local_visible: z
            .boolean()
            .optional()
            .describe(
              "True when the eclipsed Sun is above the observer's horizon at peak. Present for solar eclipses only — lunar eclipses are geocentric and report no local visibility.",
            ),
          contacts: z
            .record(z.string(), z.string().nullable())
            .optional()
            .describe(
              'Eclipse contact times in ISO 8601 UTC keyed by phase (e.g. partial_begin_utc, peak_utc); a phase that does not occur is null.',
            ),
          which: z
            .enum(['march', 'september', 'june', 'december'])
            .optional()
            .describe('Which equinox or solstice. Present for equinox/solstice events.'),
          quarter: z
            .enum(['new', 'first_quarter', 'full', 'last_quarter'])
            .optional()
            .describe('Which lunar quarter. Present for moon_quarter events.'),
          body: z
            .string()
            .optional()
            .describe(
              'The target body. Present for opposition/conjunction/max_elongation/perigee_apogee.',
            ),
          conjunction_kind: z
            .enum(['inferior', 'superior'])
            .optional()
            .describe(
              'Whether the planet passes between Earth and the Sun (inferior) or behind the Sun (superior). Present only for mercury and venus conjunctions, the two bodies that reach both.',
            ),
          elongation_degrees: z
            .number()
            .optional()
            .describe(
              'Greatest-elongation angle in degrees from the Sun. Present for max_elongation.',
            ),
          visibility: z
            .enum(['morning', 'evening'])
            .optional()
            .describe(
              'Whether the apparition is in the morning or evening sky. Present for max_elongation.',
            ),
          apsis_kind: z
            .enum(['perigee', 'apogee', 'perihelion', 'aphelion'])
            .optional()
            .describe('Apsis classification. Present for perigee_apogee events.'),
          distance_km: z
            .number()
            .optional()
            .describe(
              'Center-to-center distance at the apsis in kilometers. Present for perigee_apogee.',
            ),
          distance_au: z
            .number()
            .optional()
            .describe(
              'Center-to-center distance at the apsis in astronomical units. Present for perigee_apogee.',
            ),
        })
        .describe(
          'One event occurrence; which detail fields are present depends on the event class.',
        ),
    )
    .describe('The next occurrences of the requested event class, in chronological order.'),
});

export type FindEventsOutputType = z.infer<typeof FindEventsOutput>;

export const findEventsTool = tool('astronomy_find_events', {
  title: 'astronomy-mcp-server: find sky events',
  description:
    'Search forward from a start time for the next occurrences of one sky-event class, selected by the `event` enum: solar_eclipse, lunar_eclipse, equinox, solstice, moon_quarter, opposition, conjunction, max_elongation, or perigee_apogee. Only solar_eclipse takes an observer: pass latitude and longitude to get local circumstances (contact times plus `local_visible`). Every other class is geocentric and needs no location — a lunar eclipse is the same event everywhere the Moon is up, so it returns contact times and no `local_visible`. The body-relative events (opposition, conjunction, max_elongation, perigee_apogee) require a `body`: opposition applies to the superior planets (mars through pluto), conjunction to any planet, max_elongation to mercury and venus, and perigee_apogee to the moon (perigee/apogee), earth, or a planet (perihelion/aphelion). Returns the next `count` occurrences (default 1). Start defaults to now; pass an IANA `timezone` for observer-local timestamps.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    event: z.enum(EVENT_NAMES).describe('Which class of event to search for.'),
    start: z
      .string()
      .optional()
      .describe(
        'Search start as an ISO 8601 UTC string, e.g. "2024-01-01T00:00:00Z". Defaults to now.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(1)
      .describe('Number of forward occurrences to return. Default 1, max 20.'),
    body: z
      .enum(EVENT_BODY_NAMES)
      .optional()
      .describe(
        'Target body — required for opposition, conjunction, max_elongation, and perigee_apogee; ignored otherwise. "earth" is accepted only for perigee_apogee, which returns its perihelion and aphelion.',
      ),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Observer latitude in decimal degrees — required for solar_eclipse to get local circumstances, ignored by every other event.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Observer longitude in decimal degrees — required for solar_eclipse, ignored by every other event.',
      ),
    elevation: z
      .number()
      .default(0)
      .describe('Observer elevation in meters above sea level. Default 0.'),
    timezone: z
      .string()
      .optional()
      .describe(
        'IANA timezone for localized output, e.g. "America/Los_Angeles". When omitted, output is UTC-only.',
      ),
  }),
  output: FindEventsOutput,
  enrichment: {
    totalCount: z.number().describe('Number of event occurrences returned.'),
  },
  errors: [
    {
      reason: 'observer_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A solar_eclipse event was requested without observer latitude/longitude.',
      recovery:
        'Add observer latitude and longitude to receive local eclipse circumstances, then retry.',
    },
    {
      reason: 'body_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A body-relative event was requested without a target body.',
      recovery:
        'Add the target body (e.g. "mars" for opposition or "venus" for max_elongation) and retry.',
    },
    {
      reason: 'body_not_supported',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The body has no such event — opposition for the Sun, Moon, Earth, or an inner planet; conjunction for the Sun, Moon, or Earth; max_elongation for anything but mercury or venus; perigee_apogee for the Sun.',
      recovery:
        'Pick a body the event is defined for: a superior planet (mars through pluto) for opposition, any planet for conjunction, mercury or venus for max_elongation, and the moon, earth, or a planet for perigee_apogee.',
    },
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

    const hasObserver = typeof input.latitude === 'number' && typeof input.longitude === 'number';
    if (input.event === 'solar_eclipse' && !hasObserver) {
      // Solar eclipses require an observer for local circumstances; lunar eclipses are geocentric.
      throw ctx.fail('observer_required', undefined, { ...ctx.recoveryFor('observer_required') });
    }
    if (BODY_EVENTS.has(input.event) && !input.body) {
      throw ctx.fail('body_required', undefined, { ...ctx.recoveryFor('body_required') });
    }

    const observer = hasObserver
      ? {
          latitude: input.latitude as number,
          longitude: input.longitude as number,
          elevation: input.elevation,
        }
      : undefined;

    const records = svc.findEvents(input.event, {
      start,
      count: input.count,
      ...(input.body ? { body: input.body } : {}),
      ...(observer ? { observer } : {}),
      ...(timezone ? { timezone } : {}),
    });

    ctx.log.info('Found events', { event: input.event, count: records.length });
    ctx.enrich.total(records.length);

    const out: FindEventsOutputType = {
      events: records.map((r) => ({
        event: r.event,
        time_utc: r.timeUtc,
        ...(r.timeLocal ? { time_local: r.timeLocal } : {}),
        ...(r.kind ? { kind: r.kind } : {}),
        ...(r.obscuration !== undefined ? { obscuration: r.obscuration } : {}),
        ...(r.localVisible !== undefined ? { local_visible: r.localVisible } : {}),
        ...(r.contacts ? { contacts: r.contacts } : {}),
        ...(r.which ? { which: r.which } : {}),
        ...(r.quarter ? { quarter: r.quarter } : {}),
        ...(r.body ? { body: r.body } : {}),
        ...(r.conjunctionKind ? { conjunction_kind: r.conjunctionKind } : {}),
        ...(r.elongationDegrees !== undefined ? { elongation_degrees: r.elongationDegrees } : {}),
        ...(r.visibility ? { visibility: r.visibility } : {}),
        ...(r.apsisKind ? { apsis_kind: r.apsisKind } : {}),
        ...(r.distanceKm !== undefined ? { distance_km: r.distanceKm } : {}),
        ...(r.distanceAu !== undefined ? { distance_au: r.distanceAu } : {}),
      })),
    };
    return out;
  },

  format: (r) => {
    const count = r.events.length;
    const lines: string[] = [`## ${count} event${count === 1 ? '' : 's'} found`];
    for (const e of r.events) {
      let headline = `### ${e.event}`;
      if (e.which) headline += ` (${e.which})`;
      if (e.quarter) headline += ` (${e.quarter})`;
      if (e.body) headline += ` — ${e.body}`;
      lines.push(headline);
      lines.push(`time_utc: ${e.time_utc}${e.time_local ? ` | time_local: ${e.time_local}` : ''}`);
      if (e.kind) lines.push(`**Kind:** ${e.kind}`);
      if (e.conjunction_kind) lines.push(`**Conjunction:** ${e.conjunction_kind}`);
      if (e.obscuration !== undefined)
        lines.push(
          `**Obscuration:** ${e.obscuration === null ? 'unavailable' : pct(e.obscuration, 1)}`,
        );
      if (e.local_visible !== undefined)
        lines.push(`**Locally visible:** ${e.local_visible ? 'yes' : 'no'}`);
      if (e.elongation_degrees !== undefined)
        lines.push(`**Elongation:** ${num(e.elongation_degrees, 1, '°')}`);
      if (e.visibility) lines.push(`**Apparition:** ${e.visibility}`);
      if (e.apsis_kind) lines.push(`**Apsis:** ${e.apsis_kind}`);
      if (e.distance_km !== undefined) lines.push(`**Distance:** ${num(e.distance_km, 0, ' km')}`);
      if (e.distance_au !== undefined) lines.push(`**Distance:** ${sig(e.distance_au, 6, ' AU')}`);
      if (e.contacts) {
        const parts = Object.entries(e.contacts)
          .filter(([, v]) => v !== null)
          .map(([k, v]) => `${k.replace(/_utc$/, '')} ${v}`);
        if (parts.length > 0) lines.push(`**Contacts:** ${parts.join(', ')}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
