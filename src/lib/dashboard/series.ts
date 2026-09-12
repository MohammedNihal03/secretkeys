import type { TrendPoint } from '@/components/trend-chart';

/**
 * Turning a stored series into chart points.
 *
 * The window is walked day by day rather than the stored rows being plotted
 * directly, because a day with no stored row is the thing most worth seeing: it
 * means no collection ran, and plotting only the rows that exist would quietly
 * close that gap and draw a continuous line through an outage.
 */
export function buildDailySeries(
  series: readonly { bucket: Date; requests: number | null }[],
  from: Date,
  days: number
): TrendPoint[] {
  const byDay = new Map(series.map((point) => [point.bucket.toISOString().slice(0, 10), point]));
  const points: TrendPoint[] = [];

  for (let index = 0; index < days; index += 1) {
    const day = new Date(from.getTime() + index * 86_400_000);
    const point = byDay.get(day.toISOString().slice(0, 10));

    points.push({
      label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      // Null, not zero: no row means nobody looked, which is not "no usage".
      value: point?.requests ?? null,
    });
  }

  return points;
}
