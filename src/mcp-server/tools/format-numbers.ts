/**
 * @fileoverview Numeric rendering for tool `format()` output. `num`, `sig`, and `pct`
 *   emit a rounded display value for readability and carry the exact value in square
 *   brackets, so a `content[]`-only client can recover the same number a
 *   `structuredContent` client reads.
 *
 *   These helpers carry no domain judgment: the caller picks the display precision
 *   and the unit, because how coarse a value may read is a per-field decision that
 *   belongs in the tool definition. Whether to reach for them at all is the same kind
 *   of decision — `astronomy_list_visible` renders its scan line with plain `toFixed`
 *   and uses `sig` only for the distance, where the display cannot stand in for the
 *   value.
 * @module mcp-server/tools/format-numbers
 */

/** Append the exact value unless the rounded string already round-trips to it. */
function withExact(shown: string, unit: string, value: number): string {
  return Number(shown) === value ? `${shown}${unit}` : `${shown}${unit} [${value}]`;
}

/**
 * Fixed-decimal display for a quantity with a natural scale (degrees, magnitudes,
 * hours of right ascension, whole seconds).
 */
export function num(value: number, digits: number, unit = ''): string {
  return withExact(value.toFixed(digits), unit, value);
}

/** The rounded significant-figure string, without a unit or an exact tail. */
function sigDisplay(value: number, digits: number): string {
  return value === 0 ? '0' : Number(value.toPrecision(digits)).toString();
}

/**
 * Significant-figure display for a quantity spanning orders of magnitude — a distance
 * in AU runs from a spacecraft at 1e-5 through Pluto at 50 to a catalog star past 1e8,
 * and a fixed decimal count either collapses the small end to zero or pads the large end.
 */
export function sig(value: number, digits: number, unit = ''): string {
  return withExact(sigDisplay(value, digits), unit, value);
}

/**
 * A 0-to-1 fraction displayed as a percentage. The exact fraction is always carried
 * and always labelled, with no round-trip suppression, because this rendering changes
 * the unit as well as the precision — a reader must not mistake the displayed `89.0%`
 * for the `0.89` the output schema declares.
 */
export function pct(fraction: number, digits: number): string {
  return `${(fraction * 100).toFixed(digits)}% [fraction ${fraction}]`;
}
