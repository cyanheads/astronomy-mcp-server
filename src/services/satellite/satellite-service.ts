/**
 * @fileoverview SatelliteService — gated extension that predicts visible satellite
 *   passes. Fetches the current GP element set from CelesTrak as OMM JSON (keyless,
 *   cached briefly in process per CelesTrak's refetch guidance), propagates it with SGP4
 *   via satellite.js (offline), and returns above-horizon passes. One request builder
 *   serves both lookups: by catalog number (`CATNR=`) and by name (`NAME=`, a
 *   case-insensitive substring match whose single-match response already carries the
 *   element set, so resolving a name costs no extra round trip). A pass is "visible"
 *   only when the satellite is sunlit at peak AND the observer's sky is dark — the
 *   ground-darkness gate reuses the core sun-altitude logic. A pass already underway
 *   when the window opens is omitted rather than reported with the query boundary as its
 *   rise. A start beyond the element set's epoch horizon is rejected on that distance
 *   alone, and inside the horizon an element set that will not propagate at all is
 *   rejected as a decayed object — neither reaches the caller as a 200-shaped answer,
 *   which would read as "nothing visible tonight" or as a pass list built from mean
 *   elements that stopped describing the orbit. Network-touching code carries its own
 *   timeout + retry boundary and degrades loudly; it never substitutes core output. A
 *   response that parses but is not an OMM element set is reported apart from an outage
 *   — its shape is a property of the record, so retrying it can only fail again.
 * @module services/satellite/satellite-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { Body, Equator, Horizon, MakeTime, Observer } from 'astronomy-engine';
import {
  ecfToLookAngles,
  eciToEcf,
  gstime,
  jday,
  json2satrec,
  propagate,
  type SatRec,
  shadowFraction,
  sunPos,
} from 'satellite.js';
import type { ObserverInput } from '../ephemeris/types.js';
import {
  type ElementSet,
  type OmmRecord,
  OmmResponseSchema,
  type SatelliteCandidate,
  type SatellitePass,
  type SatellitePassResult,
} from './types.js';

const DEG = 180 / Math.PI;
/**
 * Opt in to satellite.js's community decay check on every propagation. Reference SGP4
 * already refuses most element sets that no longer describe an orbit (eccentricity out
 * of range, or its own decay test), and does so before this check would; the check adds
 * the residual cases where the reference model still returns a numerically well-formed
 * but physically meaningless position. It deviates from reference SGP4 by design — a
 * pass prediction from meaningless state vectors is worse than no prediction.
 */
const PROPAGATE_OPTIONS = { communityDecayCheckEnabled: true } as const;
/** Julian date of the Unix epoch — converts `satrec.jdsatepoch` to milliseconds. */
const JD_UNIX_EPOCH = 2440587.5;
/**
 * How far the requested window may sit from the element set's epoch. CelesTrak serves
 * element sets refreshed within hours and SGP4 stops describing the orbit within weeks
 * of epoch, so a month comfortably covers any window anchored near the present. It also
 * separates the two ways a window can be unreachable: inside the horizon the element set
 * is current, so a refused propagation is the object having reentered; beyond it the
 * request is what overreached, whether or not the propagation would have succeeded.
 */
const MAX_EPOCH_DISTANCE_DAYS = 30;
/** Minimum peak elevation (deg) for a pass to count — below this it grazes the horizon. */
const MIN_PEAK_ELEVATION = 10;
/** Propagation step in seconds while scanning for passes. */
const STEP_SECONDS = 30;
/** Ground is "dark enough" for a naked-eye pass when the Sun is below this altitude (civil dusk). */
const GROUND_DARK_SUN_ALT = -6;
/**
 * How many candidates an ambiguous name query offers back. CelesTrak's `NAME=` is a
 * case-insensitive substring match, so an everyday query is routinely five figures deep
 * ("STARLINK" matches over ten thousand objects) — the list exists to let a caller
 * recognize the object it meant, not to enumerate the catalog. Twenty covers a real
 * family (the handful of objects carrying "HUBBLE", a weather-satellite series) while
 * keeping the error small enough to read; past that the answer is to narrow the name,
 * and the match count says so rather than passing a slice off as the whole set.
 */
const MAX_NAME_CANDIDATES = 20;

/**
 * Recovery hints, byte-identical to the `recovery` strings the tool declares for the
 * same reasons. The contract entry documents the next move and this is the copy that
 * reaches the wire; a test pins each pair so the two cannot drift apart.
 */
const TLE_NOT_FOUND_RECOVERY =
  'Verify the catalog number at celestrak.org; the object may have decayed or never been catalogued.';
const NAME_NOT_FOUND_RECOVERY =
  'Check the spelling, try a shorter distinctive substring, or look the object up at celestrak.org.';
const AMBIGUOUS_NAME_RECOVERY =
  'Re-call with norad_id set to one of the listed candidates, or supply a longer, more specific name.';
/**
 * The hint for an ambiguity whose candidate list is a slice rather than the whole match
 * set. Picking from the list is the right first move only when the list is complete;
 * offered against a constellation query it invites a confident pass prediction for an
 * object the caller never asked about, so the truncated case leads with narrowing and
 * makes the list conditional on the wanted object actually appearing in it.
 */
const AMBIGUOUS_NAME_TRUNCATED_RECOVERY =
  'Supply a longer, more specific name — the listed candidates are only the lowest-numbered few of the matches. Use norad_id only if the object you want is among them.';
const CELESTRAK_UNAVAILABLE_RECOVERY =
  'CelesTrak is degraded or timed out; retry in a few minutes.';
const MALFORMED_ELEMENT_SET_RECOVERY =
  'Retrying returns the same record — request a different object, and report the element set to celestrak.org.';

interface CachedElementSet {
  elements: ElementSet;
  expiresAt: number;
}

/**
 * A match set with at least one record. The parse rejects an empty response as a miss,
 * so every record list that reaches a caller has a first element — saying so in the type
 * keeps that invariant from being re-checked at each use.
 */
type MatchedRecords = [OmmRecord, ...OmmRecord[]];

export class SatelliteService {
  private readonly cache = new Map<string, CachedElementSet>();

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly cacheTtlMs: number,
  ) {}

  /** Fetch the current element set for a NORAD ID, using the in-process TTL cache. */
  async fetchElementSet(noradId: number, ctx: Context): Promise<ElementSet> {
    const cacheKey = `CATNR=${noradId}`;
    const cached = this.fromCache(cacheKey);
    if (cached) return cached;

    const records = await this.fetchGpRecords(cacheKey, `NORAD ID ${noradId}`, ctx, () =>
      this.catalogMiss(noradId),
    );
    return this.cacheElementSet(cacheKey, records[0]);
  }

  /**
   * Resolve a satellite name to the one current element set it names. CelesTrak matches
   * `NAME=` as a case-insensitive substring, so a query resolves only when it picks out a
   * single object — either because it matched one, or because exactly one match carries
   * that name outright, which is a request for that object however many longer names
   * contain it. Anything else comes back as candidates to choose from.
   */
  async resolveByName(name: string, ctx: Context): Promise<ElementSet> {
    const query = name.trim();
    const cacheKey = `NAME=${encodeURIComponent(query)}`;
    const cached = this.fromCache(cacheKey);
    if (cached) return cached;

    const records = await this.fetchGpRecords(cacheKey, `the name "${query}"`, ctx, () =>
      this.nameMiss(query),
    );
    const single = records.length === 1 ? records[0] : this.exactlyNamed(records, query);
    if (!single) throw this.ambiguousName(records, query);
    return this.cacheElementSet(cacheKey, single);
  }

  /** The one record whose `OBJECT_NAME` is the query itself, when exactly one is. */
  private exactlyNamed(records: OmmRecord[], query: string): OmmRecord | undefined {
    const wanted = query.toLowerCase();
    const exact = records.filter((r) => r.OBJECT_NAME.trim().toLowerCase() === wanted);
    return exact.length === 1 ? exact[0] : undefined;
  }

  /** The cached element set for a query, while its TTL holds. */
  private fromCache(cacheKey: string): ElementSet | undefined {
    const entry = this.cache.get(cacheKey);
    return entry && entry.expiresAt > Date.now() ? entry.elements : undefined;
  }

  private cacheElementSet(cacheKey: string, record: OmmRecord): ElementSet {
    const elements: ElementSet = {
      name: record.OBJECT_NAME.trim(),
      noradId: Number(record.NORAD_CAT_ID),
      omm: record,
    };
    this.cache.set(cacheKey, { elements, expiresAt: Date.now() + this.cacheTtlMs });
    return elements;
  }

  /**
   * Run one GP query and return the records it matched. `FORMAT=JSON` rather than
   * `FORMAT=TLE`: the legacy format cannot encode a catalog number above 99999, and
   * CelesTrak refuses to serve such an object as TLE at all, so JSON is the only format
   * covering the whole catalog. `params` is the query fragment selecting the objects
   * (`CATNR=` or `NAME=`); `miss` names an empty result in the caller's own terms, since
   * "no object with that catalog number" and "no object with that name" are different
   * answers with different next moves.
   */
  private async fetchGpRecords(
    params: string,
    subject: string,
    ctx: Context,
    miss: () => McpError,
  ): Promise<MatchedRecords> {
    const url = `${this.baseUrl}?${params}&FORMAT=JSON`;

    let text: string;
    try {
      text = await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
            signal: ctx.signal,
            // CelesTrak answers an unmatched query with 404, which is a domain outcome
            // here (a miss), not a service failure — log it at debug. The thrown
            // status-mapped McpError is unchanged; only severity drops.
            expectedStatuses: [404],
          });
          return response.text();
        },
        {
          operation: 'SatelliteService.fetchGpRecords',
          context: ctx,
          baseDelayMs: 1000,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      /**
       * fetchWithTimeout throws a status-mapped McpError on any non-2xx whose data
       * carries raw upstream internals (URL, status/body plus the legacy
       * statusCode/responseBody aliases). Map it into the typed contract with clean data
       * so nothing upstream leaks to the client. CelesTrak answers an unmatched query
       * with 404 → NotFound; everything else — 5xx, a fetch deadline, a network failure
       * — is an outage. The original rides as `cause` for server-side logs only.
       */
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) throw miss();
      throw serviceUnavailable(
        `Failed to fetch element sets for ${subject} from CelesTrak.`,
        {
          reason: 'celestrak_unavailable',
          recovery: { hint: CELESTRAK_UNAVAILABLE_RECOVERY },
        },
        { cause: err instanceof Error ? err : undefined },
      );
    }

    return this.parseGpRecords(text, subject, miss);
  }

  /**
   * Parse a CelesTrak GP response into OMM records. The miss sentinel has to be tested
   * before `JSON.parse`: CelesTrak returns that text under a 200 in some cases, and
   * parsing it would throw a `SyntaxError` where the caller is owed a typed miss.
   */
  private parseGpRecords(text: string, subject: string, miss: () => McpError): MatchedRecords {
    const trimmed = text.trim();
    if (trimmed.length === 0 || /No GP data found|Invalid query/i.test(trimmed)) throw miss();

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw this.unparsable(subject);
    }
    const records = OmmResponseSchema.safeParse(parsed);
    /**
     * A body that parsed as JSON but does not carry an OMM element set is a different
     * outcome from one that is not GP data at all: CelesTrak answered, with a record
     * whose shape is a permanent property of that record. Retrying reaches the same
     * record and fails the same way, so it is classified apart from the outage rather
     * than sending the caller into a loop that can only fail again.
     */
    if (!records.success) throw this.malformedElementSet(subject, records.error.issues);
    if (records.data.length === 0) throw miss();
    return records.data as MatchedRecords;
  }

  private unparsable(subject: string): McpError {
    return serviceUnavailable(`CelesTrak returned an unparsable response for ${subject}.`, {
      reason: 'celestrak_unavailable',
      recovery: { hint: CELESTRAK_UNAVAILABLE_RECOVERY },
    });
  }

  /**
   * Name the record that failed OMM validation, and the fields that failed it. Each
   * issue path is `[record index, field name]`, and those names are the OMM message's
   * own, so listing them says which part of the record is wrong without putting the
   * validator's vocabulary — issue codes, expected/received types — on the wire. A body
   * whose whole shape is wrong (an object where an array belongs) names no field, and
   * the message stands on the subject alone.
   */
  private malformedElementSet(
    subject: string,
    issues: readonly { path: PropertyKey[] }[],
  ): McpError {
    const fields = [...new Set(issues.map(({ path: [, field] }) => field))].filter(
      (field) => typeof field === 'string',
    );
    const named = fields.length > 0 ? ` Fields that did not validate: ${fields.join(', ')}.` : '';
    return serializationError(
      `CelesTrak returned a GP record for ${subject} that is not a valid OMM element set.${named}`,
      {
        reason: 'malformed_element_set',
        recovery: { hint: MALFORMED_ELEMENT_SET_RECOVERY },
      },
    );
  }

  private catalogMiss(noradId: number): McpError {
    return notFound(`CelesTrak has no current element set for NORAD ID ${noradId}.`, {
      reason: 'tle_not_found',
      recovery: { hint: TLE_NOT_FOUND_RECOVERY },
    });
  }

  private nameMiss(query: string): McpError {
    return notFound(`No current CelesTrak object has a name containing "${query}".`, {
      reason: 'satellite_name_not_found',
      recovery: { hint: NAME_NOT_FOUND_RECOVERY },
    });
  }

  /**
   * Hand back the objects a name query matched so the caller can name one outright. The
   * total is stated whether or not the list is complete, because a slice presented as the
   * whole set would read as a catalog holding twenty Starlinks. Ordered by catalog
   * number — the order CelesTrak already answers in — so the same query always offers the
   * same candidates. Whether the list is complete also selects the hint: a complete list
   * is something to pick from, a slice is something to narrow past.
   */
  private ambiguousName(records: OmmRecord[], query: string): McpError {
    const candidates: SatelliteCandidate[] = records
      .map((r) => ({ name: r.OBJECT_NAME.trim(), norad_id: Number(r.NORAD_CAT_ID) }))
      .sort((a, b) => a.norad_id - b.norad_id)
      .slice(0, MAX_NAME_CANDIDATES);
    const truncated = records.length > candidates.length;
    const listing = candidates.map((c) => `${c.name} (${c.norad_id})`).join(', ');
    const preamble = truncated
      ? `"${query}" matches ${records.length} current CelesTrak objects. The ${candidates.length} with the lowest catalog numbers:`
      : `"${query}" matches ${records.length} current CelesTrak objects:`;
    return invalidParams(`${preamble} ${listing}.`, {
      reason: 'ambiguous_satellite_name',
      recovery: {
        hint: truncated ? AMBIGUOUS_NAME_TRUNCATED_RECOVERY : AMBIGUOUS_NAME_RECOVERY,
      },
      match_count: records.length,
      shown: candidates.length,
      truncated,
      candidates,
    });
  }

  /**
   * Predict visible passes over the next `days` from `start`. Steps the orbit with
   * SGP4, brackets above-horizon intervals, and keeps passes whose peak is sunlit
   * and over a dark-enough ground.
   *
   * Throws `time_out_of_range` when `start` lies beyond the element set's epoch horizon,
   * and `object_decayed` when a window inside that horizon will not propagate at all.
   * Without those checks either condition reaches the caller as a 200-shaped result —
   * `passes: []`, which reads identically to "nothing visible tonight", or a pass list
   * built from elements that stopped describing the orbit weeks earlier.
   */
  predictPasses(
    elements: ElementSet,
    observer: ObserverInput,
    days: number,
    start: Date,
    formatLocal?: (d: Date) => string,
  ): SatellitePassResult {
    const satrec = json2satrec(elements.omm);
    /**
     * Reject a start the element set does not reach before propagating anything. SGP4's
     * own refusal cannot stand in for this: past the horizon it keeps answering with
     * numerically well-formed positions built from mean elements that no longer describe
     * the orbit, and whether it refuses at a given distance follows the element set's
     * drag terms rather than the distance itself. Gating the horizon on that refusal left
     * it unenforced for exactly the requests it exists to catch.
     */
    const epochDistanceDays = this.epochDistanceDays(satrec, start);
    if (epochDistanceDays > MAX_EPOCH_DISTANCE_DAYS) {
      throw this.startBeyondEpoch(elements.noradId, epochDistanceDays);
    }
    /**
     * Probe the first instant of the window before scanning it. Inside the horizon the
     * element set is current, so a refusal is the object having reentered rather than the
     * request overreaching — and the scan loop would silently skip every such timestep and
     * return an empty, falsely-successful pass list.
     */
    if (!propagate(satrec, start, PROPAGATE_OPTIONS)) {
      throw this.objectDecayed(elements.noradId);
    }
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
    /**
     * A rise is a below→above transition. When the window opens with the satellite
     * already up, the first sample is the query boundary, not an acquisition —
     * reporting it as `riseUtc` would misstate the rise time, the rise azimuth, and the
     * duration, so that leading partial pass is omitted and reporting starts at the
     * first complete one. Deciding that needs the step *before* `start`: a satellite
     * below the horizon there is rising exactly at `start`, which is a genuine
     * acquisition, and dropping it would lose the pass for any caller who took a
     * previously reported `riseUtc` and passed it back as `start`.
     */
    const priorLook = this.lookAngles(
      satrec,
      new Date(start.getTime() - STEP_SECONDS * 1000),
      observerGd,
    );
    let sawBelowHorizon = priorLook !== null && priorLook.elevation <= 0;

    for (let i = 0; i <= totalSteps; i++) {
      const t = new Date(start.getTime() + i * STEP_SECONDS * 1000);
      const look = this.lookAngles(satrec, t, observerGd);
      if (!look) continue;
      const elevationDeg = look.elevation * DEG;
      const azimuthDeg = (((look.azimuth * DEG) % 360) + 360) % 360;

      if (elevationDeg > 0) {
        if (!sawBelowHorizon) continue;
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
      } else {
        sawBelowHorizon = true;
        if (!inPass) continue;
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

    return { noradId: elements.noradId, satelliteName: elements.name, passes };
  }

  /** How far an instant sits from the element set's epoch, in days, on either side. */
  private epochDistanceDays(satrec: SatRec, instant: Date): number {
    const epochMs = (satrec.jdsatepoch - JD_UNIX_EPOCH) * 86400000;
    return Math.abs(instant.getTime() - epochMs) / 86400000;
  }

  /**
   * Blame the request when it reaches past the element set's validity horizon. Calling a
   * satellite that is still in orbit decayed would be a false statement with an
   * unfollowable recovery, so the message names the distance instead — the one fact that
   * says how far the start has to move.
   */
  private startBeyondEpoch(noradId: number, distanceDays: number): McpError {
    return invalidParams(
      `The requested start is ${distanceDays.toFixed(0)} days from the epoch of the current element set for NORAD ID ${noradId}; the element set stops describing the orbit well before that.`,
      {
        reason: 'time_out_of_range',
        recovery: {
          hint: 'An element set describes the orbit for weeks either side of its epoch — request a start within about a month of today.',
        },
      },
    );
  }

  /**
   * Blame the object when a window inside the epoch horizon still will not propagate. The
   * element set is current there, so mean elements that cannot describe an orbit are the
   * signature of a reentry rather than of a request that overreached.
   */
  private objectDecayed(noradId: number): McpError {
    return notFound(
      `NORAD ID ${noradId} has decayed — SGP4 cannot propagate its current element set to the requested window.`,
      {
        reason: 'object_decayed',
        recovery: {
          hint: 'Pick an object that is still in orbit; confirm its status at celestrak.org before requesting passes.',
        },
      },
    );
  }

  /** Compute look angles (az/el) of the satellite from the observer at one instant. */
  private lookAngles(
    satrec: SatRec,
    date: Date,
    observerGd: { longitude: number; latitude: number; height: number },
  ): { azimuth: number; elevation: number } | null {
    const pv = propagate(satrec, date, PROPAGATE_OPTIONS);
    if (!pv) return null;
    const gmst = gstime(date);
    const ecf = eciToEcf(pv.position, gmst);
    const look = ecfToLookAngles(observerGd, ecf);
    return { azimuth: look.azimuth, elevation: look.elevation };
  }

  /** True when the satellite is in sunlight (not in Earth's umbra) at the given time. */
  private isSunlit(satrec: SatRec, date: Date): boolean {
    const pv = propagate(satrec, date, PROPAGATE_OPTIONS);
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
