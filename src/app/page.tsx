import { getHealthReport, type HealthStatus } from '@/lib/health';

/**
 * Phase 0 status page.
 *
 * Deliberately minimal: it proves the app, the API layer and the database
 * connection are wired together. The real organization dashboard arrives in
 * Phase 10, once collectors are producing actual metrics.
 */

export const dynamic = 'force-dynamic';

const STATUS_STYLES: Record<HealthStatus, { dot: string; label: string }> = {
  healthy: { dot: 'bg-emerald-500', label: 'Healthy' },
  degraded: { dot: 'bg-amber-500', label: 'Degraded' },
  unhealthy: { dot: 'bg-red-500', label: 'Unhealthy' },
  unknown: { dot: 'bg-zinc-400', label: 'Unknown' },
};

function StatusBadge({ status }: { status: HealthStatus }) {
  const { dot, label } = STATUS_STYLES[status];

  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      <span className={`size-2.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

export default async function Home() {
  const health = await getHealthReport();
  const { database } = health.checks;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">AI &amp; Database Observability</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Phase 0 foundation. No metrics are being collected yet.
        </p>
      </header>

      <dl className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        <div className="flex items-center justify-between px-4 py-3">
          <dt className="text-sm text-zinc-600 dark:text-zinc-400">System</dt>
          <dd>
            <StatusBadge status={health.status} />
          </dd>
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <dt className="text-sm text-zinc-600 dark:text-zinc-400">Dashboard database</dt>
          <dd className="flex items-center gap-3">
            <span className="font-mono text-xs text-zinc-500">{database.latencyMs}ms</span>
            <StatusBadge status={database.status} />
          </dd>
        </div>
      </dl>

      {database.error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 font-mono text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {database.error}
        </p>
      ) : null}

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Machine-readable health is served from{' '}
        <a className="font-mono underline underline-offset-4" href="/api/health">
          /api/health
        </a>
        .
      </p>
    </main>
  );
}
