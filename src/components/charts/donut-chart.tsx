import { defaultFormat, seriesColor, type ChartSlice, type Formatter } from './types';

/**
 * A donut chart, for composition: how a total divides between providers,
 * projects or connection states.
 *
 * Two rules it keeps that a general-purpose chart does not:
 *
 * - **It refuses to draw a partial total as a whole one.** If some contributors
 *   report the figure and others cannot, the caller passes `unknown`, and an
 *   explicit slice is drawn for the part nobody can account for. A donut that
 *   silently omits the unknown portion reads as "this is all of it", which is
 *   the most misleading thing a composition chart can do.
 * - **It does not invent a zero.** An empty set draws nothing and says so.
 *
 * Built from `stroke-dasharray` on a circle rather than arc paths: the maths is
 * one subtraction per slice instead of trigonometry, and the result is exact at
 * any size.
 */

export interface DonutChartProps {
  slices: readonly ChartSlice[];
  title: string;
  format?: Formatter;
  /** Diameter in pixels. */
  size?: number;
  /**
   * A portion of the total that no contributor could report. Drawn as a
   * hatched slice rather than left out.
   */
  unknown?: { value: number; label?: string } | null;
  /** Shown in the middle. Defaults to the total of the slices. */
  centerLabel?: string;
  centerNote?: string;
}

const STROKE = 14;

export function DonutChart({
  slices,
  title,
  format = defaultFormat,
  size = 148,
  unknown = null,
  centerLabel,
  centerNote,
}: DonutChartProps) {
  const known = slices.filter((slice) => slice.value > 0);
  const knownTotal = known.reduce((total, slice) => total + slice.value, 0);
  const unknownValue = unknown && unknown.value > 0 ? unknown.value : 0;
  const total = knownTotal + unknownValue;

  if (total <= 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-hairline p-4 text-center text-[11px] text-faint"
        style={{ minHeight: size }}
      >
        No {title.toLowerCase()} has been reported for this window.
      </div>
    );
  }

  const radius = (size - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;

  const drawn = [
    ...known.map((slice, index) => ({
      ...slice,
      color: slice.color ?? seriesColor(index),
      hatched: false,
    })),
    ...(unknownValue > 0
      ? [
          {
            label: unknown?.label ?? 'Not reported',
            value: unknownValue,
            color: 'var(--unknown)',
            hatched: true,
          },
        ]
      : []),
  ];

  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${title}. ${drawn
          .map(
            (slice) =>
              `${slice.label} ${format(slice.value)}, ${Math.round((slice.value / total) * 100)}%`
          )
          .join('. ')}.`}
        className="shrink-0"
      >
        <defs>
          {/* The unknown slice is hatched, so it reads as absent even in grey. */}
          <pattern
            id="donut-unknown"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill="var(--surface-sunken)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--unknown)" strokeWidth="2.5" />
          </pattern>
        </defs>

        {/* The track, so a nearly-empty donut still reads as a ring. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--hairline)"
          strokeWidth={STROKE}
        />

        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {drawn.map((slice) => {
            const length = (slice.value / total) * circumference;
            const dash = `${length} ${circumference - length}`;
            const element = (
              <circle
                key={slice.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={slice.hatched ? 'url(#donut-unknown)' : slice.color}
                strokeWidth={STROKE}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
              >
                <title>{`${slice.label}: ${format(slice.value)} (${Math.round((slice.value / total) * 100)}%)`}</title>
              </circle>
            );

            offset += length;
            return element;
          })}
        </g>

        <text
          x={size / 2}
          y={size / 2 - 2}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-[var(--color-foreground)] font-mono text-[15px] font-medium"
        >
          {centerLabel ?? format(total)}
        </text>
        {centerNote ? (
          <text
            x={size / 2}
            y={size / 2 + 16}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-[var(--color-faint)] text-[10px]"
          >
            {centerNote}
          </text>
        ) : null}
      </svg>

      <ul className="flex min-w-0 flex-1 flex-col gap-2">
        {drawn.map((slice) => (
          <li key={slice.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{
                  background: slice.hatched ? 'var(--unknown)' : slice.color,
                  opacity: slice.hatched ? 0.5 : 1,
                }}
              />
              <span className="truncate">{slice.label}</span>
            </span>
            <span className="shrink-0 font-mono tabular-nums text-muted">
              {format(slice.value)}
              <span className="ml-2 text-faint">{Math.round((slice.value / total) * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
