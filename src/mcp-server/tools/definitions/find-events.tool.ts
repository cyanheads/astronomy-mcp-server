/**
 * @fileoverview astronomy_find_events — consolidated forward search for nine event
 *   classes under one `event` enum. Both eclipse classes take an optional observer:
 *   solar eclipses are global without one and local with one, and lunar eclipses gain
 *   the Moon's altitude at each contact. Every other class is geocentric. Every search
 *   stops at the end of the supported span, with a notice when that cuts a list short.
 *   Validation gates fail fast when an event needs a body that was not supplied, when an
 *   eclipse observer is half-specified, or when the body has no such event.
 * @module mcp-server/tools/definitions/find-events.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { num, pct, sig } from '@/mcp-server/tools/format-numbers.js';
import { getEphemerisService, SUPPORTED_SPAN } from '@/services/ephemeris/ephemeris-service.js';
import { EVENT_BODY_NAMES, EVENT_NAMES, type EventName } from '@/services/ephemeris/types.js';

const BODY_EVENTS = new Set<EventName>([
  'opposition',
  'conjunction',
  'max_elongation',
  'perigee_apogee',
]);

/** The event classes whose records an observer changes. */
const ECLIPSE_EVENTS = new Set<EventName>(['solar_eclipse', 'lunar_eclipse']);

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
              "True when the eclipsed body — the Sun for solar_eclipse, the Moon for lunar_eclipse — is above the observer's horizon at any contact. Present only when latitude/longitude are supplied. A solar result with an observer is always true, because the local search returns only eclipses with the Sun up at first or last contact; contact_altitudes_degrees tells an eclipse at sunrise or sunset from one at midday.",
            ),
          contact_altitudes_degrees: z
            .record(z.string(), z.number().nullable())
            .optional()
            .describe(
              "Apparent altitude in degrees of the eclipsed body (the Sun for solar_eclipse, the Moon for lunar_eclipse) above the observer's horizon at each contact, keyed by bare phase name: partial_begin, total_begin, peak, total_end, partial_end, plus penumbral_begin and penumbral_end for a lunar eclipse. Negative means below the horizon; null marks a phase this eclipse does not reach. Present only when latitude/longitude are supplied.",
            ),
          contacts: z
            .record(z.string(), z.string().nullable())
            .optional()
            .describe(
              'Eclipse contact times in ISO 8601 UTC keyed by phase (e.g. partial_begin_utc, peak_utc); a phase that does not occur is null. A global solar eclipse carries peak_utc only.',
            ),
          peak_latitude_degrees: z
            .number()
            .optional()
            .describe(
              'Geographic latitude in degrees where a total or annular solar eclipse is greatest. Present for a solar_eclipse searched without an observer; absent for a partial eclipse, whose shadow axis misses Earth.',
            ),
          peak_longitude_degrees: z
            .number()
            .optional()
            .describe(
              'Geographic longitude in degrees where a total or annular solar eclipse is greatest. Present for a solar_eclipse searched without an observer; absent for a partial eclipse.',
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
    "Search forward from a start time for the next occurrences of one sky-event class, selected by the `event` enum: solar_eclipse, lunar_eclipse, equinox, solstice, moon_quarter, opposition, conjunction, max_elongation, or perigee_apogee. Both eclipse classes take an optional observer (latitude and longitude together). solar_eclipse without one returns global eclipses — kind, peak time, obscuration, and for a total or annular eclipse the latitude/longitude where it is greatest; with one it returns only eclipses visible from that point, with local contact times, `local_visible`, and the Sun's altitude at each contact. lunar_eclipse returns geocentric contact times, the same instants everywhere on Earth; an observer adds `local_visible` and the Moon's altitude at each contact. Every other class is geocentric and ignores a location. The body-relative events (opposition, conjunction, max_elongation, perigee_apogee) require a `body`: opposition applies to the superior planets (mars through pluto), conjunction to any planet, max_elongation to mercury and venus, and perigee_apogee to the moon (perigee/apogee), earth, or a planet (perihelion/aphelion). Returns the next `count` occurrences (default 1). Searches stop at the end of 2100, the close of the supported span; when that leaves fewer than `count`, a notice says so. Start defaults to now; pass an IANA `timezone` for observer-local timestamps.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    event: z.enum(EVENT_NAMES).describe('Which class of event to search for.'),
    start: z
      .string()
      .optional()
      .describe(
        'Search start as an ISO 8601 UTC string, e.g. "2024-01-01T00:00:00Z". Defaults to now. A value with no zone designator is read as UTC, not the local zone of the server process.',
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
        'Observer latitude in decimal degrees, supplied together with longitude. Optional for solar_eclipse and lunar_eclipse, where it adds local circumstances; omit both for a global solar search. Ignored by every other event.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Observer longitude in decimal degrees, supplied together with latitude. Optional for solar_eclipse and lunar_eclipse; ignored by every other event.',
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
    notice: z
      .string()
      .optional()
      .describe(
        'Why the list is shorter than the requested count: the search reached the end of the supported span (2100). Absent when every requested occurrence came back.',
      ),
  },
  errors: [
    {
      reason: 'incomplete_observer',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A solar_eclipse or lunar_eclipse was requested with only one of latitude and longitude.',
      recovery:
        'Supply latitude and longitude together for local eclipse circumstances, or omit both for global ones.',
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
      thrownBy: 'service',
    },
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

    const hasLatitude = typeof input.latitude === 'number';
    const hasLongitude = typeof input.longitude === 'number';
    const hasObserver = hasLatitude && hasLongitude;
    /**
     * An eclipse with half an observer would silently answer a different question — the
     * global search — than the local one the caller reached for. Other classes ignore a
     * location entirely, so a lone coordinate there changes nothing and passes.
     */
    if (ECLIPSE_EVENTS.has(input.event) && hasLatitude !== hasLongitude) {
      throw ctx.fail(
        'incomplete_observer',
        `Observer ${hasLatitude ? 'latitude' : 'longitude'} was supplied without ${hasLatitude ? 'longitude' : 'latitude'}.`,
        { ...ctx.recoveryFor('incomplete_observer') },
      );
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

    /**
     * Every search is unbounded except by the supported span, so a short list means the
     * span ended. `notice` is last-wins across enrichment writers, so caveats are collected
     * and written once.
     */
    const caveats: string[] = [];
    if (records.length < input.count) {
      caveats.push(
        `The search reached the end of the supported span (${SUPPORTED_SPAN.lastYear}) after ${records.length} of ${input.count} requested events; no occurrence after ${SUPPORTED_SPAN.lastYear} is computed.`,
      );
    }
    if (caveats.length > 0) ctx.enrich.notice(caveats.join(' '));

    const out: FindEventsOutputType = {
      events: records.map((r) => ({
        event: r.event,
        time_utc: r.timeUtc,
        ...(r.timeLocal ? { time_local: r.timeLocal } : {}),
        ...(r.kind ? { kind: r.kind } : {}),
        ...(r.obscuration !== undefined ? { obscuration: r.obscuration } : {}),
        ...(r.localVisible !== undefined ? { local_visible: r.localVisible } : {}),
        ...(r.contactAltitudesDegrees
          ? { contact_altitudes_degrees: r.contactAltitudesDegrees }
          : {}),
        ...(r.contacts ? { contacts: r.contacts } : {}),
        ...(r.peakLatitudeDegrees !== undefined
          ? { peak_latitude_degrees: r.peakLatitudeDegrees }
          : {}),
        ...(r.peakLongitudeDegrees !== undefined
          ? { peak_longitude_degrees: r.peakLongitudeDegrees }
          : {}),
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
      if (e.peak_latitude_degrees !== undefined && e.peak_longitude_degrees !== undefined)
        lines.push(
          `**Peak location:** lat ${num(e.peak_latitude_degrees, 1, '°')}, lon ${num(e.peak_longitude_degrees, 1, '°')}`,
        );
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
      if (e.contact_altitudes_degrees) {
        const parts = Object.entries(e.contact_altitudes_degrees).flatMap(([phase, altitude]) =>
          altitude === null ? [] : [`${phase} ${num(altitude, 1, '°')}`],
        );
        if (parts.length > 0) lines.push(`**Contact altitudes:** ${parts.join(', ')}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
