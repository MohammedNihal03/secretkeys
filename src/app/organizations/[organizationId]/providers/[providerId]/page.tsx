import Link from 'next/link';
import { notFound } from 'next/navigation';

import { HealthDot, HealthPill } from '@/components/health-pill';
import { Metric, formatAgo, formatCount, formatMs, formatUsd } from '@/components/metric';
import { Notice } from '@/components/notice';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { UsageTotalsGrid } from '@/components/usage-totals';
import { requireOrgAccess } from '@/lib/auth/guards';
import { loadProviderAnalytics } from '@/lib/dashboard/analytics';
import { buildDailySeries } from '@/lib/dashboard/series';
import { ENVIRONMENT_LABELS, type Environment } from '@/lib/projects/schema';
import { getAdapter } from '@/lib/providers/registry';

/**
 * One AI provider, in detail.
 *
 * The build plan asks for health, requests, tokens, cost, errors, latency, rate
 * limits and keys. Several of those are unknowable for most providers, and the
 * capability table at the top of the page is why: it states what this provider
 * exposes before any number is shown, so an empty figure below reads as a
 * property of the provider rather than a failure of the collector.
 */

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

export async function generateMetadata({
  params,
}: PageProps<'/organizations/[organizationId]/providers/[providerId]'>) {
  const { organizationId, providerId } = await params;
  const analytics = await loadProviderAnalytics(organizationId, providerId, {
    from: new Date(Date.now() - 60_000),
    to: new Date(),
  }).catch(() => null);

  return { title: analytics?.provider.name ?? 'Provider' };
}

export default async function ProviderAnalyticsPage({
  params,
}: PageProps<'/organizations/[organizationId]/providers/[providerId]'>) {
  const { organizationId, providerId } = await params;
  await requireOrgAccess(organizationId);

  const now = new Date();
  const window = { from: new Date(now.getTime() - WINDOW_DAYS * 86_400_000), to: now };

  const analytics = await loadProviderAnalytics(organizationId, providerId, window);
  if (!analytics) notFound();

  const { provider, totals, series, collection, assessment, keys } = analytics;
  const adapter = getAdapter(provider.type as Parameters<typeof getAdapter>[0]);
  const base = `/organizations/${organizationId}`;

  const points: TrendPoint[] = buildDailySeries(series, window.from, WINDOW_DAYS);

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          href={`${base}/providers`}
          className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint transition-colors hover:text-muted"
        >
          Providers
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{provider.name}</h1>
          <HealthPill level={assessment.level} />
        </div>

        <p className="max-w-[80ch] text-sm text-muted">{assessment.headline}</p>
      </header>

      <section className="glass rounded-(--radius-core) p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Last {WINDOW_DAYS} days</h2>
          <span className="text-[11px] text-faint">
            {collection.lastCollectedAt
              ? `Last collected ${formatAgo(collection.lastCollectedAt, now)}`
              : 'Never collected'}
          </span>
        </div>

        <UsageTotalsGrid
          totals={totals}
          subject={provider.name}
          collected={collection.lastCollectedAt !== null}
        >
          <Metric
            label="Latency"
            value={formatMs(collection.latencyMs)}
            reason="No collection has measured a round trip."
            note="last probe"
          />
        </UsageTotalsGrid>

        {points.length > 0 && totals.requests !== null ? (
          <div className="mt-6 border-t border-hairline pt-5">
            <h3 className="mb-3 text-xs font-medium text-muted">Requests per day</h3>
            <TrendChart
              points={points}
              format={(value) => value.toLocaleString('en-US')}
              title={`${provider.name} requests per day`}
            />
          </div>
        ) : null}
      </section>

      <section className="glass rounded-(--radius-core) p-5 sm:p-6">
        <h2 className="mb-4 text-sm font-medium">What {provider.name} exposes</h2>

        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          <Capability
            label="Usage"
            value={
              adapter.capabilities.usage === 'none'
                ? 'Not exposed'
                : adapter.capabilities.usage === 'organization_admin'
                  ? 'Organization admin key'
                  : 'Per key'
            }
          />
          <Capability
            label="Cost"
            value={
              adapter.capabilities.cost === 'none'
                ? 'Not exposed'
                : adapter.capabilities.cost === 'organization_admin'
                  ? 'Organization admin key'
                  : 'Per key'
            }
          />
          <Capability
            label="Rate limits"
            value={
              adapter.capabilities.limits === 'none'
                ? 'Not exposed'
                : adapter.capabilities.limits === 'response_headers'
                  ? 'Response headers only'
                  : 'Dedicated endpoint'
            }
          />
        </dl>

        <p className="mt-4 max-w-[80ch] text-xs leading-relaxed text-muted">
          {adapter.capabilities.notes}
        </p>
      </section>

      {assessment.findings.length > 0 ? (
        <section className="glass rounded-(--radius-core)">
          <h2 className="border-b border-hairline px-5 py-4 text-sm font-medium">Assessment</h2>
          <ul className="divide-y divide-hairline">
            {assessment.findings.map((finding) => (
              <li key={finding.metric} className="flex gap-3 px-5 py-3">
                <span className="mt-1">
                  <HealthDot level={finding.level} title={finding.label} />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium">{finding.label}</p>
                  <p className="text-xs leading-snug text-muted">{finding.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="glass rounded-(--radius-core)">
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-4">
          <h2 className="text-sm font-medium">Keys</h2>
          <span className="text-[11px] text-faint">
            {collection.failures > 0
              ? `${collection.failures} of ${collection.runs} collections failed`
              : `${collection.runs} collection${collection.runs === 1 ? '' : 's'}`}
          </span>
        </div>

        {keys.length === 0 ? (
          <div className="p-5">
            <Notice tone="limited" title="No usage is attributed to a key yet">
              {adapter.capabilities.usage === 'none'
                ? `${provider.name} exposes no usage API, so there is nothing to attribute. Health and limits are still collected where available.`
                : `No stored usage names one of this organization's keys for this window. Usage appears here once a collection returns rows for a registered key.`}
            </Notice>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {keys.map((key) => (
              <li key={key.id}>
                <Link
                  href={`${base}/keys/${key.id}`}
                  className="flex flex-col gap-2 px-5 py-4 transition-colors duration-300 hover:bg-shell sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="truncate text-sm font-medium">{key.name}</span>
                      <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
                        {ENVIRONMENT_LABELS[key.environment as Environment]}
                      </span>
                    </div>
                    <span className="text-xs text-muted">{key.projectName}</span>
                  </div>

                  <div className="flex shrink-0 gap-6">
                    <Metric
                      label="Requests"
                      size="sm"
                      align="end"
                      value={formatCount(key.requests)}
                      reason="Not reported"
                    />
                    <Metric
                      label="Tokens"
                      size="sm"
                      align="end"
                      value={formatCount(key.totalTokens)}
                      reason="Not reported"
                    />
                    <Metric
                      label="Cost"
                      size="sm"
                      align="end"
                      value={formatUsd(key.estimatedCost)}
                      reason="Not reported"
                    />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Capability({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
