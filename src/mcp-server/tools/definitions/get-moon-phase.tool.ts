/**
 * @fileoverview astronomy_get_moon_phase — illuminated fraction, phase name, age,
 *   phase angle, and the next four lunar quarters for a given instant.
 * @module mcp-server/tools/definitions/get-moon-phase.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getEphemerisService } from '@/services/ephemeris/ephemeris-service.js';

const QUARTER_LABEL: Record<string, string> = {
  new: 'New Moon',
  first_quarter: 'First Quarter',
  full: 'Full Moon',
  last_quarter: 'Last Quarter',
};

export const MoonPhaseOutput = z.object({
  time_utc: z.string().describe('The instant the phase was computed for, in ISO 8601 UTC.'),
  time_local: z
    .string()
    .optional()
    .describe(
      'The same instant in the observer-local timezone with offset, present only when a timezone was supplied.',
    ),
  phase_angle_degrees: z
    .number()
    .describe(
      'Moon phase angle in degrees: 0 = new, 90 = first quarter, 180 = full, 270 = last quarter.',
    ),
  illuminated_fraction: z.number().describe('Fraction of the lunar disc illuminated, 0 to 1.'),
  phase_name: z
    .string()
    .describe(
      'Human-readable phase name (New Moon, Waxing Crescent, First Quarter, …, Waning Crescent).',
    ),
  age_days: z.number().describe('Synodic age in days since the previous new moon.'),
  next_quarters: z
    .array(
      z
        .object({
          quarter: z
            .enum(['new', 'first_quarter', 'full', 'last_quarter'])
            .describe('Which quarter phase this entry is.'),
          time_utc: z.string().describe('Time of the quarter phase in ISO 8601 UTC.'),
          time_local: z
            .string()
            .optional()
            .describe(
              'Time of the quarter phase in the observer-local timezone, present only when a timezone was supplied.',
            ),
        })
        .describe('A single lunar quarter phase with its timestamp.'),
    )
    .describe('The next four lunar quarter phases (new/first/full/last) in chronological order.'),
});

export type MoonPhaseOutputType = z.infer<typeof MoonPhaseOutput>;

export const getMoonPhaseTool = tool('astronomy_get_moon_phase', {
  title: 'astronomy-mcp-server: get moon phase',
  description:
    'Report the Moon phase for an instant: illuminated fraction, phase name, synodic age in days since the new moon, phase angle, and the next four quarter phases (new, first quarter, full, last quarter) with timestamps. Answers "what is the moon phase tonight" and "when is the next full moon" in one call without iteration. The time defaults to now; pass an IANA `timezone` to also receive observer-local timestamps. The phase is geocentric — no observer location is needed.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    time: z
      .string()
      .optional()
      .describe(
        'Instant to evaluate as an ISO 8601 UTC string, e.g. "2024-12-15T00:00:00Z". Defaults to now.',
      ),
    timezone: z
      .string()
      .optional()
      .describe(
        'IANA timezone for localized output, e.g. "America/Los_Angeles". When omitted, output is UTC-only.',
      ),
  }),
  output: MoonPhaseOutput,
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
    const phase = svc.moonPhase(date, timezone);

    ctx.log.info('Computed moon phase', {
      phaseName: phase.phaseName,
      illuminated: phase.illuminatedFraction,
    });
    const out: MoonPhaseOutputType = {
      time_utc: phase.timeUtc,
      ...(phase.timeLocal ? { time_local: phase.timeLocal } : {}),
      phase_angle_degrees: phase.phaseAngleDegrees,
      illuminated_fraction: phase.illuminatedFraction,
      phase_name: phase.phaseName,
      age_days: phase.ageDays,
      next_quarters: phase.nextQuarters.map((q) => ({
        quarter: q.quarter,
        time_utc: q.timeUtc,
        ...(q.timeLocal ? { time_local: q.timeLocal } : {}),
      })),
    };
    return out;
  },

  format: (r) => {
    const lines: string[] = [];
    lines.push(`## Moon — ${r.phase_name}`);
    lines.push(`**Time (UTC):** ${r.time_utc}`);
    if (r.time_local) lines.push(`**Time (local):** ${r.time_local}`);
    lines.push(`**Illuminated:** ${(r.illuminated_fraction * 100).toFixed(1)}%`);
    lines.push(`**Phase angle:** ${r.phase_angle_degrees.toFixed(1)}°`);
    lines.push(`**Age:** ${r.age_days.toFixed(1)} days since new moon`);
    lines.push('**Next quarters:**');
    for (const q of r.next_quarters) {
      const localPart = q.time_local ? ` (local ${q.time_local})` : '';
      lines.push(`- ${QUARTER_LABEL[q.quarter]}: ${q.time_utc}${localPart}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
