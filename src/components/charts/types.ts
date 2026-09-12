/**
 * The vocabulary every chart in this application shares.
 *
 * One rule runs through all of them, and it is the reason these are hand-drawn
 * rather than pulled from a charting library: **null is not zero**. A general
 * purpose library treats a missing point as something to interpolate over or
 * drop, and both of those draw a smooth line across an outage. Here a gap is
 * rendered as a gap, deliberately, because "nobody was watching" and "usage was
 * zero" are opposite facts that must never look the same.
 *
 * All of them are server components with no client JavaScript. A chart of
 * twenty points does not need a runtime, and shipping one for this would cost
 * more than the entire page weighs.
 */

export interface ChartPoint {
  /** Shown in the tooltip and, for the first and last point, under the chart. */
  label: string;
  /** Null means no data for this position, which is drawn as a gap. */
  value: number | null;
}

export interface ChartSlice {
  label: string;
  value: number;
  /** A CSS colour. Defaults come from the palette below. */
  color?: string;
}

/**
 * Series colours, in the order they are handed out.
 *
 * Drawn from the existing status and accent tokens rather than a new palette,
 * so a chart never introduces a colour the rest of the interface does not use.
 * Deliberately short: a chart that needs a tenth colour needs fewer series.
 */
export const SERIES_COLORS = [
  'var(--accent)',
  'var(--ok)',
  'var(--warn)',
  'var(--critical)',
  'var(--unknown)',
  'color-mix(in oklch, var(--accent) 55%, var(--ok))',
  'color-mix(in oklch, var(--warn) 55%, var(--critical))',
] as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

/** The numeric range a chart is drawn against, ignoring gaps. */
export function extent(points: readonly ChartPoint[]): { min: number; max: number } {
  const values = points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);

  if (values.length === 0) return { min: 0, max: 0 };

  const min = Math.min(...values);
  const max = Math.max(...values);

  /**
   * A flat series still needs a band to be drawn in, or every point lands on
   * the same pixel and the line vanishes into the axis.
   */
  return min === max
    ? { min: min === 0 ? 0 : min * 0.9, max: max === 0 ? 1 : max * 1.1 }
    : { min, max };
}

/** Formats a value, falling back to a plain localized number. */
export type Formatter = (value: number) => string;

export const defaultFormat: Formatter = (value) =>
  Math.abs(value) >= 1000 ? value.toLocaleString('en-US') : String(Math.round(value * 100) / 100);
