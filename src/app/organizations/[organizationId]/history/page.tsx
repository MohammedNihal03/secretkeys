import { BarChart, EmptyPlot, LineChart, type ChartPoint } from '@/components/charts';
import { Notice } from '@/components/notice';
import { RangePicker } from '@/components/range-picker';
import { requireOrgAccess } from '@/lib/auth/guards';
import { parseRange, type TimeRange } from '@/lib/dashboard/range';
import { listMonitoredDatabases } from '@/lib/databases/repository';
import { metricHistoryByDatabase } from '@/lib/databases/storage';
import { usageTimeSeries, type UsageSeriesPoint } from '@/lib/usage/repository';

/**
 * Historical metrics.
 *
 * Every chart here is drawn from stored rows, over a range chosen in the URL.
 * None of it is sampled live, and none of it is interpolated: a bucket with no
 * stored row is drawn as a gap, because the collector not having run is a
 * different fact from nothing having happened, and the two look identical on
 * every dashboard that smooths them together.
 *
 * The AI half is bucketed by the usage table's own intervals; the database half
 * is drawn from the metric series at whatever rate the collector ran.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'History' };

/** The database metrics the build plan asks to chart, in order. */
const DATABASE_SERIES = [
  { metric: 'connections.current', label: 'Connections', format: whole },
  {
    metric: 'connections.utilizationPercent',
    label: 'Connection utilization',
    format: (value: number) => `${value.toFixed(1)}%`,
  },
  {
    metric: 'queries.longestRunningSeconds',
    label: 'Query duration',
    format: (value: number) => `${value.toFixed(1)} s`,
  },
  { metric: 'health.responseTimeMs', label: 'Response time', format: (value: number) => `${Math.round(value)} ms` },
  { metric: 'resources.databaseSizeBytes', label: 'Database size', format: bytes },
  {
    metric: 'postgres.cacheHitRatioInterval',
    label: 'Cache hit ratio',
    format: (value: number) => `${value.toFixed(1)}%`,
  },
] as const;

/**
 * Host metrics the plan asks for that PostgreSQL cannot supply.
 *
 * Listed rather than omitted. A history page that simply has no CPU chart reads
 * as an unfinished feature; one that says why there is no CPU chart is an
 * answer.
 */
const UNAVAILABLE = [
  { label: 'CPU', why: 'PostgreSQL does not report host CPU. It needs an operating-system agent, or a managed provider’s metrics API.' },
  { label: 'Memory', why: 'PostgreSQL does not report host memory. Shared buffers are visible; the machine’s total is not.' },
  { label: 'Disk', why: 'PostgreSQL does not report free disk space. Database size, charted above, is what it does know.' },
];

export default async function HistoryPage({
  params,
  searchParams,
}: PageProps<'/organizations/[organizationId]/history'>) {
  const { organizationId } = await params;
  await requireOrgAccess(organizationId);

  const range = parseRange(await searchParams);
  const base = `/organizations/${organizationId}/history`;

  const [series, databases] = await Promise.all([
    usageTimeSeries({ organizationId, from: range.from, to: range.to }, range.bucket),
    listMonitoredDatabases(organizationId),
  ]);

  /**
   * One query per charted metric, each covering every database at once, rather
   * than one per database per metric.
   */
  const histories = await Promise.all(
    DATABASE_SERIES.map(async (entry) => ({
      ...entry,
      byDatabase: await metricHistoryByDatabase(
        organizationId,
        entry.metric,
        range.from,
        range.days <= 1 ? 96 : 240
      ),
    }))
  );

  const hasUsage = series.length > 0;

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">History</h1>
        <p className="max-w-[70ch] text-sm text-muted">
          Stored metrics over {range.label.toLowerCase()}. Every chart is drawn from rows a
          collector wrote; a gap is a period with nothing stored, not a period of nothing
          happening.
        </p>
        <RangePicker range={range} base={base} />
      </header>

      <section className="glass rounded-(--radius-core) p-5 sm:p-6">
        <h2 className="mb-5 text-sm font-medium">AI usage</h2>

        {hasUsage ? (
          <div className="grid gap-8 sm:grid-cols-2">
            <Series
              label="Requests"
              points={bucketed(series, range, (point) => point.requests)}
              format={whole}
              kind="bar"
            />
            <Series
              label="Token usage"
              points={bucketed(series, range, (point) => point.totalTokens)}
              format={whole}
              kind="bar"
            />
            <Series
              label="Cost"
              points={bucketed(series, range, (point) => point.estimatedCost)}
              format={(value) => `$${value.toFixed(value < 1 ? 4 : 2)}`}
              kind="bar"
            />
            <Series
              label="Errors"
              points={bucketed(series, range, (point) => point.failedRequests)}
              format={whole}
              kind="bar"
            />
          </div>
        ) : (
          <Notice tone="limited" title="No AI usage is stored for this range">
            Usage appears once a collection returns rows for a registered key. Several providers
            expose no usage API at all, in which case these stay empty however long the collector
            runs, and each provider page says which.
          </Notice>
        )}
      </section>

      {databases.length === 0 ? null : (
        <section className="glass rounded-(--radius-core) p-5 sm:p-6">
          <h2 className="mb-5 text-sm font-medium">Databases</h2>

          <div className="flex flex-col gap-8">
            {databases.map((database) => (
              <div key={database.id} className="flex flex-col gap-4">
                <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-faint">
                  {database.name}
                </h3>

                <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
                  {histories.map((entry) => {
                    const points = (entry.byDatabase.get(database.id) ?? []).map((point) => ({
                      label: point.timestamp.toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                      value: point.value,
                    }));

                    return (
                      <Series
                        key={entry.metric}
                        label={entry.label}
                        points={points}
                        format={entry.format}
                        kind="line"
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 border-t border-hairline pt-5">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-faint">
              Not charted, and why
            </h3>
            <ul className="flex flex-col gap-2">
              {UNAVAILABLE.map((entry) => (
                <li key={entry.label} className="flex flex-wrap gap-x-2 text-xs">
                  <span className="font-medium">{entry.label}</span>
                  <span className="text-muted">{entry.why}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}

function Series({
  label,
  points,
  format,
  kind,
}: {
  label: string;
  points: ChartPoint[];
  format: (value: number) => string;
  kind: 'bar' | 'line';
}) {
  const readings = points.filter((point) => point.value !== null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium text-muted">{label}</h4>
        {readings.length > 0 ? (
          <span className="font-mono text-[11px] tabular-nums text-faint">
            {format(readings.at(-1)?.value ?? 0)}
          </span>
        ) : null}
      </div>

      {readings.length === 0 ? (
        <EmptyPlot height={72} title={label} />
      ) : kind === 'bar' ? (
        <BarChart points={points} format={format} title={label} height={72} />
      ) : (
        <LineChart points={points} format={format} title={label} height={72} />
      )}
    </div>
  );
}

/**
 * Walks the range bucket by bucket so an uncollected interval stays a gap.
 *
 * Plotting the stored rows directly would close that gap silently, which is the
 * one thing every chart in this application is built not to do.
 */
function bucketed(
  series: readonly UsageSeriesPoint[],
  range: TimeRange,
  read: (point: UsageSeriesPoint) => number | null
): ChartPoint[] {
  const step = range.bucket === 'hour' ? 3_600_000 : 86_400_000;
  const byBucket = new Map(series.map((point) => [point.bucket.getTime(), point]));

  const points: ChartPoint[] = [];

  for (let at = range.from.getTime(); at < range.to.getTime(); at += step) {
    const point = byBucket.get(at);

    points.push({
      label: new Date(at).toLocaleString('en-US',
        range.bucket === 'hour'
          ? { hour: '2-digit', minute: '2-digit' }
          : { month: 'short', day: 'numeric' }
      ),
      value: point ? read(point) : null,
    });
  }

  return points;
}

function whole(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Math.abs(value);
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
