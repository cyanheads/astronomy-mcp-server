/**
 * @fileoverview Strict ISO 8601 instant parsing, shared by every caller-supplied
 *   timestamp on this server. `new Date(value)` is too permissive on its own: a
 *   day-of-month that does not exist (2026-02-30, 2023-02-29, 2026-04-31) parses
 *   by rolling forward into the next month, so a parseability-only check answers a
 *   different instant than the caller asked for, and the implementation-defined
 *   fallback grammars ("August 11, 2026") parse even though no tool documents them.
 *   This module rejects both while leaving the accepted epoch range to the caller —
 *   the in-process engine restricts it to 1900–2100, JPL Horizons does not.
 * @module services/ephemeris/iso-time
 */

/**
 * The calendar-date head of an ISO 8601 instant: a four-digit year or a signed
 * six-digit expanded year, then an optional month and an optional day. Everything
 * from the date/time separator onward (time of day, fractional seconds, `Z` or a
 * numeric offset) is left to `Date` — the calendar check only owns the date. A
 * space is accepted alongside `T` as that separator, and a zone suffix is not
 * required, so both stay as permissive as they were before this check existed.
 *
 * The expanded-year alternative is deliberate: JPL Horizons answers epochs far
 * outside the four-digit range, and a grammar that only knew `\d{4}` would newly
 * reject a valid deep-past or deep-future request.
 */
const ISO_CALENDAR_HEAD = /^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[Tt ].*)?$/;

/** Days in each month of a common year, indexed from January. */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Proleptic Gregorian leap year: divisible by 4, except centuries, except those
 * divisible by 400. The shortcut "divisible by 4" wrongly rejects 2000-02-29 and
 * wrongly accepts 2100-02-29.
 */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Length of the given month (1-based) in the given year. */
function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] ?? 0;
}

/**
 * Parse an ISO 8601 instant whose calendar date exists, or return `undefined`.
 *
 * The day-of-month is validated against the written date fields rather than the
 * parsed UTC fields, so an offset-bearing instant that lands on a different UTC
 * day (`2026-06-30T23:00:00-05:00`) is still accepted — its written date is real.
 *
 * @param value - The caller-supplied timestamp.
 * @returns The parsed instant, or `undefined` when the string is not a strict ISO
 *   8601 instant or names a day that does not exist.
 */
export function parseIsoInstant(value: string): Date | undefined {
  const match = ISO_CALENDAR_HEAD.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = monthText === undefined ? 1 : Number(monthText);
  const day = dayText === undefined ? 1 : Number(dayText);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
