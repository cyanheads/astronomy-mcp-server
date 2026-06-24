/**
 * @fileoverview Domain types for the JPL Horizons small-body ephemeris extension.
 * @module services/horizons/types
 */

/** One step of a Horizons OBSERVER ephemeris, normalized to the wire units. */
export interface EphemerisPoint {
  altitudeDegrees?: number;
  azimuthDegrees?: number;
  decDegrees: number;
  distanceAu: number;
  magnitude: number | null;
  raHours: number;
  timeUtc: string;
}

export interface EphemerisResult {
  designation: string;
  points: EphemerisPoint[];
  /** True when Horizons returned more rows than the inline cap; reduce by widening `step`. */
  truncated: boolean;
}
