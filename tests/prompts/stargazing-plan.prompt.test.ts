/**
 * @fileoverview Tests for the astronomy_stargazing_plan prompt template.
 * @module tests/prompts/stargazing-plan.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { stargazingPlanPrompt } from '@/mcp-server/prompts/definitions/stargazing-plan.prompt.js';

describe('stargazingPlanPrompt', () => {
  it('weaves the location and date into the message', () => {
    const args = stargazingPlanPrompt.args!.parse({
      location: 'Mount Rainier',
      date: '2024-08-12',
    });
    const messages = stargazingPlanPrompt.generate(args);
    expect(messages).toHaveLength(1);
    const block = messages[0]?.content;
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('Mount Rainier');
    expect(text).toContain('2024-08-12');
    // It chains the core tools and names the cross-server steps.
    expect(text).toContain('astronomy_get_rise_set');
    expect(text).toContain('astronomy_list_visible');
    expect(text).toContain('astronomy_get_moon_phase');
  });

  it('defaults to tonight when no date is supplied', () => {
    const args = stargazingPlanPrompt.args!.parse({ location: 'Seattle, WA' });
    const messages = stargazingPlanPrompt.generate(args);
    const block = messages[0]?.content;
    const text = block && block.type === 'text' ? block.text : '';
    expect(text).toContain('tonight');
  });
});
