import Link from 'next/link';

import { HealthDot } from '@/components/health-pill';
import { formatAgo } from '@/components/metric';
import { Notice } from '@/components/notice';
import { countActiveAlerts, listAlerts, type AlertView } from '@/lib/alerts/repository';
import { requireOrgAccess } from '@/lib/auth/guards';

/**
 * Alerts.
 *
 * An alert here is a condition that is currently true, not an event that
 * happened once. That is why the list is short even after a long outage: six
 * hours above a threshold is one row that has been open for six hours, and the
 * resolved section below is the history.
 *
 * Nothing on this page can be dismissed. A condition clears when the next
 * collection observes that it is no longer true, and a button that hid it
 * without fixing it would make the list a record of what people had got tired
 * of looking at.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Alerts' };

export default async function AlertsPage({
  params,
}: PageProps<'/organizations/[organizationId]/alerts'>) {
  const { organizationId } = await params;
  await requireOrgAccess(organizationId);

  const [active, resolved, counts] = await Promise.all([
    listAlerts({ organizationId, status: 'active' }),
    listAlerts({ organizationId, status: 'resolved', limit: 25 }),
    countActiveAlerts(organizationId),
  ]);

  const base = `/organizations/${organizationId}`;
  const now = new Date();

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <p className="max-w-[70ch] text-sm text-muted">
          {counts.total === 0
            ? 'Nothing is above a threshold right now.'
            : `${counts.critical} critical and ${counts.warning} warning condition${
                counts.warning === 1 ? '' : 's'
              } are open. Each one clears itself when a collection finds it is no longer true.`}
        </p>
      </header>

      {active.length === 0 ? (
        <Notice tone="info" title="No open alerts">
          An alert is raised when a collected metric crosses a threshold, and resolved when a later
          collection finds it back within it. Nothing is dismissible here on purpose: a condition
          that can be hidden without being fixed stops being worth reading.
        </Notice>
      ) : (
        <section className="glass overflow-hidden rounded-(--radius-core)">
          <h2 className="border-b border-hairline px-5 py-4 text-sm font-medium">Open</h2>
          <ul className="divide-y divide-hairline">
            {active.map((alert) => (
              <AlertRow key={alert.id} alert={alert} base={base} now={now} />
            ))}
          </ul>
        </section>
      )}

      {resolved.length > 0 ? (
        <section className="glass overflow-hidden rounded-(--radius-core)">
          <h2 className="border-b border-hairline px-5 py-4 text-sm font-medium">Resolved</h2>
          <ul className="divide-y divide-hairline">
            {resolved.map((alert) => (
              <AlertRow key={alert.id} alert={alert} base={base} now={now} resolved />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function AlertRow({
  alert,
  base,
  now,
  resolved = false,
}: {
  alert: AlertView;
  base: string;
  now: Date;
  resolved?: boolean;
}) {
  const href =
    alert.resourceType === 'monitored_database'
      ? `${base}/databases/${alert.resourceId}`
      : `${base}/keys/${alert.resourceId}`;

  const duration = resolved
    ? describeDuration(alert.triggeredAt, alert.resolvedAt ?? now)
    : describeDuration(alert.triggeredAt, now);

  return (
    <li className="flex gap-3 px-5 py-4" style={resolved ? { opacity: 0.7 } : undefined}>
      <span className="mt-1">
        <HealthDot
          level={resolved ? 'healthy' : alert.severity}
          title={resolved ? 'Resolved' : alert.severity}
        />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <Link href={href} className="text-sm font-medium transition-colors hover:text-accent">
            {alert.title}
          </Link>
          <span className="shrink-0 text-[11px] text-faint">
            {resolved
              ? `Resolved ${formatAgo(alert.resolvedAt, now)} · lasted ${duration}`
              : `Open for ${duration}`}
          </span>
        </div>

        <p className="text-xs leading-snug text-muted">{alert.description}</p>

        <p className="text-[11px] text-faint">
          {alert.resourceType === 'monitored_database' ? 'Database' : 'API key'} ·{' '}
          {alert.resourceName} · <span className="font-mono">{alert.rule}</span>
          {/* The peak matters once it has eased: a condition that reached critical
              and fell back to warning is not a warning-only incident. */}
          {alert.peakSeverity !== alert.severity ? ` · peaked at ${alert.peakSeverity}` : ''}
        </p>
      </div>
    </li>
  );
}

function describeDuration(from: Date, to: Date): string {
  const minutes = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));

  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
