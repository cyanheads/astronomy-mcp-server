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
  instructions:
    'Observer location is latitude/longitude in decimal degrees plus optional elevation; times are ISO 8601 UTC and default to now. This server does not geocode — resolve a place name to coordinates upstream (e.g. via openstreetmap) and a timezone via reference-data, then pass `timezone` to receive observer-local times. astronomy_list_visible is the one-call "what is up now" answer. The astronomy_get_ephemeris (small bodies) and astronomy_get_satellite_passes tools are off by default; enable them with ASTRONOMY_ENABLE_HORIZONS / ASTRONOMY_ENABLE_SATELLITES.',
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
