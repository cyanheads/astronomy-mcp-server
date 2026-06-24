/**
 * @fileoverview astronomy://body/{body} — a static reference card for a solar-system
 *   body: canonical name, type, mean radius, and naked-eye visibility. Mirrors the
 *   bundled body table; every datum is also reachable through tool output, so
 *   tool-only clients lose nothing.
 * @module mcp-server/resources/definitions/body.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { BODY_META } from '@/services/ephemeris/body-data.js';
import { BODY_NAMES, type BodyName } from '@/services/ephemeris/types.js';

export const bodyResource = resource('astronomy://body/{body}', {
  name: 'astronomy-body-reference',
  title: 'astronomy-mcp-server: body reference card',
  description:
    'Static reference card for a solar-system body: canonical name, type (star/planet/moon/dwarf), mean radius in kilometers, and whether it is naked-eye visible. `{body}` must be one of the closed enum values (sun, moon, mercury … pluto).',
  mimeType: 'application/json',
  params: z.object({
    body: z
      .string()
      .describe(
        'Body identifier — one of sun, moon, mercury, venus, mars, jupiter, saturn, uranus, neptune, pluto.',
      ),
  }),
  output: z.object({
    body: z.string().describe('The canonical lower-case identifier echoed from the URI.'),
    name: z.string().describe('Display name, e.g. "Jupiter".'),
    type: z.enum(['star', 'planet', 'moon', 'dwarf']).describe('Classification of the body.'),
    mean_radius_km: z.number().describe('Mean radius in kilometers, from IAU/NASA fact sheets.'),
    naked_eye: z.boolean().describe('True when the body is typically visible to the naked eye.'),
  }),
  errors: [
    {
      reason: 'unknown_body',
      code: JsonRpcErrorCode.NotFound,
      when: 'The {body} segment is not one of the supported solar-system bodies.',
      recovery:
        'Use one of: sun, moon, mercury, venus, mars, jupiter, saturn, uranus, neptune, pluto.',
    },
  ],

  handler(params, ctx) {
    const key = params.body.trim().toLowerCase();
    if (!(BODY_NAMES as readonly string[]).includes(key)) {
      throw ctx.fail('unknown_body', `Unknown body "${params.body}".`, {
        ...ctx.recoveryFor('unknown_body'),
      });
    }
    const meta = BODY_META[key as BodyName];
    ctx.log.debug('Body reference', { body: key });
    return {
      body: key,
      name: meta.name,
      type: meta.type,
      mean_radius_km: meta.meanRadiusKm,
      naked_eye: meta.nakedEye,
    };
  },

  list: () => ({
    resources: BODY_NAMES.map((b) => ({
      uri: `astronomy://body/${b}`,
      name: BODY_META[b].name,
      mimeType: 'application/json',
    })),
  }),

  complete: {
    body: (partial: string) => BODY_NAMES.filter((b) => b.startsWith(partial.toLowerCase())),
  },
});
