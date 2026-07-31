/**
 * @fileoverview Shared assertions for the `content[]` / `structuredContent` numeric
 *   parity contract: display values stay rounded and readable, while every exact
 *   value a structured client reads remains recoverable from the rendered text.
 * @module tests/helpers/content-parity
 */

import { expect } from 'vitest';

/**
 * Strip the bracketed exact-value tails so what remains is only what a human reads
 * as the report. The readability contract applies to those display values; the
 * bracketed tails exist precisely so they can carry full precision.
 */
export const displayValuesOf = (text: string) => text.replaceAll(/ ?\[[^\]]*\]/g, '');

/** Significant digits in a rendered decimal, ignoring leading and padding zeros. */
function significantDigits(token: string): number {
  const [whole = '', fraction = ''] = token.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+/, '');
  return digits.replace(/0+$/, '').length;
}

/**
 * The readability contract: the report shows human-scale rounded numbers, never a
 * raw double's 15-to-17 significant digits. Stated in significant digits rather
 * than decimal places because each tool picks its own display precision, and a
 * small distance in AU legitimately needs many decimals to carry a few figures.
 * Whole numbers are exempt — a raw float always renders a fractional tail — and so
 * are the bracketed exact tails, which exist to carry full precision.
 */
export const expectRoundedDisplay = (text: string) => {
  for (const token of displayValuesOf(text).match(/\d+\.\d+/g) ?? []) {
    expect(significantDigits(token), `display value ${token} is not rounded`).toBeLessThan(9);
  }
};

/**
 * The exact structured value must appear verbatim in `content[]` — as the display
 * value itself when the rounding round-trips, otherwise in its bracketed tail.
 * `String(n)` is the shortest round-tripping decimal, so this is the parity check.
 */
export const expectExactCarried = (text: string, value: number) =>
  expect(text).toContain(String(value));
