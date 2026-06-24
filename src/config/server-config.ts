/**
 * @fileoverview Server-specific configuration for astronomy-mcp-server.
 *   Lazy-parsed Zod schema mapping optional env vars to the extension gates and
 *   HTTP endpoint overrides. The keyless offline core needs no configuration;
 *   every variable here is optional and exists only for the two gated extensions.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  /** Gate the astronomy_get_ephemeris tool (JPL Horizons). Off by default. */
  enableHorizons: z.stringbool().default(false),
  /** Gate the astronomy_get_satellite_passes tool (CelesTrak TLE + SGP4). Off by default. */
  enableSatellites: z.stringbool().default(false),
  /** JPL Horizons API endpoint. */
  horizonsBaseUrl: z.string().default('https://ssd.jpl.nasa.gov/api/horizons.api'),
  /** CelesTrak GP/TLE endpoint. */
  celestrakBaseUrl: z.string().default('https://celestrak.org/NORAD/elements/gp.php'),
  /** Optional fallback IANA timezone when a tool call omits `timezone`. Unset = UTC-only output. */
  defaultTimezone: z.string().optional(),
  /** HTTP timeout (ms) for Horizons and CelesTrak requests. */
  requestTimeoutMs: z.coerce.number().default(15000),
  /** In-process TLE cache TTL (ms). Default 2h — respects CelesTrak's refetch guidance. */
  tleCacheTtlMs: z.coerce.number().default(7200000),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Parse and memoize the server configuration from the environment. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    enableHorizons: 'ASTRONOMY_ENABLE_HORIZONS',
    enableSatellites: 'ASTRONOMY_ENABLE_SATELLITES',
    horizonsBaseUrl: 'ASTRONOMY_HORIZONS_BASE_URL',
    celestrakBaseUrl: 'ASTRONOMY_CELESTRAK_BASE_URL',
    defaultTimezone: 'ASTRONOMY_DEFAULT_TIMEZONE',
    requestTimeoutMs: 'ASTRONOMY_REQUEST_TIMEOUT_MS',
    tleCacheTtlMs: 'ASTRONOMY_TLE_CACHE_TTL_MS',
  });
  return _config;
}
