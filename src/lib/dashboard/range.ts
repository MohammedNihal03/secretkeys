/**
 * The time range every historical view is read through.
 *
 * One definition, parsed from the query string, so "last 7 days" means the same
 * span and the same bucket width on every page. Two pages that each did their
 * own date arithmetic would eventually disagree by a day, and the disagreement
 * would be invisible until someone compared two totals.
 *
 * The bucket width is derived from the span rather than chosen by the caller:
 * a month of hourly buckets is seven hundred bars in a strip a few hundred
 * pixels wide, and a day of daily buckets is one.
 */

import type { UsageBucket } from '@/lib/usage/repository';

export type RangePreset = 'today' | '7d' | '30d' | 'custom';

export interface TimeRange {
  preset: RangePreset;
  from: Date;
  /** Exclusive, so adjacent ranges neither overlap nor leave a gap. */
  to: Date;
  /** How the series is grouped. */
  bucket: UsageBucket;
  /** For the header: "Last 7 days", or the dates of a custom range. */
  label: string;
  /** Whole days spanned, for the daily series helpers. */
  days: number;
}

export const PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

const DAY_MS = 86_400_000;

/** Midnight UTC at the start of the day containing `at`. */
function startOfDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function isValidDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

function formatDay(at: Date): string {
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Reads a range from search params.
 *
 * Anything unparseable falls back to seven days rather than erroring: a
 * hand-edited URL should not be able to break a dashboard, and a range is a
 * view preference, not an instruction whose failure matters.
 */
export function parseRange(
  params: { range?: string | string[]; from?: string | string[]; to?: string | string[] },
  now: Date = new Date()
): TimeRange {
  const preset = first(params.range);

  if (preset === 'today') {
    const from = startOfDay(now);
    return {
      preset: 'today',
      from,
      // Exclusive end, one day on: today's data keeps arriving.
      to: new Date(from.getTime() + DAY_MS),
      bucket: 'hour',
      label: 'Today',
      days: 1,
    };
  }

  if (preset === 'custom') {
    const custom = parseCustom(first(params.from), first(params.to), now);
    if (custom) return custom;
  }

  if (preset === '30d') return rolling(30, now);

  return rolling(7, now);
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function rolling(days: number, now: Date): TimeRange {
  const to = startOfDay(now).getTime() + DAY_MS;
  const from = to - days * DAY_MS;

  return {
    preset: days === 30 ? '30d' : '7d',
    from: new Date(from),
    to: new Date(to),
    /**
     * A month is bucketed by day, not by week: weekly bars hide the day a
     * problem started, which is usually the question being asked.
     */
    bucket: 'day',
    label: `Last ${days} days`,
    days,
  };
}

/** Two `YYYY-MM-DD` dates, or null when they do not describe a usable range. */
function parseCustom(from: string | undefined, to: string | undefined, now: Date): TimeRange | null {
  if (!from || !to) return null;

  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);

  if (!isValidDate(start) || !isValidDate(end)) return null;
  if (end < start) return null;

  // The end date is inclusive to a reader, so the exclusive bound is the next day.
  const exclusiveEnd = new Date(end.getTime() + DAY_MS);

  const days = Math.max(1, Math.round((exclusiveEnd.getTime() - start.getTime()) / DAY_MS));

  /**
   * A year of daily buckets is fine; a year of hourly buckets is not, and
   * neither is a decade of anything. The cap is on the span, not on the number
   * of rows, because the rows are cheap and the chart is what suffers.
   */
  if (days > 366) return null;
  if (start > now) return null;

  return {
    preset: 'custom',
    from: start,
    to: exclusiveEnd,
    bucket: days <= 2 ? 'hour' : 'day',
    label: `${formatDay(start)} to ${formatDay(end)}`,
    days,
  };
}

/** The query string for a preset, for the range picker's links. */
export function rangeHref(base: string, preset: RangePreset, range?: TimeRange): string {
  if (preset !== 'custom') return `${base}?range=${preset}`;

  const from = range?.from ?? new Date();
  const to = range?.to ?? new Date();

  return `${base}?range=custom&from=${from.toISOString().slice(0, 10)}&to=${new Date(to.getTime() - DAY_MS).toISOString().slice(0, 10)}`;
}
