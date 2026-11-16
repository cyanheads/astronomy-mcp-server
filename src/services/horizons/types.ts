/**
 * @fileoverview Domain types for the JPL Horizons small-body ephemeris extension.
 * @module services/horizons/types
 */

import type { ConstellationRef } from '../ephemeris/types.js';

/**
 * One step of a Horizons OBSERVER ephemeris, normalized to the wire units. Every
 * numeric value present is finite — a row that cannot supply a required one is
 * discarded during the parse rather than carried with a sentinel the output schema
 * would reject. RA/Dec are astrometric ICRF (J2000), Horizons quantity 1.
 */
export interface EphemerisPoint {
  altitudeDegrees?: number;
  azimuthDegrees?: number;
  /** The constellation of the row's own J2000 RA/Dec, the frame `Constellation()` reads. */
  constellation: ConstellationRef;
  decDegrees: number;
  distanceAu: number;
  magnitude: number | null;
  raHours: number;
  /**
   * Horizons quantity 23 (S-O-T), in degrees, from the request's vantage: the observer when
   * one was supplied, Earth's center otherwise. Null when the column carries no number.
   */
  sunElongationDegrees: number | null;
  timeUtc: string;
  /**
   * The side of the Sun from the S-O-T `/r` code: `/L` (leads) is morning, `/T` (trails)
   * evening. Null for `/?` (aligned with the Sun's center) or no code.
   */
  visibility: 'morning' | 'evening' | null;
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
  /**
   * The object Horizons actually resolved the designation to, from the response's
   * `Target body name:` header with its `{source: …}` tag removed. Horizons resolves a
   * bare name by its own search, so this can name a different object than the caller
   * meant (`Eros` → `Kerberos (904)`). Absent when the response carries no such line.
   */
  targetName?: string;
  /**
   * True when Horizons returned more rows than the inline cap. The tool asks for one row
   * past the cap at most, so this reads that row. This field alone does not decide
   * continuation: the tool, not this field, also treats a page as continuing when a
   * dropped row left the cap unreached and one step past the last point is still inside
   * the requested span. The remaining rows are retrieved by re-calling from the instant
   * one step past the last row returned, never by widening `step` — a wider step answers
   * a different question, dropping samples the original range asked for instead of
   * retrieving them.
   */
  truncated: boolean;
}
