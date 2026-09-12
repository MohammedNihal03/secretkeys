import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CredentialStatusBadge } from '@/components/credential-status';
import { HealthPill } from '@/components/health-pill';
import { Metric, formatBytes, formatCount, formatUsd } from '@/components/metric';
import { InlineNotice, Notice } from '@/components/notice';
import { BarChart, DonutChart } from '@/components/charts';
import { UsageTotalsGrid } from '@/components/usage-totals';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { maskedKey } from '@/lib/credentials/mask';
import { listApiKeys } from '@/lib/credentials/repository';
import { describeCredentialStatus } from '@/lib/credentials/status';
import { loadProjectAnalytics, type ProjectAnalytics } from '@/lib/dashboard/analytics';
import { buildDailySeries } from '@/lib/dashboard/series';
import { listMonitoredDatabases } from '@/lib/databases/repository';
import { latestMetricsByDatabase } from '@/lib/databases/storage';
import { assessStoredMetrics } from '@/lib/evaluation/database';
import { getProject } from '@/lib/projects/repository';
import { ENVIRONMENT_LABELS } from '@/lib/projects/schema';

/**
 * One project, with everything attributed to it.
 *
 * This is the page the cost question is answered on: a project is what usage is
 * attributed to, so grouping its usage by provider and by key is what turns
 * "the organization spent this much" into "this part of it was us, on that
 * credential".
 */

export const dynamic = 'force-dynamic';

/** How far back the usage panels look. */
const WINDOW_DAYS = 7;

export default async function ProjectDetailPage({
  params,
}: PageProps<'/organizations/[organizationId]/projects/[projectId]'>) {
  const { organizationId, projectId } = await params;
  const access = await requireOrgAccess(organizationId);

  // Scoped by organization, so another tenant's project id resolves to null.
  const project = await getProject(organizationId, projectId);
  if (!project) notFound();

  const now = new Date();
  const window = { from: new Date(now.getTime() - WINDOW_DAYS * 86_400_000), to: now };

  const [keys, analytics, databases, metricsByDatabase] = await Promise.all([
    listApiKeys(organizationId, { projectId: project.id }),
    loadProjectAnalytics(organizationId, project.id, window),
    listMonitoredDatabases(organizationId, { projectId: project.id }),
    latestMetricsByDatabase(organizationId, window.from),
  ]);

  const canManageKeys = hasPermission(access.role, 'api_keys:manage');
  const canManageDatabases = hasPermission(access.role, 'databases:manage');
  const canManage = hasPermission(access.role, 'projects:manage');
  const base = `/organizations/${organizationId}/projects`;

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link href={base} className="w-fit text-xs text-faint transition-colors hover:text-muted">
          ← Projects
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
            {project.description ? (
              <p className="max-w-prose text-sm text-muted">{project.description}</p>
            ) : null}
          </div>

          {canManage ? (
            <Link
              href={`${base}/${project.id}/edit`}
              className="rounded-full border border-hairline bg-shell px-4 py-2 text-sm font-medium text-muted transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground active:scale-[0.97]"
            >
              Edit
            </Link>
          ) : null}
        </div>
      </header>

      <ProjectUsage analytics={analytics} window={window} />

      <div className="bezel rounded-shell p-1.5">
        <dl className="glass rounded-core divide-y divide-hairline">
          <Row label="Environment">{ENVIRONMENT_LABELS[project.environment]}</Row>
          <Row label="API keys">
            <span className="font-mono tabular-nums">{project.apiKeyCount}</span>
          </Row>
          <Row label="Monitored databases">
            <span className="font-mono tabular-nums">{project.databaseCount}</span>
          </Row>
          <Row label="Created">
            <time dateTime={project.createdAt.toISOString()} className="font-mono text-xs">
              {project.createdAt.toISOString().slice(0, 10)}
            </time>
          </Row>
        </dl>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-faint">API keys</h2>
          {canManageKeys ? (
            <Link
              href={`/organizations/${organizationId}/keys/new?projectId=${project.id}`}
              className="text-sm text-muted underline underline-offset-4 hover:text-foreground"
            >
              Register a key
            </Link>
          ) : null}
        </div>

        {keys.length === 0 ? (
          <InlineNotice tone="empty">
            No keys are registered against this project yet
            {canManageKeys ? '.' : ' — an organization admin can add them.'}
          </InlineNotice>
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((key) => (
              <li key={key.id}>
                <Link
                  href={`/organizations/${organizationId}/keys/${key.id}`}
                  className="bezel rounded-shell block p-1.5 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5"
                >
                  <div className="glass rounded-core flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{key.keyName}</span>
                      <span className="font-mono text-xs text-muted">
                        {key.provider.name} · {maskedKey(key.keyLast4)} ·{' '}
                        {ENVIRONMENT_LABELS[key.environment]}
                      </span>
                    </span>
                    <CredentialStatusBadge
                      view={describeCredentialStatus(key.status, key.lastValidationOutcome)}
                    />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-faint">Databases</h2>
          {canManageDatabases ? (
            <Link
              href={`/organizations/${organizationId}/databases/new`}
              className="text-sm text-muted underline underline-offset-4 hover:text-foreground"
            >
              Add a database
            </Link>
          ) : null}
        </div>

        {databases.length === 0 ? (
          <InlineNotice tone="empty">
            No database is registered against this project yet
            {canManageDatabases ? '.' : ', and an organization admin can add one.'}
          </InlineNotice>
        ) : (
          <ul className="glass divide-y divide-hairline overflow-hidden rounded-(--radius-core)">
            {databases.map((database) => {
              const metrics = metricsByDatabase.get(database.id) ?? [];
              const assessment = assessStoredMetrics(database.name, metrics, {
                reachable: database.lastCheckStatus === 'unhealthy' ? false : undefined,
                error: database.lastCheckDetail,
              });
              const size = metrics.find((entry) => entry.metric === 'resources.databaseSizeBytes');
              const connections = metrics.find((entry) => entry.metric === 'connections.current');

              return (
                <li key={database.id}>
                  <Link
                    href={`/organizations/${organizationId}/databases/${database.id}`}
                    className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5 transition-colors duration-300 hover:bg-shell"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{database.name}</span>
                      <span className="font-mono text-xs text-faint">
                        {database.host}:{database.port}/{database.databaseName}
                      </span>
                    </span>

                    <span className="flex items-center gap-5">
                      <Metric
                        label="Connections"
                        size="sm"
                        align="end"
                        value={formatCount(connections?.latest ?? null)}
                        reason="Not collected"
                      />
                      <Metric
                        label="Size"
                        size="sm"
                        align="end"
                        value={formatBytes(size?.latest ?? null)}
                        reason="Not collected"
                      />
                      <HealthPill level={assessment.level} size="sm" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * What this project consumed, split by provider and by key.
 *
 * The split is the point. An organization total says how much was spent; only
 * the split says which credential to change to spend less, and it is the reason
 * a key is bound to a project at registration rather than inferred later.
 */
function ProjectUsage({
  analytics,
  window,
}: {
  analytics: ProjectAnalytics;
  window: { from: Date; to: Date };
}) {
  const { totals, byProvider, byKey } = analytics;
  const collected = totals.intervals > 0;

  return (
    <section className="glass flex flex-col rounded-(--radius-core)">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline px-5 py-4">
        <h2 className="text-sm font-medium">Usage, last {WINDOW_DAYS} days</h2>
        <span className="text-[11px] text-faint">
          {collected
            ? `${totals.intervals} interval${totals.intervals === 1 ? '' : 's'} stored`
            : 'Nothing stored for this window'}
        </span>
      </div>

      <div className="p-5 sm:p-6">
        <UsageTotalsGrid
          totals={totals}
          subject="The providers this project uses"
          collected={collected}
        />

        {collected && totals.requests !== null ? (
          <div className="mt-6 border-t border-hairline pt-5">
            <h3 className="mb-3 text-xs font-medium text-muted">Requests per day</h3>
            <BarChart
              points={buildDailySeries(analytics.series, window.from, WINDOW_DAYS)}
              format={(value) => value.toLocaleString('en-US')}
              title="Project requests per day"
            />
          </div>
        ) : null}
      </div>

      {collected &&
      byProvider.some((row) => row.estimatedCost !== null || row.requests !== null) ? (
        <div className="border-t border-hairline p-5 sm:p-6">
          <h3 className="mb-5 text-xs font-medium uppercase tracking-[0.14em] text-faint">
            {byProvider.some((row) => row.estimatedCost !== null)
              ? 'Cost by provider'
              : 'Requests by provider'}
          </h3>
          <DonutChart
            slices={byProvider
              .map((row) => ({
                label: row.name,
                value:
                  (byProvider.some((entry) => entry.estimatedCost !== null)
                    ? row.estimatedCost
                    : row.requests) ?? 0,
              }))
              .filter((slice) => slice.value > 0)}
            title="Usage by provider"
            format={
              byProvider.some((row) => row.estimatedCost !== null)
                ? (value) => `$${value.toFixed(value < 1 ? 4 : 2)}`
                : (value) => value.toLocaleString('en-US')
            }
          />
        </div>
      ) : null}

      {collected ? (
        <div className="grid gap-px border-t border-hairline bg-hairline sm:grid-cols-2">
          <Breakdown title="By provider" rows={byProvider} />
          <Breakdown
            title="By key"
            rows={byKey.map((row) => ({ ...row, name: `${row.name} · ${row.providerName}` }))}
          />
        </div>
      ) : (
        <div className="border-t border-hairline p-5">
          <Notice tone="limited" title="No usage has been stored for this project yet">
            Usage appears once a collection returns rows that name one of this project&rsquo;s keys.
            Several providers expose no usage API at all, in which case this stays empty however
            long the collector runs, and each provider page says which.
          </Notice>
        </div>
      )}
    </section>
  );
}

interface BreakdownRow {
  id: string;
  name: string;
  requests: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
}

function Breakdown({ title, rows }: { title: string; rows: BreakdownRow[] }) {
  return (
    <div className="bg-background/40 p-5">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-faint">{title}</h3>

      {rows.length === 0 ? (
        <p className="text-xs text-faint">Nothing attributed.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-4">
              <span className="min-w-0 truncate text-sm">{row.name}</span>
              <span className="flex shrink-0 gap-5">
                <Metric
                  label="Requests"
                  size="sm"
                  align="end"
                  value={formatCount(row.requests)}
                  reason="Not reported"
                />
                <Metric
                  label="Tokens"
                  size="sm"
                  align="end"
                  value={formatCount(row.totalTokens)}
                  reason="Not reported"
                />
                <Metric
                  label="Cost"
                  size="sm"
                  align="end"
                  value={formatUsd(row.estimatedCost)}
                  reason="Not reported"
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
