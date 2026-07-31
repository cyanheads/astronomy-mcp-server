/**
 * @fileoverview Domain types for the JPL Horizons small-body ephemeris extension.
 * @module services/horizons/types
 */

/**
 * One step of a Horizons OBSERVER ephemeris, normalized to the wire units. Every
 * numeric value present is finite — a row that cannot supply a required one is
 * discarded during the parse rather than carried with a sentinel the output schema
 * would reject.
 */
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
  /**
   * Rows inside the ephemeris block that carried no usable point and were discarded.
   * Counted over the rows the cap let the parse reach, so `points.length + dropped` is
   * the number of rows examined. Non-zero means the series is shorter than the
   * requested step count, so the caller must disclose it rather than let the gap pass
   * as a complete answer.
   */
  dropped: number;
  points: EphemerisPoint[];
  /** True when Horizons returned more rows than the inline cap; reduce by widening `step`. */
  truncated: boolean;
}
