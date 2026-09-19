/**
 * @fileoverview Cross-cutting assertions over every declared `errors[]` entry on the
 *   server's definition surface. Two contracts live here. First, every declared reason
 *   resolves one of two ways — a literal `ctx.fail('<reason>'` in the handler, or a
 *   `thrownBy: 'service'` marker saying the service layer produces it — so no entry
 *   advertises a failure mode nothing can raise. The `error-contract-unthrown` lint rule
 *   checks the same thing but fires only on a handler already holding one literal
 *   `ctx.fail`, which leaves the fully service-thrown definitions unchecked; this closes
 *   that gap. Second, a declared `recovery` reaches both client surfaces — the
 *   `structuredContent.error` envelope and the `content[]` text — for a handler-thrown
 *   reason as well as a service-thrown one, since clients split on which they forward.
 * @module tests/tools/error-contract-coverage.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { bodyResource } from '@/mcp-server/resources/definitions/body.resource.js';
import { findEventsTool } from '@/mcp-server/tools/definitions/find-events.tool.js';
import { getEphemerisTool } from '@/mcp-server/tools/definitions/get-ephemeris.tool.js';
import { getMoonPhaseTool } from '@/mcp-server/tools/definitions/get-moon-phase.tool.js';
import { getRiseSetTool } from '@/mcp-server/tools/definitions/get-rise-set.tool.js';
import { getSatellitePassesTool } from '@/mcp-server/tools/definitions/get-satellite-passes.tool.js';
import { getSkyPositionTool } from '@/mcp-server/tools/definitions/get-sky-position.tool.js';
import { listVisibleTool } from '@/mcp-server/tools/definitions/list-visible.tool.js';
import { initEphemerisService } from '@/services/ephemeris/ephemeris-service.js';

const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };

beforeAll(() => {
  initEphemerisService();
});

/** One definition's declared contract plus the handler source the reasons are checked against. */
interface ContractCase {
  errors: readonly ErrorContract[] | undefined;
  handler: unknown;
  name: string;
}

const CONTRACT_CASES: ContractCase[] = [
  {
    name: 'astronomy_get_sky_position',
    errors: getSkyPositionTool.errors,
    handler: getSkyPositionTool.handler,
  },
  {
    name: 'astronomy_get_rise_set',
    errors: getRiseSetTool.errors,
    handler: getRiseSetTool.handler,
  },
  {
    name: 'astronomy_get_moon_phase',
    errors: getMoonPhaseTool.errors,
    handler: getMoonPhaseTool.handler,
  },
  { name: 'astronomy_find_events', errors: findEventsTool.errors, handler: findEventsTool.handler },
  {
    name: 'astronomy_list_visible',
    errors: listVisibleTool.errors,
    handler: listVisibleTool.handler,
  },
  {
    name: 'astronomy_get_ephemeris',
    errors: getEphemerisTool.errors,
    handler: getEphemerisTool.handler,
  },
  {
    name: 'astronomy_get_satellite_passes',
    errors: getSatellitePassesTool.errors,
    handler: getSatellitePassesTool.handler,
  },
  { name: 'astronomy://body/{body}', errors: bodyResource.errors, handler: bodyResource.handler },
];

/**
 * Strip comments before scanning for call sites, so a reason named in prose — several
 * handlers document which resolver raises what — is never counted as a throw. Mirrors
 * how the linter reads `handler.toString()`.
 */
function strippedSource(handler: ContractCase['handler']): string {
  return String(handler)
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/\/\/[^\n]*/g, ' ');
}

/**
 * True when the handler holds a literal `ctx.fail(<reason>` naming this reason. Both
 * quote styles count: the source is single-quoted, and the test transform re-emits
 * string literals double-quoted, so pinning one style would read every site as absent.
 */
function failsWith(source: string, reason: string): boolean {
  return source.includes(`ctx.fail('${reason}'`) || source.includes(`ctx.fail("${reason}"`);
}

describe.each(CONTRACT_CASES)('$name — every declared reason is producible', (c) => {
  const source = strippedSource(c.handler);

  it('declares at least one failure mode', () => {
    expect(c.errors?.length ?? 0).toBeGreaterThan(0);
  });

  it.each((c.errors ?? []).map((e) => [e.reason, e] as const))(
    '%s is thrown in the handler or marked thrownBy: service',
    (reason, entry) => {
      const thrownHere = failsWith(source, reason);
      const thrownBelow = entry.thrownBy === 'service';
      expect(
        thrownHere || thrownBelow,
        `reason "${reason}" has no literal ctx.fail('${reason}', …) in the handler and is not marked thrownBy: 'service'`,
      ).toBe(true);
      // A reason cannot be both — the marker says the handler is not where it comes from.
      expect(
        thrownHere && thrownBelow,
        `reason "${reason}" is marked thrownBy: 'service' yet thrown in the handler`,
      ).toBe(false);
    },
  );

  it.each((c.errors ?? []).map((e) => [e.reason, e] as const))(
    '%s keeps its advertised shape alongside any lint marker',
    (_reason, entry) => {
      expect(typeof entry.reason).toBe('string');
      expect(typeof entry.when).toBe('string');
      expect(typeof entry.recovery).toBe('string');
      expect(typeof entry.code).toBe('number');
      if (entry.thrownBy !== undefined) expect(entry.thrownBy).toBe('service');
    },
  );
});

/** The `recovery` string a definition declares for one of its contract reasons. */
function declaredRecovery(errors: readonly ErrorContract[] | undefined, reason: string): string {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No contract entry declares reason "${reason}".`);
  return entry.recovery;
}

/** Read the `content[0]` text surface of a `CallToolResult`. */
function firstText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
}

/** Read the `structuredContent.error` surface of a `CallToolResult`. */
function errorEnvelope(result: Awaited<ReturnType<typeof runToolContract>>) {
  return (
    result.structuredContent as
      | { error?: { code?: number; data?: { reason?: string; recovery?: { hint?: string } } } }
      | undefined
  )?.error;
}

/**
 * A handler-thrown reason and a service-thrown one, driven through the production
 * rendering path. Both must land the declared hint on both surfaces and close the text
 * with the reason term a caller branches on — the `structuredContent` client reads
 * `data.reason`, the format()-only client reads it off the rendered tail.
 */
describe('declared recovery reaches both client surfaces', () => {
  it('carries a handler-thrown reason (find_events / observer_required)', async () => {
    const result = await runToolContract(findEventsTool, { event: 'solar_eclipse' });
    const hint = declaredRecovery(findEventsTool.errors, 'observer_required');

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.data?.reason).toBe('observer_required');
    expect(errorEnvelope(result)?.data?.recovery?.hint).toBe(hint);
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
    expect(firstText(result)).toContain('(reason observer_required');
  });

  it('carries a service-thrown reason (get_sky_position / star_not_found)', async () => {
    const result = await runToolContract(getSkyPositionTool, { star: 'Betelgeuze', ...SEATTLE });
    const hint = declaredRecovery(getSkyPositionTool.errors, 'star_not_found');

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(errorEnvelope(result)?.data?.reason).toBe('star_not_found');
    expect(errorEnvelope(result)?.data?.recovery?.hint).toBe(hint);
    expect(firstText(result)).toContain(`Recovery: ${hint}`);
    expect(firstText(result)).toContain('(reason star_not_found');
  });
});
