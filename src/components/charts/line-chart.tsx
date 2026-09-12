import { defaultFormat, extent, type ChartPoint, type Formatter } from './types';

/**
 * A line chart over time, with an area fill under it.
 *
 * Gaps are the interesting part. A run of consecutive readings is drawn as one
 * path; a null breaks the path and starts a new one, so a period with no data
 * is visibly empty rather than being bridged by a straight line. A dashed rule
 * marks where that happened, because an unexplained gap looks like a rendering
 * bug and an explained one looks like an outage.
 *
 * Drawn in a fixed 100 x `height` user space and stretched with
 * `preserveAspectRatio="none"`, which is what lets it fill any column width
 * without measuring anything on the client.
 */

export interface LineChartProps {
  points: readonly ChartPoint[];
  /** Accessible description. Also used in the summary line. */
  title: string;
  format?: Formatter;
  height?: number;
  color?: string;
  /** Hides the first/last labels under the chart, for a dense row. */
  bare?: boolean;
}

interface Segment {
  points: { x: number; y: number; point: ChartPoint }[];
}

export function LineChart({
  points,
  title,
  format = defaultFormat,
  height = 96,
  color = 'var(--accent)',
  bare = false,
}: LineChartProps) {
  const { min, max } = extent(points);
  const span = max - min || 1;

  const readings = points.filter((point) => point.value !== null);

  if (readings.length === 0) {
    return <EmptyPlot height={height} title={title} />;
  }

  /**
   * Positions are computed once. A single point would divide by zero, so it is
   * placed in the middle rather than at the left edge.
   */
  const x = (index: number) => (points.length === 1 ? 50 : (index / (points.length - 1)) * 100);
  const y = (value: number) => height - ((value - min) / span) * height;

  const segments: Segment[] = [];
  let current: Segment | null = null;

  points.forEach((point, index) => {
    if (point.value === null) {
      current = null;
      return;
    }

    if (!current) {
      current = { points: [] };
      segments.push(current);
    }

    current.points.push({ x: x(index), y: y(point.value), point });
  });

  const gaps = points.reduce((total, point) => (point.value === null ? total + 1 : total), 0);

  const last = readings.at(-1)?.value ?? 0;

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`${title}. Latest ${format(last)}, ranging from ${format(min)} to ${format(max)} across ${points.length} intervals${gaps > 0 ? `, with ${gaps} not collected` : ''}.`}
      >
        {segments.map((segment, index) => {
          const line = segment.points
            .map((entry, position) => `${position === 0 ? 'M' : 'L'} ${entry.x} ${entry.y}`)
            .join(' ');

          /**
           * The fill closes down to the baseline. Only drawn for a segment with
           * more than one point: a lone reading has no area, and closing it
           * would paint a spike that was never measured.
           */
          const area =
            segment.points.length > 1
              ? `${line} L ${segment.points.at(-1)?.x ?? 0} ${height} L ${segment.points[0].x} ${height} Z`
              : null;

          return (
            <g key={index}>
              {area ? <path d={area} fill={color} opacity={0.13} /> : null}
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              {/* A single reading has no line to show, so it gets a dot. */}
              {segment.points.length === 1 ? (
                <circle cx={segment.points[0].x} cy={segment.points[0].y} r={2} fill={color}>
                  <title>{`${segment.points[0].point.label}: ${format(segment.points[0].point.value ?? 0)}`}</title>
                </circle>
              ) : null}
            </g>
          );
        })}

        {/* Where the series stops and restarts, marked rather than smoothed over. */}
        {points.map((point, index) =>
          point.value === null ? (
            <line
              key={`gap-${index}`}
              x1={x(index)}
              x2={x(index)}
              y1={0}
              y2={height}
              stroke="var(--hairline-strong)"
              strokeWidth={1}
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            >
              <title>{`${point.label}: not collected`}</title>
            </line>
          ) : null
        )}

        {/* An invisible hit target per reading, so hovering gives the value. */}
        {segments.flatMap((segment) =>
          segment.points.map((entry, index) => (
            <circle
              key={`hit-${entry.x}-${index}`}
              cx={entry.x}
              cy={entry.y}
              r={3}
              fill="transparent"
            >
              <title>{`${entry.point.label}: ${format(entry.point.value ?? 0)}`}</title>
            </circle>
          ))
        )}
      </svg>

      {bare ? null : (
        <figcaption className="flex items-center justify-between gap-3 text-[11px] text-faint">
          <span>{points[0]?.label ?? ''}</span>
          <span className="font-mono tabular-nums">
            {format(min)} to {format(max)}
            {gaps > 0 ? ` · ${gaps} not collected` : ''}
          </span>
          <span>{points.at(-1)?.label ?? ''}</span>
        </figcaption>
      )}
    </figure>
  );
}

/** Nothing to plot: said in the space the chart would have taken. */
export function EmptyPlot({ height, title }: { height: number; title: string }) {
  return (
    <figure
      className="flex items-center justify-center rounded-lg border border-dashed border-hairline"
      style={{ height }}
    >
      <figcaption className="px-3 text-center text-[11px] text-faint">
        No {title.toLowerCase()} has been collected yet.
      </figcaption>
    </figure>
  );
}
