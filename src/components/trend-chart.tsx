/**
 * A bar chart of one metric over time.
 *
 * Hand-drawn SVG rather than a charting library, for two reasons. The shape of
 * the data here is fixed and tiny, so a library would be several hundred
 * kilobytes to draw twenty rectangles; and a chart of collected metrics has one
 * requirement no general-purpose library handles well, which is that a bucket
 * with no data must look different from a bucket whose value is zero.
 *
 * That distinction is drawn literally: a real zero gets a visible baseline
 * stub, and a gap gets a hollow outline with its own legend entry. A gap in
 * collection drawn as a zero would say "nothing was used" when the truth is
 * "nobody was watching".
 *
 * Server-rendered, with no interactivity beyond the native tooltip, so it costs
 * nothing on the client.
 */

export interface TrendPoint {
  label: string;
  /** Null means no data for this bucket. Zero means a measured zero. */
  value: number | null;
}

export interface TrendChartProps {
  points: readonly TrendPoint[];
  /** Formats a value for the tooltip and the peak label. */
  format?: (value: number) => string;
  height?: number;
  /** Accessible description of what is being charted. */
  title: string;
}

export function TrendChart({ points, format, height = 72, title }: TrendChartProps) {
  const values = points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
  const peak = values.length > 0 ? Math.max(...values) : 0;
  const show = format ?? ((value: number) => value.toLocaleString('en-US'));

  const hasGaps = points.some((point) => point.value === null);

  return (
    <figure className="flex flex-col gap-2">
      <div
        className="flex items-end gap-[3px]"
        style={{ height }}
        role="img"
        aria-label={`${title}. Peak ${show(peak)} across ${points.length} intervals.`}
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

          /**
           * A measured zero still gets 2px, so it is visibly present. Without
           * it, "zero requests" and "no bar drawn" are the same pixel.
           */
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
                    ? 'color-mix(in oklch, var(--accent) 72%, transparent)'
                    : 'var(--hairline-strong)',
              }}
              title={`${point.label}: ${show(point.value)}`}
            />
          );
        })}
      </div>

      <figcaption className="flex items-center justify-between gap-3 text-[11px] text-faint">
        <span>{points[0]?.label ?? ''}</span>
        {hasGaps ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2 rounded-[2px] border border-dashed border-hairline-strong" />
            not collected
          </span>
        ) : (
          <span className="font-mono tabular-nums">peak {show(peak)}</span>
        )}
        <span>{points.at(-1)?.label ?? ''}</span>
      </figcaption>
    </figure>
  );
}
