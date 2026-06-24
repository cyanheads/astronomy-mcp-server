/**
 * @fileoverview astronomy_stargazing_plan — a reusable template that structures the
 *   "plan tonight's stargazing from <place>" workflow, chaining the astronomy tools
 *   in order and prompting for cross-server geocoding and cloud-cover checks.
 * @module mcp-server/prompts/definitions/stargazing-plan.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const stargazingPlanPrompt = prompt('astronomy_stargazing_plan', {
  description:
    'Structure a "plan tonight\'s stargazing from <place>" workflow: resolve coordinates, find the dark-sky window, check the moon, list what is up, and fold in cloud cover. Emits a message that chains the astronomy tools in order and names the cross-server steps the astronomy server does not cover (geocoding, weather).',
  title: 'astronomy-mcp-server: plan stargazing session',
  args: z.object({
    location: z
      .string()
      .describe('The place to stargaze from, e.g. "Mount Rainier" or "Seattle, WA".'),
    date: z
      .string()
      .optional()
      .describe('Target date as an ISO date (YYYY-MM-DD). Defaults to tonight when omitted.'),
  }),
  generate: (args) => {
    const dateClause = args.date ? ` on ${args.date}` : ' tonight';
    const text = [
      `Plan a stargazing session from ${args.location}${dateClause}. Work through these steps in order:`,
      '',
      `1. Resolve ${args.location} to latitude/longitude using a geocoding tool (e.g. openstreetmap_geocode), and its IANA timezone (e.g. via reference-data). This astronomy server does not geocode.`,
      `2. Call astronomy_get_rise_set with body "sun" at those coordinates to find sunset and the astronomical-dusk time (the start of the dark window).`,
      `3. Call astronomy_get_moon_phase for the date — a bright moon washes out faint objects, so note the illuminated fraction and whether the moon is up during the dark window.`,
      `4. Call astronomy_list_visible at those coordinates with a time just after astronomical dusk to get the ranked list of what is up, including planets and bright objects.`,
      `5. Check cloud cover and transparency for the location and window using a weather tool (e.g. open-meteo or nws) — this server computes only the sky geometry, not the weather.`,
      '',
      `Then summarize: the best viewing window, the standout objects and where to look (altitude/azimuth), the moon's interference, and whether the sky is expected to be clear.`,
    ].join('\n');
    return [{ role: 'user', content: { type: 'text', text } }];
  },
});
