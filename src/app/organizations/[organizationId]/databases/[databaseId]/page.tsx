import Link from 'next/link';
import { notFound } from 'next/navigation';

import { HealthDot, HealthPill } from '@/components/health-pill';
import { Metric, formatAgo, formatBytes } from '@/components/metric';
import { InlineNotice, Notice } from '@/components/notice';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { getMonitoredDatabase } from '@/lib/databases/repository';
import {
  latestMetrics,
  metricHistories,
  runsForDatabase,
  type MetricSummary,
} from '@/lib/databases/storage';
import { assessStoredMetrics } from '@/lib/evaluation/database';
import { ENVIRONMENT_LABELS } from '@/lib/projects/schema';
import { DatabaseControls } from './database-controls';

/**
 * One monitored database, in detail.
 *
 * The groups are the ones the build plan asks for -- overview, connections,
 * queries -- and every figure in them is the newest stored reading, with its
 * reason shown in place of the number when there is no reading. A metric that
 * PostgreSQL cannot expose says so here permanently, rather than being omitted
 * and leaving the impression that nothing is wrong with it.
 */

export const dynamic = 'force-dynamic';

const WINDOW_HOURS = 24;

const CHARTED = [
  'health.responseTimeMs',
  'connections.current',
  'connections.utilizationPercent',
  'postgres.transactionsPerSecond',
] as const;

export async function generateMetadata({
  params,
}: PageProps<'/organizations/[organizationId]/databases/[databaseId]'>) {
  const { organizationId, databaseId } = await params;
  const database = await getMonitoredDatabase(organizationId, databaseId).catch(() => null);

  return { title: database?.name ?? 'Database' };
}

export default async function DatabaseDetailPage({
  params,
}: PageProps<'/organizations/[organizationId]/databases/[databaseId]'>) {
  const { organizationId, databaseId } = await params;
  const access = await requireOrgAccess(organizationId);

  const database = await getMonitoredDatabase(organizationId, databaseId);
  if (!database) notFound();

  const base = `/organizations/${organizationId}`;
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  const canManage = hasPermission(access.role, 'databases:manage');

  const [metrics, histories, runs] = await Promise.all([
    latestMetrics(organizationId, databaseId, since),
    metricHistories(organizationId, databaseId, CHARTED, since),
    runsForDatabase(organizationId, databaseId),
  ]);

  const assessment = assessStoredMetrics(database.name, metrics, {
    reachable: database.lastCheckStatus === 'unhealthy' ? false : undefined,
    error: database.lastCheckDetail,
  });

  const read = (path: string) => metrics.find((entry) => entry.metric === path);
  const version = read('health.serverVersion')?.latestText ?? null;

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        <Link
          href={`${base}/databases`}
          className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint transition-colors hover:text-muted"
        >
          Databases
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{database.name}</h1>
              <HealthPill level={assessment.level} />
              <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
                {ENVIRONMENT_LABELS[database.environment]}
              </span>
            </div>

            <p className="font-mono text-xs text-faint">
              {database.username}@{database.host}:{database.port}/{database.databaseName}
              {database.sslEnabled ? ' · TLS' : ' · no TLS'}
            </p>

            <p className="text-sm text-muted">
              {database.project.name}
              {version ? ` · PostgreSQL ${version}` : ''}
              {database.lastCheckedAt ? ` · checked ${formatAgo(database.lastCheckedAt, now)}` : ''}
            </p>
          </div>

          {canManage ? (
            <DatabaseControls
              organizationId={organizationId}
              databaseId={databaseId}
              status={database.status}
            />
          ) : null}
        </div>

        <p className="max-w-[80ch] text-sm text-muted">{assessment.headline}</p>
      </header>

      {metrics.length === 0 ? (
        <Notice tone="empty" title="No metrics have been collected yet">
          This database is registered, and the last connection check
          {database.lastCheckStatus ? ` reported "${database.lastCheckStatus}"` : ' has not run'}.
          Metrics appear once a collection runs:{' '}
          <code className="font-mono text-xs">npm run collect:db</code>, from cron or a scheduled
          task. Nothing is shown here until then, because a chart drawn from no data is a chart of
          nothing.
        </Notice>
      ) : null}

      {assessment.findings.some((finding) => finding.level !== 'healthy') ? (
        <section className="glass rounded-(--radius-core)">
          <h2 className="border-b border-hairline px-5 py-4 text-sm font-medium">Assessment</h2>
          <ul className="divide-y divide-hairline">
            {assessment.findings
              .filter((finding) => finding.level !== 'healthy')
              .map((finding) => (
                <li key={finding.metric} className="flex gap-3 px-5 py-3">
                  <span className="mt-1">
                    <HealthDot level={finding.level} title={finding.label} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{finding.label}</p>
                    <p className="text-xs leading-snug text-muted">{finding.message}</p>
                    {finding.rule && finding.level !== 'unknown' ? (
                      <p className="mt-1 text-[11px] leading-snug text-faint">
                        {finding.rule.rationale}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <MetricGroup
        title="Overview"
        metrics={metrics}
        rows={[
          { path: 'resources.databaseSizeBytes', label: 'Database size', format: bytes },
          { path: 'resources.storageGrowthBytesPerDay', label: 'Growth per day', format: bytes },
          {
            path: 'postgres.transactionsPerSecond',
            label: 'Transactions',
            format: (value) => `${value.toFixed(1)}/s`,
          },
          {
            path: 'postgres.cacheHitRatioInterval',
            label: 'Cache hit ratio',
            format: (value) => `${value.toFixed(1)}%`,
          },
          { path: 'resources.cpuPercent', label: 'CPU', format: (value) => `${value.toFixed(0)}%` },
          {
            path: 'resources.memoryPercent',
            label: 'Memory',
            format: (value) => `${value.toFixed(0)}%`,
          },
          { path: 'resources.diskFreeBytes', label: 'Disk free', format: bytes },
          { path: 'health.uptimeSeconds', label: 'Uptime', format: formatUptime },
        ]}
      />

      <MetricGroup
        title="Connections"
        metrics={metrics}
        rows={[
          { path: 'connections.current', label: 'Current', format: formatWhole },
          { path: 'connections.max', label: 'Maximum', format: formatWhole },
          {
            path: 'connections.utilizationPercent',
            label: 'Utilization',
            format: (value) => `${value.toFixed(1)}%`,
          },
          { path: 'connections.active', label: 'Active', format: formatWhole },
          { path: 'connections.idle', label: 'Idle', format: formatWhole },
          {
            path: 'connections.idleInTransaction',
            label: 'Idle in transaction',
            format: formatWhole,
          },
          { path: 'connections.onThisDatabase', label: 'On this database', format: formatWhole },
          { path: 'connections.reservedForSuperusers', label: 'Reserved', format: formatWhole },
        ]}
      />

      <MetricGroup
        title="Queries"
        metrics={metrics}
        rows={[
          { path: 'queries.active', label: 'Active', format: formatWhole },
          { path: 'queries.slow', label: 'Slow', format: formatWhole },
          { path: 'queries.longRunning', label: 'Long running', format: formatWhole },
          {
            path: 'queries.longestRunningSeconds',
            label: 'Longest',
            format: (value) => `${value.toFixed(1)} s`,
          },
          { path: 'queries.blocked', label: 'Blocked', format: formatWhole },
          { path: 'queries.waitingLocks', label: 'Waiting locks', format: formatWhole },
          { path: 'queries.deadlocksInInterval', label: 'Deadlocks', format: formatWhole },
          { path: 'queries.rollbacksInInterval', label: 'Rollbacks', format: formatWhole },
        ]}
      />

      {histories.size > 0 ? (
        <section className="glass rounded-(--radius-core) p-5 sm:p-6">
          <h2 className="mb-5 text-sm font-medium">Last {WINDOW_HOURS} hours</h2>
          <div className="grid gap-6 sm:grid-cols-2">
            <History
              title="Response time"
              points={toPoints(histories.get('health.responseTimeMs'))}
              format={(value) => `${Math.round(value)} ms`}
            />
            <History
              title="Connections"
              points={toPoints(histories.get('connections.current'))}
              format={(value) => String(Math.round(value))}
            />
            <History
              title="Connection utilization"
              points={toPoints(histories.get('connections.utilizationPercent'))}
              format={(value) => `${value.toFixed(1)}%`}
            />
            <History
              title="Transactions per second"
              points={toPoints(histories.get('postgres.transactionsPerSecond'))}
              format={(value) => value.toFixed(1)}
            />
          </div>
        </section>
      ) : null}

      {runs.length > 0 ? (
        <section className="glass rounded-(--radius-core)">
          <h2 className="border-b border-hairline px-5 py-4 text-sm font-medium">
            Recent collections
          </h2>
          <ul className="divide-y divide-hairline">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-col gap-1 px-5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-xs">
                    <span className="font-medium">{run.outcome}</span>
                    <span className="text-faint"> · {run.status}</span>
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-faint">
                    {run.responseTimeMs !== null ? `${Math.round(run.responseTimeMs)} ms · ` : ''}
                    {Math.round(Number(run.metricsStored))} metrics ·{' '}
                    {formatAgo(run.startedAt, now)}
                  </span>
                </div>
                {run.error ? (
                  <p className="break-words text-xs leading-snug text-[var(--critical)]">
                    {run.error}
                  </p>
                ) : null}
                {run.notes?.length ? (
                  <p className="break-words text-[11px] leading-snug text-faint">{run.notes[0]}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {database.lastCheckStatus === 'unhealthy' && database.lastCheckDetail ? (
        <InlineNotice tone="problem">{database.lastCheckDetail}</InlineNotice>
      ) : null}
    </div>
  );
}

/** `formatBytes` accepts null for the dashboard's cards; here the value exists. */
function bytes(value: number): string {
  return formatBytes(value) ?? '';
}

function formatWhole(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;

  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;

  return `${Math.round(seconds / 60)} minutes`;
}

function toPoints(points: { timestamp: Date; value: number | null }[] | undefined): TrendPoint[] {
  return (points ?? []).map((point) => ({
    label: point.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    value: point.value,
  }));
}

function History({
  title,
  points,
  format,
}: {
  title: string;
  points: TrendPoint[];
  format: (value: number) => string;
}) {
  if (points.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">{title}</h3>
        <p className="text-xs text-faint">Not collected in this window.</p>
      </div>
    );
  }

  if (points.every((point) => point.value === null)) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">{title}</h3>
        <p className="text-xs text-faint">
          Collected {points.length} time{points.length === 1 ? '' : 's'}, never readable.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted">{title}</h3>
      <TrendChart points={points} format={format} height={56} title={title} />
    </div>
  );
}

/** A group of related readings, each showing its value or its reason. */
function MetricGroup({
  title,
  metrics,
  rows,
}: {
  title: string;
  metrics: MetricSummary[];
  rows: { path: string; label: string; format: (value: number) => string }[];
}) {
  const found = rows
    .map((row) => ({ row, summary: metrics.find((entry) => entry.metric === row.path) }))
    .filter((entry) => entry.summary !== undefined);

  if (found.length === 0) return null;

  return (
    <section className="glass rounded-(--radius-core) p-5 sm:p-6">
      <h2 className="mb-5 text-sm font-medium">{title}</h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
        {found.map(({ row, summary }) => (
          <Metric
            key={row.path}
            label={row.label}
            value={summary?.latest !== null && summary ? row.format(summary.latest) : null}
            reason={summary?.latestDetail ?? null}
            note={
              summary?.latest !== null &&
              summary &&
              summary.min !== null &&
              summary.max !== null &&
              summary.min !== summary.max
                ? `${row.format(summary.min)} to ${row.format(summary.max)} over ${WINDOW_HOURS}h`
                : undefined
            }
          />
        ))}
      </div>
    </section>
  );
}
