/**
 * @fileoverview Static reference data for the ephemeris layer: per-body mean radius
 *   (for angular-diameter computation), body type, and naked-eye visibility. Loaded
 *   once at module init — no upstream, no per-request allocation.
 * @module services/ephemeris/body-data
 */

import type { BodyName } from './types.js';

export type BodyType = 'star' | 'planet' | 'moon' | 'dwarf';

export interface BodyMeta {
  /** Mean radius in kilometers — drives angular-diameter. Null for the point-source convention. */
  meanRadiusKm: number;
  /** Naked-eye visible under typical conditions. */
  nakedEye: boolean;
  /** Canonical display name. */
  name: string;
  /** Classification. */
  type: BodyType;
}

/**
 * Mean equatorial radii (km) from IAU / NASA fact sheets. Used to derive apparent
 * angular diameter from the engine's distance; the Sun and Moon are the large discs,
 * the planets resolve to arcseconds, Pluto is included for completeness.
 */
export const BODY_META: Record<BodyName, BodyMeta> = {
  sun: { name: 'Sun', type: 'star', meanRadiusKm: 695700, nakedEye: true },
  moon: { name: 'Moon', type: 'moon', meanRadiusKm: 1737.4, nakedEye: true },
  mercury: { name: 'Mercury', type: 'planet', meanRadiusKm: 2439.7, nakedEye: true },
  venus: { name: 'Venus', type: 'planet', meanRadiusKm: 6051.8, nakedEye: true },
  mars: { name: 'Mars', type: 'planet', meanRadiusKm: 3389.5, nakedEye: true },
  jupiter: { name: 'Jupiter', type: 'planet', meanRadiusKm: 69911, nakedEye: true },
  saturn: { name: 'Saturn', type: 'planet', meanRadiusKm: 58232, nakedEye: true },
  uranus: { name: 'Uranus', type: 'planet', meanRadiusKm: 25362, nakedEye: false },
  neptune: { name: 'Neptune', type: 'planet', meanRadiusKm: 24622, nakedEye: false },
  pluto: { name: 'Pluto', type: 'dwarf', meanRadiusKm: 1188.3, nakedEye: false },
};
