#!/usr/bin/env node
/**
 * @fileoverview astronomy-mcp-server MCP server entry point. Computes observational
 *   astronomy in-process via astronomy-engine — apparent positions, rise/set, moon
 *   phases, eclipses, seasons, and a "what's up tonight" workflow. Two HTTP-backed
 *   extensions (JPL Horizons ephemerides, CelesTrak satellite passes) register only
 *   when their config gate is enabled, so the default deployment is keyless and offline.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { stargazingPlanPrompt } from './mcp-server/prompts/definitions/stargazing-plan.prompt.js';
import { bodyResource } from './mcp-server/resources/definitions/body.resource.js';
import { findEventsTool } from './mcp-server/tools/definitions/find-events.tool.js';
import { getEphemerisTool } from './mcp-server/tools/definitions/get-ephemeris.tool.js';
import { getMoonPhaseTool } from './mcp-server/tools/definitions/get-moon-phase.tool.js';
import { getRiseSetTool } from './mcp-server/tools/definitions/get-rise-set.tool.js';
import { getSatellitePassesTool } from './mcp-server/tools/definitions/get-satellite-passes.tool.js';
import { getSkyPositionTool } from './mcp-server/tools/definitions/get-sky-position.tool.js';
import { listVisibleTool } from './mcp-server/tools/definitions/list-visible.tool.js';
import { initEphemerisService } from './services/ephemeris/ephemeris-service.js';
import { initHorizonsService } from './services/horizons/horizons-service.js';
import { initSatelliteService } from './services/satellite/satellite-service.js';

const cfg = getServerConfig();

/** The five keyless offline core tools — always registered. */
const coreTools = [
  getSkyPositionTool,
  getRiseSetTool,
  getMoonPhaseTool,
  findEventsTool,
  listVisibleTool,
];

/** The two HTTP-backed extension tools — registered only when their gate is on. */
const extensionTools = [
  ...(cfg.enableHorizons ? [getEphemerisTool] : []),
  ...(cfg.enableSatellites ? [getSatellitePassesTool] : []),
];

await createApp({
  name: 'astronomy-mcp-server',
  title: 'astronomy-mcp-server',
  /**
   * Declared here rather than left to the `auto` default so the posture travels with the
   * source instead of with whatever the deployment happens to export. Every tool is a pure
   * function of its arguments — no handler calls `ctx.requestInput` — so the only thing
   * `stateless` gives up is the 2025-era multi-round-trip shim nothing here would use. Not
   * `require: 'stateful'`: there is no capability to fail startup over. `MCP_SESSION_MODE`
   * still wins when it carries a meaningful value, which is how an operator overrides this.
   */
  sessionMode: 'stateless',
  instructions:
    'Observer location is latitude/longitude in decimal degrees plus optional elevation; times are ISO 8601 UTC and default to now. This server does not geocode — resolve a place name to coordinates upstream (e.g. via openstreetmap) and a timezone via reference-data, then pass `timezone` to receive observer-local times. astronomy_list_visible is the one-call "what is up now" answer. The astronomy_get_ephemeris (small bodies) and astronomy_get_satellite_passes tools are off by default; enable them with ASTRONOMY_ENABLE_HORIZONS / ASTRONOMY_ENABLE_SATELLITES.',
  /**
   * Every catalog a client can list here is decided once, at startup: the tool array is
   * fixed by the two gates read above, and the resource, template, and prompt sets are
   * literals. None of them varies by caller — no definition declares an auth scope — so
   * the results are shareable rather than per-client, and an hour is short enough that a
   * redeploy flipping a gate reaches a reconnecting client on its next miss. Deliberately
   * absent is a `resources/read` entry: the one resource states its own longer hint, and a
   * server-wide default would silently apply that policy to whatever is added next. Cache
   * hints exist only on protocol revision 2026-07-28; 2025-era responses are unchanged.
   */
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'prompts/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  setup() {
    initEphemerisService();
    if (cfg.enableHorizons) {
      initHorizonsService(cfg.horizonsBaseUrl, cfg.requestTimeoutMs);
    }
    if (cfg.enableSatellites) {
      initSatelliteService(cfg.celestrakBaseUrl, cfg.requestTimeoutMs, cfg.tleCacheTtlMs);
    }
  },
  tools: [...coreTools, ...extensionTools],
  resources: [bodyResource],
  prompts: [stargazingPlanPrompt],
});
