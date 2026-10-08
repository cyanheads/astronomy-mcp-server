/**
 * @fileoverview Tests for the astronomy://body/{body} reference resource.
 * @module tests/resources/body.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { describe, expect, it } from 'vitest';
import { bodyResource } from '@/mcp-server/resources/definitions/body.resource.js';

const PROTOCOL_VERSION = '2026-07-28';

/**
 * Read a resource through the framework's resource factory, which fills a declared
 * `recovery` hint the way production does. A direct `handler(...)` call returns the
 * throw site's error unfilled, so a wire assertion has to come through here.
 */
async function readResource(uri: string) {
  const worker = createWorkerHandler({
    name: 'astronomy-mcp-server',
    title: 'astronomy-mcp-server',
    resources: [bodyResource],
  });
  const response = await worker.fetch(
    new Request('http://example.com/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'resources/read',
        'Mcp-Name': uri,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: {
          uri,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'body-resource-test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    {} as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
  const text = await response.text();
  const frame =
    text.startsWith('event:') || text.startsWith('data:')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
      : text;
  return JSON.parse(frame) as {
    error?: { code: number; data?: { reason?: string; recovery?: { hint?: string } } };
  };
}

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

  it('answers unknown_body on the wire with the declared recovery hint', async () => {
    const { error } = await readResource('astronomy://body/ceres');
    expect(error?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error?.data?.reason).toBe('unknown_body');
    expect(error?.data?.recovery?.hint).toBe(
      bodyResource.errors?.find((e) => e.reason === 'unknown_body')?.recovery,
    );
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
