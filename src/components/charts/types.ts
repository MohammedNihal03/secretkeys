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

/**
 * The range of the actual readings, ignoring gaps.
 *
 * Deliberately unpadded. An earlier version widened a flat series here so the
 * line would not sit on the axis, and the padded numbers reached the caption --
 * a database at a steady 100% cache hit ratio was labelled "90% to 110%", which
 * is not a possible value for a ratio. Padding is a drawing concern, so it
 * belongs to whatever is drawing, and never to what is reported.
 */
export function extent(points: readonly ChartPoint[]): { min: number; max: number } {
  const values = points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);

  if (values.length === 0) return { min: 0, max: 0 };

  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * The band a flat series is drawn inside.
 *
 * Only for positioning: without it every point lands on the same pixel and the
 * line disappears into the edge of the box.
 */
export function plotBand(min: number, max: number): { base: number; span: number } {
  if (min !== max) return { base: min, span: max - min };

  const padding = min === 0 ? 1 : Math.abs(min) * 0.1;
  return { base: min - padding, span: padding * 2 };
}

/** Formats a value, falling back to a plain localized number. */
export type Formatter = (value: number) => string;

export const defaultFormat: Formatter = (value) =>
  Math.abs(value) >= 1000 ? value.toLocaleString('en-US') : String(Math.round(value * 100) / 100);
