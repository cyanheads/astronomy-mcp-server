/**
 * @fileoverview SatelliteService — gated extension that predicts visible satellite
 *   passes. Fetches the current GP element set from CelesTrak as OMM JSON (keyless,
 *   cached briefly in process per CelesTrak's refetch guidance), propagates it with SGP4
 *   via satellite.js (offline), and returns above-horizon passes. One request builder
 *   serves both lookups: by catalog number (`CATNR=`) and by name (`NAME=`, a
 *   case-insensitive substring match whose single-match response already carries the
 *   element set, so resolving a name costs no extra round trip). Horizon crossings are
 *   bisected to the second between 30-second scan samples. A pass is reported when its
 *   visible stretch — above the horizon, the satellite sunlit, and the Sun below −6° for
 *   the observer — reaches 10° altitude, wherever in the pass that stretch falls; the
 *   ground-darkness test reuses the core sun-altitude logic. A pass up longer than one
 *   scan step when the window opens is omitted rather than reported with the query
 *   boundary as its rise (one rising in the 30 s before the start is reported), and one
 *   still up when the window closes is followed to its set. Well-known
 *   common names (ISS, Hubble, Tiangong) resolve through a fixed alias table to their
 *   catalog numbers before any `NAME=` search. A start beyond the element set's epoch
 *   horizon is rejected on that distance alone, and inside the horizon an element set
 *   that will not propagate at all is rejected as a decayed object — neither reaches the caller as a 200-shaped answer,
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
  type EciVec3,
  ecfToLookAngles,
  eciToEcf,
  gstime,
  jday,
  json2satrec,
  type Kilometer,
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
/**
 * Altitude (deg) a pass's visible stretch has to reach for the pass to be reported — below
 * it the satellite stays in the murk near the horizon. A pass whose peak falls short is
 * passed over before any illumination test.
 */
const MIN_PEAK_ELEVATION = 10;
/** Propagation step in seconds while scanning for passes. */
const STEP_SECONDS = 30;
/**
 * Resolution, in ms, to which a horizon crossing or a visible-stretch edge is bisected
 * between the scan samples bracketing it. Five halvings of a 30-second step.
 */
const EDGE_RESOLUTION_MS = 1000;
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
 * Common names for the objects people ask about most, mapped to their catalog numbers.
 * CelesTrak's `NAME=` search cannot reach any of them from the everyday name: "ISS"
 * matches over a dozen objects, "Hubble" matches unrelated cubesats (the telescope is
 * catalogued as `HST`), and no catalog name contains "Tiangong" (the station is
 * `CSS (TIANHE)`). Keys are compared after trimming and lower-casing the query.
 */
const NAME_ALIASES: ReadonlyMap<string, number> = new Map([
  ['iss', 25544],
  ['international space station', 25544],
  ['hubble', 20580],
  ['hubble space telescope', 20580],
  ['hst', 20580],
  ['tiangong', 48274],
  ['css', 48274],
  ['chinese space station', 48274],
]);

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

/** What every propagation in one prediction needs: the orbit, and the observer two ways. */
interface ScanSite {
  /** Observer in radians and km, as satellite.js takes it. */
  geodetic: { longitude: number; latitude: number; height: number };
  satrec: SatRec;
  /** The same observer as astronomy-engine takes it, for the Sun's altitude. */
  sky: Observer;
}

/** One propagated instant: where the satellite sits in the observer's sky and in space. */
interface Sample {
  azimuthDeg: number;
  elevationDeg: number;
  /** ECI position (km), kept so the shadow test reuses the propagation. */
  position: EciVec3<Kilometer>;
  time: Date;
}

/** One end of a visible stretch. */
interface StretchEdge {
  altitude: number;
  azimuth: number;
  time: Date;
}

/** A run of a pass visible to the naked eye, with the highest altitude it reaches. */
interface VisibleStretch {
  end: StretchEdge;
  highest: number;
  start: StretchEdge;
}

const isUp = (s: Sample): boolean => s.elevationDeg > 0;

/** A stretch edge on a horizon crossing: the crossing itself, at the horizon's altitude. */
const horizonEdge = (s: Sample): StretchEdge => ({
  time: s.time,
  altitude: 0,
  azimuth: s.azimuthDeg,
});

/** A stretch edge inside the pass, where the satellite enters or leaves shadow or twilight. */
const skyEdge = (s: Sample): StretchEdge => ({
  time: s.time,
  altitude: s.elevationDeg,
  azimuth: s.azimuthDeg,
});

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
   * contain it. Anything else comes back as candidates to choose from. A well-known
   * common name in `NAME_ALIASES` skips the search and resolves by catalog number.
   */
  async resolveByName(name: string, ctx: Context): Promise<ElementSet> {
    const query = name.trim();
    const aliased = NAME_ALIASES.get(query.toLowerCase());
    if (aliased !== undefined) return this.fetchElementSet(aliased, ctx);

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
       * carries raw upstream internals (status/statusText/body plus the legacy
       * statusCode/responseBody aliases). Map it into the typed contract with clean data
       * so nothing upstream leaks to the client. The request URL is no longer among
       * those internals — the framework stopped putting it on client-facing data — but
       * the captured body still echoes the query, so the data is replaced rather than
       * forwarded. CelesTrak answers an unmatched query with 404 → NotFound; everything
       * else — 5xx, a fetch deadline, a network failure — is an outage. The original
       * rides as `cause` for server-side logs only.
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
   * SGP4 every `STEP_SECONDS`, brackets above-horizon intervals, refines each horizon
   * crossing to the second, and keeps a pass when its visible stretch — sunlit, over a
   * dark-enough sky — reaches `MIN_PEAK_ELEVATION`.
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
    const site: ScanSite = {
      satrec,
      geodetic: {
        longitude: (observer.longitude * Math.PI) / 180,
        latitude: (observer.latitude * Math.PI) / 180,
        height: observer.elevation / 1000,
      },
      sky: new Observer(observer.latitude, observer.longitude, observer.elevation),
    };

    const passes: SatellitePass[] = [];
    const totalSteps = Math.floor((days * 86400) / STEP_SECONDS);
    /**
     * A pass that rises inside the window belongs to it even when it sets after the window
     * ends, so a scan that reaches its last step mid-pass keeps stepping until the set. One
     * orbital period bounds that overrun, which covers any pass of an orbit that rises and
     * sets; an object still up after that (a near-geostationary one) cannot hold the scan
     * open, and its pass stays unreported as before. `no` is the SGP4 mean motion in
     * radians per minute.
     */
    const overrunSteps = Math.ceil(((2 * Math.PI) / satrec.no) * (60 / STEP_SECONDS));

    /**
     * A rise is a below→above transition between scan samples. When the window opens with
     * the satellite already up, the first sample is the query boundary, not an
     * acquisition — reporting it as `riseUtc` would misstate the rise time, the rise
     * azimuth, and the duration, so that leading partial pass is omitted and reporting
     * starts at the first complete one. Deciding that needs the step *before* `start`: a
     * satellite below the horizon there rose inside the step that ends at `start`, which is
     * an acquisition this window owns, and dropping it would lose the pass for any caller
     * who passed a previously reported `riseUtc` back as `start` — or who resumed a capped
     * search one step past its window, where that step belongs to no earlier window.
     */
    const prior = this.sample(site, new Date(start.getTime() - STEP_SECONDS * 1000));
    let lastBelow = prior !== null && prior.elevationDeg <= 0 ? prior : null;
    let pass: { below: Sample; above: [Sample, ...Sample[]] } | null = null;

    for (let i = 0; i <= totalSteps || (pass !== null && i <= totalSteps + overrunSteps); i++) {
      const s = this.sample(site, new Date(start.getTime() + i * STEP_SECONDS * 1000));
      if (!s) continue;
      if (s.elevationDeg > 0) {
        if (pass) pass.above.push(s);
        else if (lastBelow) pass = { below: lastBelow, above: [s] };
        continue;
      }
      if (pass) {
        const visible = this.completePass(site, pass.below, pass.above, s, formatLocal);
        if (visible) passes.push(visible);
        pass = null;
      }
      lastBelow = s;
    }

    const windowEnd = new Date(start.getTime() + totalSteps * STEP_SECONDS * 1000);
    const resumeAt = new Date(windowEnd.getTime() + STEP_SECONDS * 1000);
    return {
      noradId: elements.noradId,
      satelliteName: elements.name,
      passes,
      windowEnd,
      resumeAt,
      resumeInRange: this.epochDistanceDays(satrec, resumeAt) <= MAX_EPOCH_DISTANCE_DAYS,
    };
  }

  /**
   * Turn one bracketed above-horizon interval into a reported pass, or `null` when it is
   * not visible enough to report. `below` and `after` are the scan samples on either side
   * of the interval, both at or under the horizon; `above` is every sample over it.
   *
   * The peak stays the highest scan sample. The rise and set are bisected between the
   * samples bracketing each crossing, and the visible stretch is located on the crossings
   * plus the samples between them: a sample counts as visible when the satellite is
   * sunlit and the Sun is below `GROUND_DARK_SUN_ALT`, an edge inside the pass is bisected
   * the same way, and an edge on a crossing is that crossing at altitude 0. Testing only
   * the peak instant dropped every pass that crosses into or out of Earth's shadow on the
   * dark side of its peak, however long it is lit over a dark sky.
   */
  private completePass(
    site: ScanSite,
    below: Sample,
    above: [Sample, ...Sample[]],
    after: Sample,
    formatLocal: ((d: Date) => string) | undefined,
  ): SatellitePass | null {
    const peak = above.reduce((best, s) => (s.elevationDeg > best.elevationDeg ? s : best));
    // A pass grazing the horizon is skipped before any bisection or illumination work.
    if (peak.elevationDeg < MIN_PEAK_ELEVATION) return null;

    const first = above[0];
    const last = above.at(-1) ?? first;
    const rise = this.bisect(site, below, first, isUp)[1];
    const set = this.bisect(site, last, after, isUp)[1];

    const visibility = new Map<Sample, boolean>();
    const isVisible = (s: Sample): boolean => {
      let visible = visibility.get(s);
      if (visible === undefined) {
        // Shadow first: it is the cheaper test, and the Sun's altitude only matters when lit.
        visible = this.isSunlit(s) && this.isGroundDark(site.sky, s.time);
        visibility.set(s, visible);
      }
      return visible;
    };
    const points = [...(rise === first ? [] : [rise]), ...above, set];
    const stretch = this.visibleStretch(site, points, isVisible);
    if (!stretch || stretch.highest < MIN_PEAK_ELEVATION) return null;

    const result: SatellitePass = {
      riseUtc: rise.time.toISOString(),
      peakUtc: peak.time.toISOString(),
      setUtc: set.time.toISOString(),
      peakAltitudeDegrees: peak.elevationDeg,
      riseAzimuthDegrees: rise.azimuthDeg,
      setAzimuthDegrees: set.azimuthDeg,
      peakAzimuthDegrees: peak.azimuthDeg,
      durationSeconds: (set.time.getTime() - rise.time.getTime()) / 1000,
      sunlit: this.isSunlit(peak),
      visibleStartUtc: stretch.start.time.toISOString(),
      visibleEndUtc: stretch.end.time.toISOString(),
      visibleStartAltitudeDegrees: stretch.start.altitude,
      visibleEndAltitudeDegrees: stretch.end.altitude,
      visibleStartAzimuthDegrees: stretch.start.azimuth,
      visibleEndAzimuthDegrees: stretch.end.azimuth,
    };
    if (formatLocal) {
      result.riseLocal = formatLocal(rise.time);
      result.peakLocal = formatLocal(peak.time);
      result.setLocal = formatLocal(set.time);
      result.visibleStartLocal = formatLocal(stretch.start.time);
      result.visibleEndLocal = formatLocal(stretch.end.time);
    }
    return result;
  }

  /**
   * The visible stretch of a pass reaching the highest altitude, or `null` when no point
   * of it is visible. `points` runs from the rise crossing through the scan samples to the
   * set crossing. A pass rarely holds more than one stretch — that takes an eclipse
   * shorter than the pass — but when it does, the one climbing higher is the one to look
   * for, and the earlier one wins a tie.
   */
  private visibleStretch(
    site: ScanSite,
    points: Sample[],
    isVisible: (s: Sample) => boolean,
  ): VisibleStretch | null {
    const visible = points.map(isVisible);
    let best: VisibleStretch | null = null;
    for (let i = 0; i < points.length; i++) {
      const first = points[i];
      if (!first || !visible[i]) continue;
      let j = i;
      while (visible[j + 1]) j++;
      const last = points[j] ?? first;
      const before = points[i - 1];
      const beyond = points[j + 1];
      // Off either end of `points` is a crossing, the edge of the pass itself.
      const start = before
        ? skyEdge(this.bisect(site, before, first, isVisible)[1])
        : horizonEdge(first);
      const end = beyond
        ? skyEdge(this.bisect(site, last, beyond, isVisible)[0])
        : horizonEdge(last);
      const highest = Math.max(
        start.altitude,
        end.altitude,
        ...points.slice(i, j + 1).map((s) => s.elevationDeg),
      );
      if (!best || highest > best.highest) best = { start, end, highest };
      i = j;
    }
    return best;
  }

  /**
   * Narrow the instant where `test` changes value between two samples it disagrees on,
   * `from` the earlier. Halves on whole seconds counted from `from` until the ends are
   * `EDGE_RESOLUTION_MS` apart and returns both ends, so the caller reports the side it
   * means. Counting from a scan sample keeps every probe on the scan's own second grid,
   * so the instant found is the first whole second past the change — what a one-second
   * scan from the same start reports — however the 30-second samples fall around it.
   */
  private bisect(
    site: ScanSite,
    from: Sample,
    to: Sample,
    test: (s: Sample) => boolean,
  ): [Sample, Sample] {
    const fromSide = test(from);
    let early = from;
    let late = to;
    while (late.time.getTime() - early.time.getTime() > EDGE_RESOLUTION_MS) {
      const gapSteps = (late.time.getTime() - early.time.getTime()) / EDGE_RESOLUTION_MS;
      const mid = this.sample(
        site,
        new Date(early.time.getTime() + Math.floor(gapSteps / 2) * EDGE_RESOLUTION_MS),
      );
      if (!mid) break;
      if (test(mid) === fromSide) early = mid;
      else late = mid;
    }
    return [early, late];
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

  /** Propagate to one instant and place the satellite in the observer's sky. */
  private sample(site: ScanSite, time: Date): Sample | null {
    const pv = propagate(site.satrec, time, PROPAGATE_OPTIONS);
    if (!pv) return null;
    const look = ecfToLookAngles(site.geodetic, eciToEcf(pv.position, gstime(time)));
    return {
      time,
      elevationDeg: look.elevation * DEG,
      azimuthDeg: (((look.azimuth * DEG) % 360) + 360) % 360,
      position: pv.position,
    };
  }

  /**
   * True when the satellite is in sunlight at a sample — Earth covers less than half the
   * solar disc. Reads the sample's own position, so it costs no propagation.
   */
  private isSunlit(s: Sample): boolean {
    return shadowFraction(sunPos(jday(s.time)).rsun, s.position) < 0.5;
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
