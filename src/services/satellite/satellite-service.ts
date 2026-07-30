/**
 * @fileoverview SatelliteService — gated extension that predicts visible satellite
 *   passes. Fetches the current TLE from CelesTrak (keyless, cached briefly in
 *   process per CelesTrak's refetch guidance), propagates with SGP4 via satellite.js
 *   (offline), and returns above-horizon passes. A pass is "visible" only when the
 *   satellite is sunlit at peak AND the observer's sky is dark — the ground-darkness
 *   gate reuses the core sun-altitude logic. Network-touching code carries its own
 *   timeout + retry boundary and degrades loudly; it never substitutes core output.
 * @module services/satellite/satellite-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { Body, Equator, Horizon, MakeTime, Observer } from 'astronomy-engine';
import {
  ecfToLookAngles,
  eciToEcf,
  gstime,
  jday,
  propagate,
  type SatRec,
  shadowFraction,
  sunPos,
  twoline2satrec,
} from 'satellite.js';
import type { ObserverInput } from '../ephemeris/types.js';
import type { SatellitePass, SatellitePassResult, Tle } from './types.js';

const DEG = 180 / Math.PI;
/** Minimum peak elevation (deg) for a pass to count — below this it grazes the horizon. */
const MIN_PEAK_ELEVATION = 10;
/** Propagation step in seconds while scanning for passes. */
const STEP_SECONDS = 30;
/** Ground is "dark enough" for a naked-eye pass when the Sun is below this altitude (civil dusk). */
const GROUND_DARK_SUN_ALT = -6;

interface CachedTle {
  expiresAt: number;
  tle: Tle;
}

export class SatelliteService {
  private readonly cache = new Map<number, CachedTle>();

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly cacheTtlMs: number,
  ) {}

  /** Fetch a current TLE for a NORAD ID, using the in-process TTL cache. */
  async fetchTle(noradId: number, ctx: Context): Promise<Tle> {
    const cached = this.cache.get(noradId);
    if (cached && cached.expiresAt > Date.now()) return cached.tle;

    const reqCtx = requestContextService.createRequestContext({
      operation: 'SatelliteService.fetchTle',
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId },
    });
    const url = `${this.baseUrl}?CATNR=${noradId}&FORMAT=TLE`;

    let text: string;
    try {
      text = await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
            signal: ctx.signal,
            // CelesTrak answers an uncatalogued object with 404, which is a domain
            // outcome here (tle_not_found), not a service failure — log it at debug.
            // The thrown status-mapped McpError is unchanged; only severity drops.
            expectedStatuses: [404],
          });
          return response.text();
        },
        {
          operation: 'SatelliteService.fetchTle',
          context: reqCtx,
          baseDelayMs: 1000,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      // fetchWithTimeout throws a status-mapped McpError on any non-2xx whose
      // data carries raw upstream internals (URL, status/body plus the legacy
      // statusCode/responseBody aliases). Map it into the typed contract with
      // clean data so nothing upstream leaks to the client. CelesTrak answers a
      // missing object with 404 → NotFound.
      throw this.classifyFetchError(err, noradId);
    }

    const tle = this.parseTle(text, noradId);
    this.cache.set(noradId, { tle, expiresAt: Date.now() + this.cacheTtlMs });
    return tle;
  }

  /**
   * Map a fetch/transport McpError onto the typed contract with leak-free data.
   * A NotFound (CelesTrak's 404 for an uncatalogued object) becomes tle_not_found;
   * everything else — 5xx (ServiceUnavailable), a fetch deadline (Timeout), or a
   * network failure — becomes celestrak_unavailable. The
   * original error rides as `cause` for server-side logs but never reaches the client.
   */
  private classifyFetchError(err: unknown, noradId: number): McpError {
    if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
      return notFound(`CelesTrak has no current element set for NORAD ID ${noradId}.`, {
        reason: 'tle_not_found',
        recovery: {
          hint: 'Verify the catalog number at celestrak.org; the object may have decayed or never been catalogued.',
        },
      });
    }
    return serviceUnavailable(
      `Failed to fetch a TLE for NORAD ID ${noradId} from CelesTrak.`,
      {
        reason: 'celestrak_unavailable',
        recovery: { hint: 'CelesTrak is degraded or timed out; retry in a few minutes.' },
      },
      { cause: err instanceof Error ? err : undefined },
    );
  }

  /** Parse a CelesTrak TLE response (optional name line + the two element lines). */
  private parseTle(text: string, noradId: number): Tle {
    const trimmed = text.trim();
    if (/No GP data found|Invalid query/i.test(trimmed) || trimmed.length === 0) {
      throw notFound(`CelesTrak has no current element set for NORAD ID ${noradId}.`, {
        reason: 'tle_not_found',
        recovery: {
          hint: 'Verify the catalog number at celestrak.org; the object may have decayed or never been catalogued.',
        },
      });
    }
    const lines = trimmed.split('\n').map((l) => l.trimEnd());
    const line1Index = lines.findIndex((l) => l.startsWith('1 '));
    const line2Index = lines.findIndex((l) => l.startsWith('2 '));
    const line1 = line1Index === -1 ? undefined : lines[line1Index];
    const line2 = line2Index === -1 ? undefined : lines[line2Index];
    if (!line1 || !line2) {
      throw serviceUnavailable(
        `CelesTrak returned an unparsable response for NORAD ID ${noradId}.`,
        {
          reason: 'celestrak_unavailable',
          recovery: { hint: 'CelesTrak may be degraded; retry in a few minutes.' },
        },
      );
    }
    const nameLine = line1Index > 0 ? lines[line1Index - 1]?.trim() : undefined;
    return { ...(nameLine ? { name: nameLine } : {}), line1, line2 };
  }

  /**
   * Predict visible passes over the next `days` from `start`. Steps the orbit with
   * SGP4, brackets above-horizon intervals, and keeps passes whose peak is sunlit
   * and over a dark-enough ground.
   */
  predictPasses(
    tle: Tle,
    noradId: number,
    observer: ObserverInput,
    days: number,
    start: Date,
    formatLocal?: (d: Date) => string,
  ): SatellitePassResult {
    const satrec = twoline2satrec(tle.line1, tle.line2);
    const observerGd = {
      longitude: (observer.longitude * Math.PI) / 180,
      latitude: (observer.latitude * Math.PI) / 180,
      height: observer.elevation / 1000,
    };
    const engineObserver = new Observer(observer.latitude, observer.longitude, observer.elevation);

    const passes: SatellitePass[] = [];
    const totalSteps = Math.floor((days * 86400) / STEP_SECONDS);

    let inPass = false;
    let riseTime: Date | null = null;
    let riseAz = 0;
    let peakElevation = -90;
    let peakAz = 0;
    let peakTime: Date | null = null;
    let lastAz = 0;

    for (let i = 0; i <= totalSteps; i++) {
      const t = new Date(start.getTime() + i * STEP_SECONDS * 1000);
      const look = this.lookAngles(satrec, t, observerGd);
      if (!look) continue;
      const elevationDeg = look.elevation * DEG;
      const azimuthDeg = (((look.azimuth * DEG) % 360) + 360) % 360;

      if (elevationDeg > 0) {
        if (!inPass) {
          inPass = true;
          riseTime = t;
          riseAz = azimuthDeg;
          peakElevation = elevationDeg;
          peakAz = azimuthDeg;
          peakTime = t;
        } else if (elevationDeg > peakElevation) {
          peakElevation = elevationDeg;
          peakAz = azimuthDeg;
          peakTime = t;
        }
        lastAz = azimuthDeg;
      } else if (inPass) {
        // Pass just ended at the previous step.
        inPass = false;
        if (riseTime && peakTime && peakElevation >= MIN_PEAK_ELEVATION) {
          const setTime = t;
          const sunlit = this.isSunlit(satrec, peakTime);
          const groundDark = this.isGroundDark(engineObserver, peakTime);
          if (sunlit && groundDark) {
            const pass: SatellitePass = {
              riseUtc: riseTime.toISOString(),
              peakUtc: peakTime.toISOString(),
              setUtc: setTime.toISOString(),
              peakAltitudeDegrees: peakElevation,
              riseAzimuthDegrees: riseAz,
              setAzimuthDegrees: lastAz,
              peakAzimuthDegrees: peakAz,
              durationSeconds: (setTime.getTime() - riseTime.getTime()) / 1000,
              sunlit,
            };
            if (formatLocal) {
              pass.riseLocal = formatLocal(riseTime);
              pass.peakLocal = formatLocal(peakTime);
              pass.setLocal = formatLocal(setTime);
            }
            passes.push(pass);
          }
        }
        riseTime = null;
        peakTime = null;
        peakElevation = -90;
      }
    }

    return { noradId, ...(tle.name ? { satelliteName: tle.name } : {}), passes };
  }

  /** Compute look angles (az/el) of the satellite from the observer at one instant. */
  private lookAngles(
    satrec: SatRec,
    date: Date,
    observerGd: { longitude: number; latitude: number; height: number },
  ): { azimuth: number; elevation: number } | null {
    const pv = propagate(satrec, date);
    if (!pv) return null;
    const gmst = gstime(date);
    const ecf = eciToEcf(pv.position, gmst);
    const look = ecfToLookAngles(observerGd, ecf);
    return { azimuth: look.azimuth, elevation: look.elevation };
  }

  /** True when the satellite is in sunlight (not in Earth's umbra) at the given time. */
  private isSunlit(satrec: SatRec, date: Date): boolean {
    const pv = propagate(satrec, date);
    if (!pv) return false;
    const sun = sunPos(jday(date));
    const fraction = shadowFraction(sun.rsun, pv.position);
    return fraction < 0.5;
  }

  /** True when the observer's sky is dark enough (Sun below civil dusk) for a naked-eye pass. */
  private isGroundDark(observer: Observer, date: Date): boolean {
    const time = MakeTime(date);
    const eq = Equator(Body.Sun, time, observer, true, true);
    const hor = Horizon(time, observer, eq.ra, eq.dec, 'normal');
    return hor.altitude < GROUND_DARK_SUN_ALT;
  }
}

// --- Init / accessor pattern ------------------------------------------------

let _service: SatelliteService | undefined;

/** Initialize the satellite service with the configured endpoint, timeout, and cache TTL. */
export function initSatelliteService(baseUrl: string, timeoutMs: number, cacheTtlMs: number): void {
  _service = new SatelliteService(baseUrl, timeoutMs, cacheTtlMs);
}

/** Accessor — throws if not initialized (the gate is off). */
export function getSatelliteService(): SatelliteService {
  if (!_service) {
    throw new Error('SatelliteService not initialized — enable ASTRONOMY_ENABLE_SATELLITES');
  }
  return _service;
}
