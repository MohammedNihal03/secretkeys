import Link from 'next/link';

import { HealthPill } from '@/components/health-pill';
import { formatAgo } from '@/components/metric';
import { Notice } from '@/components/notice';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { encryptionConfigurationError } from '@/lib/credentials/crypto';
import { listMonitoredDatabases } from '@/lib/databases/repository';
import { latestMetricsByDatabase } from '@/lib/databases/storage';
import { assessStoredMetrics } from '@/lib/evaluation/database';
import { ENVIRONMENT_LABELS } from '@/lib/projects/schema';

/**
 * Registered databases.
 *
 * Each row shows what the last collection found, not what was configured. A
 * database that has never been collected from says exactly that, because
 * "registered" and "being monitored" are not the same thing and confusing them
 * is how a database goes unwatched for a week.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Databases' };

const PRIMARY_LINK =
  'rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98]';

export default async function DatabasesPage({
  params,
}: PageProps<'/organizations/[organizationId]/databases'>) {
  const { organizationId } = await params;
  const access = await requireOrgAccess(organizationId);

  const base = `/organizations/${organizationId}`;
  const canManage = hasPermission(access.role, 'databases:manage');
  const configurationError = encryptionConfigurationError();
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [databases, metricsByDatabase] = await Promise.all([
    listMonitoredDatabases(organizationId),
    latestMetricsByDatabase(organizationId, since),
  ]);

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Databases</h1>
          <p className="max-w-[65ch] text-sm text-muted">
            PostgreSQL databases this organization monitors. Each is reached over its own
            short-lived, read-only connection, never the dashboard&rsquo;s own pool.
          </p>
        </div>

        {canManage && !configurationError ? (
          <Link href={`${base}/databases/new`} className={PRIMARY_LINK}>
            Add a database
          </Link>
        ) : null}
      </header>

      {configurationError ? (
        <Notice tone="problem" title="Encryption is not configured">
          {configurationError}
        </Notice>
      ) : null}

      {databases.length === 0 ? (
        <Notice
          tone="empty"
          title="No database is registered yet"
          action={
            canManage && !configurationError ? (
              <Link href={`${base}/databases/new`} className={PRIMARY_LINK}>
                Add a database
              </Link>
            ) : undefined
          }
        >
          Register a database with a least-privilege monitoring role and the collector will report
          its availability, connections, query activity, cache behaviour and size. It needs only
          <code className="mx-1 font-mono text-xs">pg_monitor</code>, never a superuser.
        </Notice>
      ) : (
        <ul className="glass divide-y divide-hairline overflow-hidden rounded-(--radius-core)">
          {databases.map((database) => {
            const metrics = metricsByDatabase.get(database.id) ?? [];
            const assessment = assessStoredMetrics(database.name, metrics, {
              reachable: database.lastCheckStatus === 'unhealthy' ? false : undefined,
              error: database.lastCheckDetail,
            });

            return (
              <li key={database.id}>
                <Link
                  href={`${base}/databases/${database.id}`}
                  className="flex flex-col gap-3 px-5 py-4 transition-colors duration-300 hover:bg-shell sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="truncate text-sm font-medium">{database.name}</span>
                      <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
                        {ENVIRONMENT_LABELS[database.environment]}
                      </span>
                      {database.status !== 'active' ? (
                        <span className="shrink-0 text-[11px] text-faint">Not collected</span>
                      ) : null}
                    </div>
                    <p className="truncate font-mono text-xs text-faint">
                      {database.username}@{database.host}:{database.port}/{database.databaseName}
                    </p>
                    <p className="text-xs text-muted">{database.project.name}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-4">
                    <span className="text-right text-[11px] text-faint">
                      {database.lastCheckedAt
                        ? `Checked ${formatAgo(database.lastCheckedAt, now)}`
                        : 'Never checked'}
                    </span>
                    <HealthPill level={assessment.level} size="sm" />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
