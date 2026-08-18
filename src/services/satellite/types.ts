/**
 * @fileoverview Domain types for the satellite-pass extension, including the OMM
 *   (Orbit Mean-Elements Message) record CelesTrak serves under `FORMAT=JSON` — the
 *   only format that carries the six-digit catalog numbers now in the catalog.
 * @module services/satellite/types
 */

import { z } from '@cyanheads/mcp-ts-core';

/** A single visible pass of a satellite over an observer. */
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
  /** Satellite is sunlit at peak (naked-eye visible only when this is true and the ground is dark). */
  sunlit: boolean;
}

export interface SatellitePassResult {
  noradId: number;
  passes: SatellitePass[];
  satelliteName: string;
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
