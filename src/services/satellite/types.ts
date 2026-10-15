/**
 * @fileoverview Domain types for the satellite-pass extension, including the OMM
 *   (Orbit Mean-Elements Message) record CelesTrak serves under `FORMAT=JSON` — the
 *   only format that carries the six-digit catalog numbers now in the catalog.
 * @module services/satellite/types
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * A single visible pass of a satellite over an observer. Rise and set are the horizon
 * crossings, refined to the second; the peak is the highest sample of the 30-second scan.
 * The `visible*` fields bound the stretch of the pass that is visible to the naked eye —
 * above the horizon, sunlit, and over a sky dark enough — which can start after the rise
 * or end before the set.
 */
export interface SatellitePass {
  durationSeconds: number;
  peakAltitudeDegrees: number;
  peakAzimuthDegrees: number;
  peakLocal?: string;
  peakUtc: string;
  riseAzimuthDegrees: number;
  riseLocal?: string;
  riseUtc: string;
  setAzimuthDegrees: number;
  setLocal?: string;
  setUtc: string;
  /**
   * Satellite is sunlit at the peak instant. A pass that enters Earth's shadow before its
   * peak, or leaves it after, is returned with this false — its visible stretch says when
   * it can be seen.
   */
  sunlit: boolean;
  /** Altitude where the visible stretch ends — 0 when it ends at the set. */
  visibleEndAltitudeDegrees: number;
  visibleEndAzimuthDegrees: number;
  visibleEndLocal?: string;
  visibleEndUtc: string;
  /** Altitude where the visible stretch starts — 0 when it starts at the rise. */
  visibleStartAltitudeDegrees: number;
  visibleStartAzimuthDegrees: number;
  visibleStartLocal?: string;
  visibleStartUtc: string;
}

export interface SatellitePassResult {
  noradId: number;
  passes: SatellitePass[];
  /**
   * Where a search continuing this one starts: one scan step past `windowEnd`. A pass
   * rising by `windowEnd` is in this result through its set, and one still up at the
   * resume instant counts as underway there, so the continuation neither repeats nor
   * skips a pass.
   */
  resumeAt: Date;
  /**
   * Whether `resumeAt` lies inside the element set's epoch horizon, so a search starting
   * there is accepted. Beyond it the continuation would fail `time_out_of_range`.
   */
  resumeInRange: boolean;
  satelliteName: string;
  /** The last instant the scan looked for a rise — `days` after the start. */
  windowEnd: Date;
}

/**
 * The OMM spec leaves numeric types open and sources disagree — CelesTrak emits numbers,
 * Space-Track emits strings. The propagator coerces either, so accept both rather than
 * rejecting a well-formed element set over its JSON type.
 */
const OmmNumber = z.union([z.number(), z.string()]);

/**
 * One GP record as CelesTrak serves it under `FORMAT=JSON`. Validated at the network
 * edge because every field here is read straight into the SGP4 initializer — a missing
 * one becomes NaN and surfaces as a plausible-looking but meaningless pass rather than a
 * failure. `OBJECT_ID` and `ELEMENT_SET_NO` take no part in the propagation math but are
 * required by the OMM v3 record the propagator accepts, and CelesTrak supplies both on
 * every GP record. Unknown keys are dropped: nothing downstream reads them.
 */
export const OmmRecordSchema = z.object({
  ARG_OF_PERICENTER: OmmNumber,
  BSTAR: OmmNumber,
  ECCENTRICITY: OmmNumber,
  ELEMENT_SET_NO: OmmNumber,
  EPOCH: z.string(),
  INCLINATION: OmmNumber,
  MEAN_ANOMALY: OmmNumber,
  MEAN_MOTION: OmmNumber,
  MEAN_MOTION_DDOT: OmmNumber,
  MEAN_MOTION_DOT: OmmNumber,
  NORAD_CAT_ID: OmmNumber,
  OBJECT_ID: z.string(),
  OBJECT_NAME: z.string(),
  RA_OF_ASC_NODE: OmmNumber,
});

export type OmmRecord = z.infer<typeof OmmRecordSchema>;

/** A CelesTrak `FORMAT=JSON` response body: an array of GP records, one per match. */
export const OmmResponseSchema = z.array(OmmRecordSchema);

/** A current element set for one catalogued object, with its identity resolved. */
export interface ElementSet {
  name: string;
  noradId: number;
  omm: OmmRecord;
}

/**
 * One object a name query matched. Snake-cased because this shape goes straight onto the
 * wire in the ambiguity error's `data`, alongside the tool's other client-facing fields.
 */
export interface SatelliteCandidate {
  name: string;
  norad_id: number;
}
