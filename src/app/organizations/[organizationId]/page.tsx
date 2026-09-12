import Link from 'next/link';

import { HealthDot, HealthPill } from '@/components/health-pill';
import {
  Metric,
  formatAgo,
  formatBytes,
  formatCount,
  formatMs,
  formatUsd,
} from '@/components/metric';
import { Notice } from '@/components/notice';
import { BarChart, DonutChart, LineChart, type ChartPoint } from '@/components/charts';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { loadDashboardOverview, type DashboardOverview } from '@/lib/dashboard/overview';
import { buildDailySeries } from '@/lib/dashboard/series';
import { LEVEL_LABELS } from '@/lib/evaluation/engine';

/**
 * The organization dashboard.
 *
 * It answers one question: is everything healthy. Every number on it was
 * written by a collector; there is no sample data, and nothing is shown as zero
 * because a figure was missing. Where a provider cannot report something, the
 * card says so in the space the number would have occupied.
 *
 * One data call, in `loadDashboardOverview`, so the page makes a fixed number
 * of queries no matter how many panels render.
 */

export const dynamic = 'force-dynamic';

const HEADLINE: Record<string, string> = {
  healthy: 'Everything is healthy.',
  warning: 'Something needs attention.',
  critical: 'Something is broken.',
  unknown: 'Not everything can be seen.',
};

export default async function OrganizationDashboard({
  params,
}: PageProps<'/organizations/[organizationId]'>) {
  const { organizationId } = await params;
  const access = await requireOrgAccess(organizationId);
  const overview = await loadDashboardOverview(organizationId);

  const base = `/organizations/${organizationId}`;
  const canManage = hasPermission(access.role, 'providers:manage');
  const now = new Date();

  const nothingConfigured = overview.setup.apiKeys === 0 && overview.setup.databases === 0;

  return (
    <div className="animate-rise flex flex-col gap-8">
      <StatusHeader overview={overview} now={now} />

      {nothingConfigured ? (
        <Notice
          tone="empty"
          title="Nothing is being monitored yet"
          action={
            canManage ? (
              <div className="flex flex-wrap gap-2">
                <Link href={`${base}/keys/new`} className={PRIMARY_BUTTON}>
                  Register an API key
                </Link>
                <Link href={`${base}/databases/new`} className={SECONDARY_BUTTON}>
                  Add a database
                </Link>
              </div>
            ) : undefined
          }
        >
          This dashboard reads from two collectors. Register a provider credential and it will start
          reporting usage, cost and limits; add a PostgreSQL database and it will start reporting
          connections, queries and cache behaviour. Until one of those exists there is genuinely
          nothing to show, and inventing a number here would make the whole page untrustworthy.
        </Notice>
      ) : (
        <>
          <UsageSummary overview={overview} />
          <Composition overview={overview} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <AiPanel overview={overview} base={base} canManage={canManage} />
            <DatabasePanelList overview={overview} base={base} canManage={canManage} now={now} />
          </div>
          <Attention overview={overview} now={now} />
        </>
      )}
    </div>
  );
}

const PRIMARY_BUTTON =
  'rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98]';

const SECONDARY_BUTTON =
  'rounded-full border border-hairline bg-shell px-4 py-2 text-sm font-medium text-muted transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground active:scale-[0.98]';

/** The answer to "is everything healthy", before any detail. */
function StatusHeader({ overview, now }: { overview: DashboardOverview; now: Date }) {
  const collectedAt = [overview.ai.lastCollectedAt, overview.databases.lastCheckedAt]
    .filter((at): at is Date => at !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{HEADLINE[overview.level]}</h1>
        <HealthPill level={overview.level} />
      </div>

      <p className="max-w-[70ch] text-sm text-muted">
        {overview.level === 'unknown'
          ? 'Some of what this organization tracks cannot be read. Each panel below says which part, and why.'
          : `Across ${overview.setup.apiKeys} credential${
              overview.setup.apiKeys === 1 ? '' : 's'
            } and ${overview.setup.databases} database${
              overview.setup.databases === 1 ? '' : 's'
            }, over the last ${overview.window.days} days.`}
        {collectedAt ? ` Last collection ${formatAgo(collectedAt, now)}.` : ''}
      </p>
    </header>
  );
}

/**
 * The organization's totals.
 *
 * Hairline-separated rather than four cards: at this density, boxes add borders
 * without adding hierarchy, and the numbers are what the eye should land on.
 */
function UsageSummary({ overview }: { overview: DashboardOverview }) {
  const { totals, series } = overview.ai;

  const points: ChartPoint[] = buildDailySeries(
    overview.ai.series,
    overview.window.from,
    overview.window.days
  );

  const costNote =
    totals.costIntervals > 0 && totals.costIntervals < totals.intervals
      ? `${totals.costIntervals} of ${totals.intervals} intervals reported cost`
      : 'as reported by the providers';

  return (
    <section className="glass rounded-(--radius-core) p-5 sm:p-6">
      <div className="grid gap-6 divide-hairline sm:grid-cols-2 lg:grid-cols-4 lg:divide-x">
        <div className="lg:pr-6">
          <Metric
            label="Requests"
            size="lg"
            value={formatCount(totals.requests)}
            reason={
              overview.ai.collected
                ? 'No tracked provider reports a request count.'
                : 'No collection has run yet.'
            }
            note={`over ${overview.window.days} days`}
          />
        </div>
        <div className="lg:px-6">
          <Metric
            label="Tokens"
            size="lg"
            value={formatCount(totals.totalTokens)}
            reason={
              overview.ai.collected
                ? 'No tracked provider reports token usage.'
                : 'No collection has run yet.'
            }
            note="input plus output"
          />
        </div>
        <div className="lg:px-6">
          <Metric
            label="Estimated cost"
            size="lg"
            value={formatUsd(totals.estimatedCost)}
            reason={
              overview.ai.collected
                ? 'No tracked provider reports cost. It is never derived from a price list here.'
                : 'No collection has run yet.'
            }
            note={costNote}
          />
        </div>
        <div className="lg:pl-6">
          <Metric
            label="Connections"
            size="lg"
            value={formatCount(sumConnections(overview))}
            reason={
              overview.databases.collected
                ? 'No database reported a connection count.'
                : 'No database has been collected from yet.'
            }
            note={`across ${overview.setup.databases} database${
              overview.setup.databases === 1 ? '' : 's'
            }`}
          />
        </div>
      </div>

      <div className="mt-6 border-t border-hairline pt-5">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">AI requests per day</h2>
          <span className="text-[11px] text-faint">
            {series.length > 0
              ? `${series.length} interval${series.length === 1 ? '' : 's'} stored`
              : `last ${overview.window.days} days`}
          </span>
        </div>

        {/*
          The chart is drawn even with nothing in it. An empty strip of "not
          collected" markers says the collector has not run; a section that
          disappears says nothing at all, and looks like a missing feature.
        */}
        {/* Bars, not a line: each one is a day's accumulated count, and a line
            would imply a value between them that was never measured. */}
        <BarChart
          points={points}
          format={(value) => value.toLocaleString('en-US')}
          title="AI requests per day"
        />

        {series.length === 0 ? (
          <p className="mt-2 text-[11px] leading-snug text-faint">
            {overview.setup.apiKeys === 0
              ? 'No API key is registered, so no usage has been collected.'
              : 'No usage has been stored for this window yet. Several providers expose no usage API at all; each provider page says which.'}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function sumConnections(overview: DashboardOverview): number | null {
  const readings = overview.databases.items
    .map((item) => item.connections)
    .filter((value): value is number => value !== null);

  return readings.length > 0 ? readings.reduce((total, value) => total + value, 0) : null;
}

/**
 * How the organization's consumption divides between providers.
 *
 * Ranked by cost where any provider reports it, and by tokens or requests when
 * none does. Providers that report nothing at all become the donut's `unknown`
 * slice rather than being dropped: a composition chart that quietly omits what
 * it cannot account for claims to show the whole.
 */
function Composition({ overview }: { overview: DashboardOverview }) {
  const providers = overview.ai.providers;
  if (providers.length === 0) return null;

  const basis: 'cost' | 'tokens' | 'requests' | null = providers.some(
    (provider) => provider.estimatedCost !== null
  )
    ? 'cost'
    : providers.some((provider) => provider.totalTokens !== null)
      ? 'tokens'
      : providers.some((provider) => provider.requests !== null)
        ? 'requests'
        : null;

  const readOf = (provider: (typeof providers)[number]) =>
    basis === 'cost'
      ? provider.estimatedCost
      : basis === 'tokens'
        ? provider.totalTokens
        : basis === 'requests'
          ? provider.requests
          : null;

  const slices = providers
    .map((provider) => ({ label: provider.name, value: readOf(provider) ?? 0 }))
    .filter((slice) => slice.value > 0);

  const silent = providers.filter((provider) => readOf(provider) === null).length;

  const format =
    basis === 'cost'
      ? (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`
      : (value: number) => value.toLocaleString('en-US');

  const heading =
    basis === 'cost'
      ? 'Cost by provider'
      : basis === 'tokens'
        ? 'Tokens by provider'
        : basis === 'requests'
          ? 'Requests by provider'
          : 'Usage by provider';

  return (
    <section className="glass rounded-(--radius-core) p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{heading}</h2>
        <span className="text-[11px] text-faint">last {overview.window.days} days</span>
      </div>

      <DonutChart
        slices={slices}
        title={heading}
        format={format}
        centerLabel={
          slices.length > 0 ? format(slices.reduce((total, slice) => total + slice.value, 0)) : '–'
        }
        centerNote={basis ?? 'no data'}
      />

      {/*
        Providers that report nothing are named, not sized. The donut has no
        slice for them because their share is genuinely unknown, and inventing
        a magnitude to fill the ring would be the one thing this project does
        not do.
      */}
      {silent > 0 ? (
        <p className="mt-4 border-t border-hairline pt-4 text-[11px] leading-snug text-faint">
          {silent} of {providers.length} tracked provider{providers.length === 1 ? '' : 's'} report
          no {basis ?? 'usage'} at all, so their share of this total is unknown and no slice is
          drawn for it. Each provider page says which figures it can expose.
        </p>
      ) : null}
    </section>
  );
}

function AiPanel({
  overview,
  base,
  canManage,
}: {
  overview: DashboardOverview;
  base: string;
  canManage: boolean;
}) {
  return (
    <section className="glass flex flex-col rounded-(--radius-core)">
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-medium">AI providers</h2>
          <HealthPill level={overview.ai.level} size="sm" />
        </div>
        <Link
          href={`${base}/keys`}
          className="text-xs text-muted transition-colors hover:text-foreground"
        >
          API keys
        </Link>
      </div>

      {overview.ai.providers.length === 0 ? (
        <div className="p-5">
          <Notice
            tone="empty"
            title="No provider is being collected from"
            action={
              canManage ? (
                <Link href={`${base}/keys/new`} className={SECONDARY_BUTTON}>
                  Register a key
                </Link>
              ) : undefined
            }
          >
            A provider appears here once this organization tracks it and holds a credential for it.
            Choose providers on the Providers page, then register a key against a project.
          </Notice>
        </div>
      ) : (
        <ul className="divide-y divide-hairline">
          {overview.ai.providers.map((provider) => (
            <li key={provider.providerId} className="flex flex-col gap-2.5 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <HealthDot level={provider.level} title={provider.name} />
                  <span className="truncate text-sm font-medium">{provider.name}</span>
                  <span className="shrink-0 text-[11px] text-faint">
                    {provider.keyCount} key{provider.keyCount === 1 ? '' : 's'}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                  {formatMs(provider.latencyMs) ?? '–'}
                </span>
              </div>

              <p className="text-xs leading-snug text-muted">{provider.headline}</p>

              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <Metric
                  label="Requests"
                  size="sm"
                  value={formatCount(provider.requests)}
                  reason="Not reported"
                />
                <Metric
                  label="Tokens"
                  size="sm"
                  value={formatCount(provider.totalTokens)}
                  reason="Not reported"
                />
                <Metric
                  label="Cost"
                  size="sm"
                  value={formatUsd(provider.estimatedCost)}
                  reason="Not reported"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DatabasePanelList({
  overview,
  base,
  canManage,
  now,
}: {
  overview: DashboardOverview;
  base: string;
  canManage: boolean;
  now: Date;
}) {
  return (
    <section className="glass flex flex-col rounded-(--radius-core)">
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-medium">Databases</h2>
          {overview.databases.items.length > 0 ? (
            <HealthPill level={overview.databases.level} size="sm" />
          ) : null}
        </div>
        <Link
          href={`${base}/databases`}
          className="text-xs text-muted transition-colors hover:text-foreground"
        >
          All databases
        </Link>
      </div>

      {overview.databases.items.length === 0 ? (
        <div className="p-5">
          <Notice
            tone="empty"
            title="No database is registered"
            action={
              canManage ? (
                <Link href={`${base}/databases/new`} className={SECONDARY_BUTTON}>
                  Add a database
                </Link>
              ) : undefined
            }
          >
            Register a PostgreSQL database with a least-privilege monitoring role and the collector
            will report its connections, queries, cache behaviour and size. It connects over its own
            short-lived, read-only session.
          </Notice>
        </div>
      ) : (
        <ul className="divide-y divide-hairline">
          {overview.databases.items.map((item) => (
            <li key={item.databaseId} className="flex flex-col gap-2.5 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <HealthDot level={item.assessment.level} title={item.name} />
                  <Link
                    href={`${base}/databases/${item.databaseId}`}
                    className="truncate text-sm font-medium transition-colors hover:text-accent"
                  >
                    {item.name}
                  </Link>
                  <span className="shrink-0 text-[11px] uppercase tracking-[0.12em] text-faint">
                    {item.environment}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                  {formatMs(item.responseTimeMs) ?? '–'}
                </span>
              </div>

              <p className="text-xs leading-snug text-muted">{item.assessment.headline}</p>

              {/* A level sampled over time, so a line. */}
              {item.history.length > 1 ? (
                <LineChart
                  points={item.history.map((point) => ({
                    label: point.timestamp.toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                    value: point.value,
                  }))}
                  format={(value) => `${Math.round(value)} ms`}
                  height={34}
                  bare
                  title={`${item.name} response time`}
                />
              ) : null}

              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <Metric
                  label="Connections"
                  size="sm"
                  value={formatCount(item.connections)}
                  reason="Not collected"
                  note={
                    item.connectionUtilization !== null
                      ? `${item.connectionUtilization}% of max`
                      : undefined
                  }
                />
                <Metric
                  label="Size"
                  size="sm"
                  value={formatBytes(item.sizeBytes)}
                  reason="Not collected"
                />
                <Metric
                  label="Checked"
                  size="sm"
                  value={formatAgo(item.lastCheckedAt, now)}
                  reason="Never"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What is wrong now, and what broke recently. */
function Attention({ overview, now }: { overview: DashboardOverview; now: Date }) {
  if (overview.attention.length === 0 && overview.recentErrors.length === 0) {
    return (
      <section className="rounded-(--radius-core) border border-hairline px-5 py-4">
        <p className="text-sm text-muted">
          Nothing is above a warning threshold, and no collection has failed recently.
        </p>
      </section>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {overview.attention.length > 0 ? (
        <section className="glass rounded-(--radius-core)">
          <h2 className="border-b border-hairline px-5 py-4 text-sm font-medium">
            Active warnings
          </h2>
          <ul className="divide-y divide-hairline">
            {overview.attention.slice(0, 6).map((item, index) => (
              <li key={`${item.source}-${index}`} className="flex gap-3 px-5 py-3">
                <HealthDot level={item.level} title={LEVEL_LABELS[item.level]} />
                <div className="min-w-0">
                  <p className="text-xs font-medium">{item.source}</p>
                  <p className="text-xs leading-snug text-muted">{item.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {overview.recentErrors.length > 0 ? (
        <section className="glass rounded-(--radius-core)">
          <h2 className="border-b border-hairline px-5 py-4 text-sm font-medium">Recent errors</h2>
          <ul className="divide-y divide-hairline">
            {overview.recentErrors.map((error, index) => (
              <li key={`${error.source}-${index}`} className="flex flex-col gap-1 px-5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs font-medium">{error.source}</span>
                  <span className="shrink-0 text-[11px] text-faint">
                    {formatAgo(error.at, now)}
                  </span>
                </div>
                <p className="break-words text-xs leading-snug text-muted">{error.message}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
