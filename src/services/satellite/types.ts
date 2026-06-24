/**
 * @fileoverview Domain types for the satellite-pass extension.
 * @module services/satellite/types
 */

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
  satelliteName?: string;
}

/** A parsed two-line element set plus its display name. */
export interface Tle {
  line1: string;
  line2: string;
  name?: string;
}
