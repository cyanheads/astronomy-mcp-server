/**
 * @fileoverview Bundled meteor-shower table — the nine major annual showers of the IMO
 *   Working List of Visual Meteor Showers (Table 5), with the solar longitude of each
 *   maximum, its ZHR, its radiant, and its activity dates. Static asset, no upstream; it
 *   feeds astronomy_find_events' meteor_shower class. Also holds the lookup that resolves a
 *   caller's shower code or name to a row.
 *
 *   Source: International Meteor Organization, "2026 Meteor Shower Calendar", ed. Jürgen
 *   Rendtel, IMO INFO(3-25), https://www.imo.net/files/meteor-shower/cal2026.pdf,
 *   DOI 10.13140/RG.2.2.36179.08480. Only the nine rows' numeric parameters are bundled.
 * @module services/ephemeris/meteor-showers
 */

import { GREEK_LETTERS } from './star-catalog.js';

/** One major annual meteor shower, as the IMO 2026 calendar's Table 5 lists it. */
export interface MeteorShower {
  /**
   * The calendar's first and last activity dates (YYYY-MM-DD) around the 2026 maximum. The
   * window is the solar longitude the Sun holds at 12:00 UT on each, so it moves with the
   * maximum in other years.
   */
  activity2026: { end: string; start: string };
  /** Other names the shower is searched by, beside its code and IMO name. */
  aliases?: readonly string[];
  /** IMO three-letter code, e.g. "GEM". */
  code: string;
  /** IMO name, e.g. "Geminids". */
  name: string;
  /**
   * Solar longitude λ⊙ of the maximum in degrees, J2000: the Earth's heliocentric longitude
   * plus 180° in the J2000 mean ecliptic, without aberration.
   */
  peakSolarLongitudeDegrees: number;
  /** Radiant declination at the maximum in degrees, J2000. */
  radiantDecDegrees: number;
  /** Radiant right ascension at the maximum in degrees, J2000, as the calendar publishes it. */
  radiantRaDegrees: number;
  /** Zenithal hourly rate at the maximum. */
  zhr: number;
}

/** The nine showers in calendar order of their maxima, the Quadrantids first. */
export const METEOR_SHOWERS: readonly MeteorShower[] = [
  {
    code: 'QUA',
    name: 'Quadrantids',
    peakSolarLongitudeDegrees: 283.15,
    zhr: 80,
    radiantRaDegrees: 230,
    radiantDecDegrees: 49,
    activity2026: { start: '2025-12-28', end: '2026-01-12' },
  },
  {
    code: 'LYR',
    name: 'April Lyrids',
    aliases: ['Lyrids'],
    peakSolarLongitudeDegrees: 32.32,
    zhr: 18,
    radiantRaDegrees: 271,
    radiantDecDegrees: 34,
    activity2026: { start: '2026-04-14', end: '2026-04-30' },
  },
  {
    code: 'ETA',
    name: 'η-Aquariids',
    peakSolarLongitudeDegrees: 45.5,
    zhr: 50,
    radiantRaDegrees: 338,
    radiantDecDegrees: -1,
    activity2026: { start: '2026-04-19', end: '2026-05-28' },
  },
  {
    code: 'SDA',
    name: 'Southern δ-Aquariids',
    aliases: ['δ-Aquariids'],
    peakSolarLongitudeDegrees: 128,
    zhr: 25,
    radiantRaDegrees: 340,
    radiantDecDegrees: -16,
    activity2026: { start: '2026-07-12', end: '2026-08-23' },
  },
  {
    code: 'PER',
    name: 'Perseids',
    peakSolarLongitudeDegrees: 140.0,
    zhr: 100,
    radiantRaDegrees: 48,
    radiantDecDegrees: 58,
    activity2026: { start: '2026-07-17', end: '2026-08-24' },
  },
  {
    code: 'ORI',
    name: 'Orionids',
    peakSolarLongitudeDegrees: 208,
    zhr: 20,
    radiantRaDegrees: 95,
    radiantDecDegrees: 16,
    activity2026: { start: '2026-10-02', end: '2026-11-07' },
  },
  {
    code: 'LEO',
    name: 'Leonids',
    peakSolarLongitudeDegrees: 235.27,
    zhr: 15,
    radiantRaDegrees: 152,
    radiantDecDegrees: 22,
    activity2026: { start: '2026-11-06', end: '2026-11-30' },
  },
  {
    code: 'GEM',
    name: 'Geminids',
    peakSolarLongitudeDegrees: 262.2,
    zhr: 150,
    radiantRaDegrees: 112,
    radiantDecDegrees: 33,
    activity2026: { start: '2026-12-04', end: '2026-12-20' },
  },
  {
    code: 'URS',
    name: 'Ursids',
    peakSolarLongitudeDegrees: 270.7,
    zhr: 10,
    radiantRaDegrees: 217,
    radiantDecDegrees: 76,
    activity2026: { start: '2026-12-17', end: '2026-12-26' },
  },
];

/**
 * A shower code or name in the form the index is keyed by: lower-cased, split on whitespace,
 * hyphens, and underscores, with a Greek letter symbol spelled out — so `η-Aquariids`,
 * `Eta Aquariids`, and `eta_aquariids` all read `eta aquariids`.
 */
function showerKey(text: string): string {
  return text
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => GREEK_LETTERS.get(word) ?? word)
    .join(' ');
}

/** Every searchable form of every shower — code, IMO name, aliases — keyed by `showerKey`. */
const SHOWER_INDEX = new Map(
  METEOR_SHOWERS.flatMap((shower) =>
    [shower.code, shower.name, ...(shower.aliases ?? [])].map(
      (form) => [showerKey(form), shower] as const,
    ),
  ),
);

/**
 * The shower a code or name names — case-insensitive, with a Greek letter spelled out or
 * written as a symbol — or undefined when the table holds none by that name.
 */
export function findShower(text: string): MeteorShower | undefined {
  return SHOWER_INDEX.get(showerKey(text));
}
