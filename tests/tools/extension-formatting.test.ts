/**
 * @fileoverview Extension formatters preserve upstream names as literal Markdown text.
 * @module tests/tools/extension-formatting.test
 */

import { describe, expect, it } from 'vitest';
import { getEphemerisTool } from '@/mcp-server/tools/definitions/get-ephemeris.tool.js';
import { getSatellitePassesTool } from '@/mcp-server/tools/definitions/get-satellite-passes.tool.js';

describe('extension formatter text fidelity', () => {
  it('escapes the Horizons designation and resolved target without changing structured values', () => {
    const result = {
      designation: 'A*p*',
      target_name: '[target](https://example.test)',
      points: [],
    };
    const block = getEphemerisTool.format!(result)[0];

    expect(block).toEqual({
      type: 'text',
      text: '## A\\*p\\* (Horizons target: \\[target\\](https://example.test)) — 0 points',
    });
    expect(result.designation).toBe('A*p*');
    expect(result.target_name).toBe('[target](https://example.test)');
  });

  it('escapes the satellite name and caller query without changing structured values', () => {
    const result = {
      norad_id: 25544,
      satellite_name: 'A*p*',
      resolved_from_name: '`ISS`',
      passes: [],
    };
    const block = getSatellitePassesTool.format!(result)[0];

    expect(block).toEqual({
      type: 'text',
      text: '## A\\*p\\* (NORAD 25544) — 0 visible passes\nResolved from the name query "\\`ISS\\`".\nNo visible passes in the window searched (sunlit satellite over a dark sky, reaching 10°).',
    });
    expect(result.satellite_name).toBe('A*p*');
    expect(result.resolved_from_name).toBe('`ISS`');
  });
});
