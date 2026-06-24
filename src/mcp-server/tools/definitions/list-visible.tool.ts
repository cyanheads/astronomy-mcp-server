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
  enrichment: {
    skyCondition: z
      .enum(['daylight', 'civil_twilight', 'nautical_twilight', 'astronomical_twilight', 'dark'])
      .describe(
        "Sky condition derived from the Sun's altitude — the gate for whether faint objects are observable.",
      ),
    sunAltitudeDegrees: z
      .number()
      .describe("The Sun's altitude in degrees that produced the sky condition."),
    totalCount: z.number().describe('Number of bodies returned above the minimum-altitude filter.'),
  },
  enrichmentTrailer: {
    skyCondition: { label: 'Sky condition' },
    sunAltitudeDegrees: { render: (v: number) => `**Sun altitude:** ${v.toFixed(1)}°` },
  },
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
    ctx.enrich({
      skyCondition: result.skyCondition,
      sunAltitudeDegrees: result.sunAltitudeDegrees,
      totalCount: result.bodies.length,
    });

    const out: ListVisibleOutputType = {
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

  format: (r) => {
    const lines: string[] = [];
    if (r.bodies.length === 0) {
      lines.push('No bodies above the minimum-altitude filter at this instant.');
    }
    for (const b of r.bodies) {
      lines.push(`## ${b.rank}. ${b.body} — ${b.visibility_note}`);
      lines.push(`time_utc: ${b.time_utc}${b.time_local ? ` | time_local: ${b.time_local}` : ''}`);
      lines.push(
        `equatorial: RA ${b.equatorial.ra_hours} h, Dec ${b.equatorial.dec_degrees}°, distance ${b.equatorial.distance_au} AU`,
      );
      lines.push(
        `horizontal: altitude ${b.horizontal.altitude_degrees}°, azimuth ${b.horizontal.azimuth_degrees}°, above_horizon ${b.horizontal.above_horizon}`,
      );
      lines.push(
        `ecliptic: longitude ${b.ecliptic.longitude_degrees}°, latitude ${b.ecliptic.latitude_degrees}°`,
      );
      lines.push(`magnitude: ${b.magnitude ?? 'unavailable'}`);
      lines.push(`angular_diameter_arcsec: ${b.angular_diameter_arcsec ?? 'unavailable'}`);
      lines.push(`phase_angle_degrees: ${b.phase_angle_degrees ?? 'unavailable'}`);
      lines.push(`illuminated_fraction: ${b.illuminated_fraction ?? 'unavailable'}`);
      lines.push(`constellation: ${b.constellation.name} (${b.constellation.abbreviation})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
