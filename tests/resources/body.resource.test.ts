/**
 * @fileoverview Tests for the astronomy://body/{body} reference resource.
 * @module tests/resources/body.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { bodyResource } from '@/mcp-server/resources/definitions/body.resource.js';

describe('bodyResource', () => {
  it('returns the reference card for a known body', async () => {
    const ctx = createMockContext();
    const params = bodyResource.params.parse({ body: 'jupiter' });
    const result = await bodyResource.handler(params, ctx);
    expect(result).toEqual({
      body: 'jupiter',
      name: 'Jupiter',
      type: 'planet',
      mean_radius_km: 69911,
      naked_eye: true,
    });
  });

  it('is case-insensitive on the body segment', async () => {
    const ctx = createMockContext();
    const params = bodyResource.params.parse({ body: 'SUN' });
    const result = await bodyResource.handler(params, ctx);
    expect(result.name).toBe('Sun');
  });

  it('throws unknown_body for an unsupported body', () => {
    const ctx = createMockContext({ errors: bodyResource.errors });
    const params = bodyResource.params.parse({ body: 'ceres' });
    expect(() => bodyResource.handler(params, ctx)).toThrow(/ceres|body/i);
  });

  it('lists every supported body', async () => {
    const listing = await bodyResource.list!({} as never);
    expect(listing.resources).toHaveLength(10);
    expect(listing.resources.map((r) => r.uri)).toContain('astronomy://body/pluto');
  });
});
