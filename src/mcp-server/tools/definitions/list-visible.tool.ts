/**
 * @fileoverview astronomy_list_visible — the workflow flagship. For a location and
 *   instant, iterate every naked-eye body (and optionally catalog stars), filter to
 *   above the horizon, rank brightest-and-highest first, annotate each with a
 *   visibility note, and gate the whole sky by the Sun's altitude.
 * @module mcp-server/tools/definitions/list-visible.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { sig } from '@/mcp-server/tools/format-numbers.js';
import { getEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { SkyPositionOutput } from './get-sky-position.tool.js';

const VisibleBodySchema = SkyPositionOutput.extend({
  rank: z.number().describe('1-based rank, brightest-and-highest first.'),
  visibility_note: z
    .string()
    .describe(
      'Server-computed one-line headline from real values, e.g. "Venus, mag -4.1, 12° above the WSW horizon — very bright".',
    ),
}).describe(
  'A sky position above the horizon, with its rank and a plain-language visibility note.',
);

export const ListVisibleOutput = z.object({
  sky_condition: z
    .enum(['daylight', 'civil_twilight', 'nautical_twilight', 'astronomical_twilight', 'dark'])
    .describe(
      "Sky condition derived from the Sun's altitude — the gate for whether faint objects are observable.",
    ),
  sun_altitude_degrees: z
    .number()
    .describe("The Sun's altitude in degrees that produced the sky condition."),
  total_count: z.number().describe('Number of bodies returned above the minimum-altitude filter.'),
  bodies: z
    .array(VisibleBodySchema)
    .describe(
      'Every body (and optional star) above the minimum-altitude filter, ranked brightest-and-highest first.',
    ),
});

export type ListVisibleOutputType = z.infer<typeof ListVisibleOutput>;

export const listVisibleTool = tool('astronomy_list_visible', {
  title: 'astronomy-mcp-server: list visible bodies',
  description:
    'The one-call "what is up right now" answer. For an observer location and instant, iterate every naked-eye solar-system body (and, with include_stars, the bundled bright stars), compute altitude and azimuth, keep those above the horizon, rank them brightest-and-highest first, and attach a plain-language visibility note to each. The whole sky is gated by the Sun\'s altitude into daylight / civil / nautical / astronomical twilight / dark, returned alongside the list. `time` is a single evaluation instant, not a window — for "tonight" pass a time after astronomical dusk (use astronomy_get_rise_set on the sun to find it). Default elevation 0 m; use min_altitude to skip objects grazing the horizon. This server does not geocode — resolve coordinates upstream first; pass an IANA timezone for observer-local times on each body.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
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
    time: z
      .string()
      .optional()
      .describe(
        'Evaluation instant as an ISO 8601 UTC string, e.g. "2024-08-12T05:00:00Z". Defaults to now. A single instant, not a window.',
      ),
    timezone: z
      .string()
      .optional()
      .describe(
        'IANA timezone for localized output, e.g. "America/Los_Angeles". When omitted, output is UTC-only.',
      ),
    min_altitude: z
      .number()
      .min(-90)
      .max(90)
      .default(0)
      .describe(
        'Minimum altitude in degrees to include a body. Default 0 (above the horizon); use e.g. 5 to require clearance.',
      ),
    include_stars: z
      .boolean()
      .default(false)
      .describe('Include the bundled bright stars alongside planets. Default false.'),
  }),
  output: ListVisibleOutput,
  errors: [
    {
      reason: 'time_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: "The requested instant is outside the engine's high-accuracy span (≈1900–2100).",
      recovery: 'Use a date between 1900 and 2100 and retry.',
    },
  ],

  handler(input, ctx) {
    const svc = getEphemerisService();
    const timezone = svc.resolveTimezone(input.timezone ?? getServerConfig().defaultTimezone);
    const date = svc.resolveTime(input.time);
    const observer = {
      latitude: input.latitude,
      longitude: input.longitude,
      elevation: input.elevation,
    };

    const result = svc.listVisible(observer, date, {
      minAltitude: input.min_altitude,
      includeStars: input.include_stars,
      ...(timezone ? { timezone } : {}),
    });

    ctx.log.info('Listed visible bodies', {
      count: result.bodies.length,
      skyCondition: result.skyCondition,
    });

    const out: ListVisibleOutputType = {
      sky_condition: result.skyCondition,
      sun_altitude_degrees: result.sunAltitudeDegrees,
      total_count: result.bodies.length,
      bodies: result.bodies.map((b) => ({
        body: b.body,
        time_utc: b.timeUtc,
        ...(b.timeLocal ? { time_local: b.timeLocal } : {}),
        equatorial: {
          ra_hours: b.equatorial.raHours,
          dec_degrees: b.equatorial.decDegrees,
          distance_au: b.equatorial.distanceAu,
        },
        horizontal: {
          altitude_degrees: b.horizontal.altitudeDegrees,
          azimuth_degrees: b.horizontal.azimuthDegrees,
          above_horizon: b.horizontal.aboveHorizon,
        },
        ecliptic: {
          longitude_degrees: b.ecliptic.longitudeDegrees,
          latitude_degrees: b.ecliptic.latitudeDegrees,
        },
        magnitude: b.magnitude,
        angular_diameter_arcsec: b.angularDiameterArcsec,
        phase_angle_degrees: b.phaseAngleDegrees,
        illuminated_fraction: b.illuminatedFraction,
        constellation: b.constellation,
        rank: b.rank,
        visibility_note: b.visibilityNote,
      })),
    };
    return out;
  },

  /**
   * The scan surface, so the one `format()` that does not tail every value with its
   * exact counterpart: a body carries the whole `SkyPositionOutput` field set, and
   * eleven seventeen-digit tails per body grew `content[]` by ~1.7x on every call.
   * The distance keeps its tail, spanning 0.0026 AU at the Moon to 1e8 at a catalog
   * star; for the rest, `astronomy_get_sky_position` takes any body listed here and
   * returns the same field set with every exact value.
   */
  format: (r) => {
    const lines: string[] = [
      `Sky: ${r.sky_condition} (Sun ${r.sun_altitude_degrees.toFixed(1)}°) — ${r.total_count} bodies visible`,
    ];
    if (r.bodies.length === 0) {
      lines.push('No bodies above the minimum-altitude filter at this instant.');
    }
    /** Round to `digits` with an optional unit suffix; null reads as "n/a". */
    const orNa = (v: number | null, digits: number, suffix = '') =>
      v === null ? 'n/a' : `${v.toFixed(digits)}${suffix}`;
    for (const b of r.bodies) {
      // The visibility_note is the human headline; the supporting coordinates
      // follow on one compact, rounded line.
      lines.push(`## ${b.rank}. ${b.body} — ${b.visibility_note}`);
      lines.push(
        [
          `alt ${b.horizontal.altitude_degrees.toFixed(1)}° az ${b.horizontal.azimuth_degrees.toFixed(1)}° (${b.horizontal.above_horizon ? 'above' : 'below'} horizon)`,
          `RA ${b.equatorial.ra_hours.toFixed(2)}h Dec ${b.equatorial.dec_degrees.toFixed(1)}°`,
          // Significant figures, not fixed decimals — `toFixed(3)` rendered the Moon
          // as "0.003 AU", 13% high.
          sig(b.equatorial.distance_au, 4, ' AU'),
          `mag ${orNa(b.magnitude, 1)}`,
          `⌀ ${orNa(b.angular_diameter_arcsec, 1, '″')}`,
          `phase ${orNa(b.phase_angle_degrees, 1, '°')}`,
          `illum ${b.illuminated_fraction === null ? 'n/a' : `${(b.illuminated_fraction * 100).toFixed(0)}%`}`,
          `ecl lon ${b.ecliptic.longitude_degrees.toFixed(1)}° lat ${b.ecliptic.latitude_degrees.toFixed(1)}°`,
          `${b.constellation.name} (${b.constellation.abbreviation})`,
          `${b.time_utc}${b.time_local ? ` (local ${b.time_local})` : ''}`,
        ].join(' · '),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
