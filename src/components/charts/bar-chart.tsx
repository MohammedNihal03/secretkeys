import { defaultFormat, type ChartPoint, type Formatter } from './types';

/**
 * A bar chart of one metric over discrete intervals.
 *
 * The right chart for a count per day, where each bar is a thing that happened
 * rather than a sample of something continuous. Time series of a *level* -- a
 * response time, a connection count -- belong in the line chart instead; bars
 * imply a quantity accumulated over the interval.
 *
 * Two distinctions the bars draw literally:
 *
 * - A **measured zero** still gets a visible baseline stub. Without it, "zero
 *   requests" and "no bar drawn" are the same pixel.
 * - A **gap** gets a hollow dashed outline and its own legend entry, because a
 *   period nobody collected is not a period of no usage.
 */

export interface BarChartProps {
  points: readonly ChartPoint[];
  title: string;
  format?: Formatter;
  height?: number;
  color?: string;
  bare?: boolean;
}

export function BarChart({
  points,
  title,
  format = defaultFormat,
  height = 72,
  color = 'var(--accent)',
  bare = false,
}: BarChartProps) {
  const values = points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);

  const peak = values.length > 0 ? Math.max(...values) : 0;
  const gaps = points.length - values.length;

  return (
    <figure className="flex flex-col gap-2">
      <div
        className="flex items-end gap-[3px]"
        style={{ height }}
        role="img"
        aria-label={`${title}. Peak ${format(peak)} across ${points.length} intervals${gaps > 0 ? `, with ${gaps} not collected` : ''}.`}
      >
        {points.map((point, index) => {
          if (point.value === null) {
            return (
              <span
                key={`${point.label}-${index}`}
                className="min-w-0 flex-1 rounded-[2px] border border-dashed border-hairline-strong"
                style={{ height: '100%' }}
                title={`${point.label}: not collected`}
              />
            );
          }

          const ratio = peak > 0 ? point.value / peak : 0;
          const barHeight = Math.max(2, Math.round(ratio * height));

          return (
            <span
              key={`${point.label}-${index}`}
              className="min-w-0 flex-1 rounded-[2px] transition-[height] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
              style={{
                height: barHeight,
                background:
                  ratio > 0
                    ? `color-mix(in oklch, ${color} 72%, transparent)`
                    : 'var(--hairline-strong)',
              }}
              title={`${point.label}: ${format(point.value)}`}
            />
          );
        })}
      </div>

      {bare ? null : (
        <figcaption className="flex items-center justify-between gap-3 text-[11px] text-faint">
          <span>{points[0]?.label ?? ''}</span>
          {gaps > 0 ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2 rounded-[2px] border border-dashed border-hairline-strong" />
              {gaps} not collected
            </span>
          ) : (
            <span className="font-mono tabular-nums">peak {format(peak)}</span>
          )}
          <span>{points.at(-1)?.label ?? ''}</span>
        </figcaption>
      )}
    </figure>
  );
}
