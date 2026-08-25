/**
 * @fileoverview Tests for the astronomy://body/{body} reference resource.
 * @module tests/resources/body.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { bodyResource } from '@/mcp-server/resources/definitions/body.resource.js';

describe('bodyResource', () => {
  it('returns the reference card for a known body', async () => {
    const ctx = createMockContext({ errors: bodyResource.errors });
    const params = bodyResource.params!.parse({ body: 'jupiter' });
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
    const ctx = createMockContext({ errors: bodyResource.errors });
    const params = bodyResource.params!.parse({ body: 'SUN' });
    const result = await bodyResource.handler(params, ctx);
    expect(result.name).toBe('Sun');
  });

  it('throws unknown_body for an unsupported body', () => {
    const ctx = createMockContext({ errors: bodyResource.errors });
    const params = bodyResource.params!.parse({ body: 'ceres' });
    expect(() => bodyResource.handler(params, ctx)).toThrow(/ceres|body/i);
  });

  it('lists every supported body', async () => {
    const listing = await bodyResource.list!({} as never);
    expect(listing.resources).toHaveLength(10);
    expect(listing.resources.map((r) => r.uri)).toContain('astronomy://body/pluto');
  });

  /**
   * The card is a lookup into a compiled-in constant, so it is safe to hand a shared
   * cache. Pinned because the hint is what a 2026-07-28 client acts on: an accidental
   * drop to the SDK default (`ttlMs: 0`, `cacheScope: 'private'`) is invisible in
   * every other assertion here — the handler's answer is identical either way.
   */
  it('declares a shareable day-long cache hint for a static reference card', () => {
    expect(bodyResource.cacheHint).toEqual({ ttlMs: 86_400_000, cacheScope: 'public' });
  });

  /**
   * A `ttlMs` the SDK would reject fails startup with a ConfigurationError rather than
   * anything a handler test would catch, so the constraint is asserted on the value.
   */
  it('declares a ttl the protocol accepts', () => {
    const ttlMs = bodyResource.cacheHint?.ttlMs;
    expect(Number.isSafeInteger(ttlMs)).toBe(true);
    expect(ttlMs).toBeGreaterThanOrEqual(0);
  });
});
