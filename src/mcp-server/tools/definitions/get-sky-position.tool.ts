/**
 * @fileoverview astronomy_get_sky_position — apparent topocentric position of one
 *   solar-system body or named bright star for an observer and instant.
 * @module mcp-server/tools/definitions/get-sky-position.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { num, pct, sig } from '@/mcp-server/tools/format-numbers.js';
import { getEphemerisService } from '@/services/ephemeris/ephemeris-service.js';
import { BODY_NAMES } from '@/services/ephemeris/types.js';

export const SkyPositionOutput = z.object({
  body: z.string().describe('The body or star this position is for, echoed from the request.'),
  time_utc: z.string().describe('The instant of the observation in ISO 8601 UTC.'),
  time_local: z
    .string()
    .optional()
    .describe(
      'The same instant in the observer-local timezone with offset, present only when a timezone was supplied.',
    ),
  equatorial: z
    .object({
      ra_hours: z.number().describe('Right ascension in sidereal hours [0,24), equator-of-date.'),
      dec_degrees: z.number().describe('Declination in degrees [-90,90], equator-of-date.'),
      distance_au: z
        .number()
        .describe('Distance from the observer to the body in astronomical units.'),
    })
    .describe(
      'Apparent equatorial coordinates, corrected for precession, nutation, parallax, and aberration.',
    ),
  horizontal: z
    .object({
      altitude_degrees: z
        .number()
        .describe('Angle above (positive) or below (negative) the horizon, refraction-corrected.'),
      azimuth_degrees: z.number().describe('Compass bearing in degrees: 0=N, 90=E, 180=S, 270=W.'),
      above_horizon: z
        .boolean()
        .describe('True when the body is above the horizon (altitude > 0).'),
    })
    .describe('Refraction-corrected horizontal coordinates as seen from the observer.'),
  ecliptic: z
    .object({
      longitude_degrees: z.number().describe('Ecliptic longitude in degrees [0,360).'),
      latitude_degrees: z.number().describe('Ecliptic latitude in degrees [-90,90].'),
    })
    .describe('Ecliptic-of-date coordinates of the body.'),
  magnitude: z
    .number()
    .nullable()
    .describe(
      'Apparent visual magnitude (lower is brighter). Null for bodies where the engine cannot compute it.',
    ),
  angular_diameter_arcsec: z
    .number()
    .nullable()
    .describe(
      'Apparent angular diameter of the disc in arcseconds. Null for point-source convention bodies.',
    ),
  phase_angle_degrees: z
    .number()
    .nullable()
    .describe('Sun-body-observer phase angle in degrees. Null when not applicable (e.g. stars).'),
  illuminated_fraction: z
    .number()
    .nullable()
    .describe('Fraction of the disc illuminated, 0 to 1. Null when not applicable.'),
  constellation: z
    .object({
      abbreviation: z.string().describe('IAU 3-letter constellation abbreviation, e.g. "Ori".'),
      name: z.string().describe('Full constellation name, e.g. "Orion".'),
    })
    .describe('The constellation the body currently falls within.'),
});

export type SkyPositionOutputType = z.infer<typeof SkyPositionOutput>;

export const getSkyPositionTool = tool('astronomy_get_sky_position', {
  title: 'astronomy-mcp-server: get sky position',
  description:
    'Compute the apparent topocentric position of one solar-system body (sun, moon, mercury through neptune, pluto) or a named bright star for an observer location and instant. Returns equatorial (RA/Dec), refraction-corrected horizontal (altitude/azimuth), and ecliptic coordinates, plus distance, apparent magnitude, angular diameter, phase angle, illuminated fraction, and the constellation it falls in. Positions are parallax- and aberration-corrected for the given observer; default elevation is 0 m and the default time is now. Supply `star` (e.g. "Sirius", "Polaris") instead of `body` to target a catalog star; `body` is ignored when `star` is set. Pass an IANA `timezone` to also receive the observer-local time. This server does not geocode — resolve a place name to latitude/longitude upstream first.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    body: z
      .enum(BODY_NAMES)
      .optional()
      .describe('Solar-system body to locate. Omit when targeting a named star via `star`.'),
    star: z
      .string()
      .optional()
      .describe(
        'Named bright star to locate (common name or Bayer designation, e.g. "Sirius", "Alpha Centauri"). Takes precedence over `body`.',
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
    time: z
      .string()
      .optional()
      .describe(
        'Instant of observation as an ISO 8601 UTC string, e.g. "2024-04-08T18:00:00Z". Defaults to now.',
      ),
    timezone: z
      .string()
      .optional()
      .describe(
        'IANA timezone for localized output, e.g. "America/Los_Angeles". When omitted, output is UTC-only.',
      ),
  }),
  output: SkyPositionOutput,
  errors: [
    {
      reason: 'time_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: "The requested instant is outside the engine's high-accuracy span (≈1900–2100).",
      recovery: 'Use a date between 1900 and 2100 and retry.',
    },
    {
      reason: 'star_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The `star` name is not present in the bundled bright-star catalog.',
      recovery:
        'Check the spelling or use a common name or Bayer designation such as "Sirius" or "Polaris".',
    },
    {
      reason: 'body_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither a `body` nor a `star` was supplied.',
      recovery: 'Provide a solar-system body via `body` or a star name via `star`.',
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

    let pos: ReturnType<typeof svc.position>;
    if (input.star && input.star.trim().length > 0) {
      const target = svc.resolveStarTarget(input.star);
      pos = svc.position({ kind: 'star', star: target }, observer, date, timezone);
    } else if (input.body) {
      pos = svc.position({ kind: 'body', body: input.body }, observer, date, timezone);
    } else {
      throw ctx.fail('body_required', undefined, { ...ctx.recoveryFor('body_required') });
    }

    ctx.log.info('Computed sky position', {
      body: pos.body,
      altitude: pos.horizontal.altitudeDegrees,
    });
    return toOutput(pos);
  },

  format: (result) => [{ type: 'text', text: formatPosition(result) }],
});

/** Map the service's camelCase record to the snake_case wire output. */
function toOutput(
  pos: ReturnType<ReturnType<typeof getEphemerisService>['position']>,
): SkyPositionOutputType {
  return {
    body: pos.body,
    time_utc: pos.timeUtc,
    ...(pos.timeLocal ? { time_local: pos.timeLocal } : {}),
    equatorial: {
      ra_hours: pos.equatorial.raHours,
      dec_degrees: pos.equatorial.decDegrees,
      distance_au: pos.equatorial.distanceAu,
    },
    horizontal: {
      altitude_degrees: pos.horizontal.altitudeDegrees,
      azimuth_degrees: pos.horizontal.azimuthDegrees,
      above_horizon: pos.horizontal.aboveHorizon,
    },
    ecliptic: {
      longitude_degrees: pos.ecliptic.longitudeDegrees,
      latitude_degrees: pos.ecliptic.latitudeDegrees,
    },
    magnitude: pos.magnitude,
    angular_diameter_arcsec: pos.angularDiameterArcsec,
    phase_angle_degrees: pos.phaseAngleDegrees,
    illuminated_fraction: pos.illuminatedFraction,
    constellation: pos.constellation,
  };
}

/** Render a position record for content[] — every output field is represented. */
export function formatPosition(r: SkyPositionOutputType): string {
  const lines: string[] = [];
  lines.push(`## ${r.body}`);
  lines.push(`**Time (UTC):** ${r.time_utc}`);
  if (r.time_local) lines.push(`**Time (local):** ${r.time_local}`);
  lines.push(
    `**Equatorial:** RA ${num(r.equatorial.ra_hours, 4, ' h')}, Dec ${num(r.equatorial.dec_degrees, 4, '°')}, dist ${sig(r.equatorial.distance_au, 6, ' AU')}`,
  );
  lines.push(
    `**Horizontal:** altitude ${num(r.horizontal.altitude_degrees, 2, '°')}, azimuth ${num(r.horizontal.azimuth_degrees, 2, '°')} (${r.horizontal.above_horizon ? 'above' : 'below'} horizon)`,
  );
  lines.push(
    `**Ecliptic:** longitude ${num(r.ecliptic.longitude_degrees, 2, '°')}, latitude ${num(r.ecliptic.latitude_degrees, 2, '°')}`,
  );
  lines.push(`**Magnitude:** ${r.magnitude === null ? 'unavailable' : num(r.magnitude, 2)}`);
  lines.push(
    `**Angular diameter:** ${r.angular_diameter_arcsec === null ? 'unavailable' : num(r.angular_diameter_arcsec, 2, '″')}`,
  );
  lines.push(
    `**Phase angle:** ${r.phase_angle_degrees === null ? 'unavailable' : num(r.phase_angle_degrees, 2, '°')}`,
  );
  lines.push(
    `**Illuminated fraction:** ${r.illuminated_fraction === null ? 'unavailable' : pct(r.illuminated_fraction, 1)}`,
  );
  lines.push(`**Constellation:** ${r.constellation.name} (${r.constellation.abbreviation})`);
  return lines.join('\n');
}
