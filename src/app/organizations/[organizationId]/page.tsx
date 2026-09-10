import Link from 'next/link';

import { Notice } from '@/components/notice';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { listProjects } from '@/lib/projects/repository';
import { listProviderSelection } from '@/lib/providers/selection';

/**
 * Organization overview.
 *
 * Reports only what is genuinely known at this phase: how many projects exist
 * and how many credentials are registered. The health and usage dashboard
 * arrives in Phase 10, once collectors are producing real metrics -- inventing
 * numbers here to fill the space is exactly what the build plan forbids.
 */

export const dynamic = 'force-dynamic';

export default async function OrganizationOverview({
  params,
}: PageProps<'/organizations/[organizationId]'>) {
  const { organizationId } = await params;
  const access = await requireOrgAccess(organizationId);

  const [projects, selection] = await Promise.all([
    listProjects(organizationId),
    listProviderSelection(organizationId),
  ]);

  const base = `/organizations/${organizationId}`;
  const totalKeys = projects.reduce((sum, project) => sum + project.apiKeyCount, 0);
  const totalDatabases = projects.reduce((sum, project) => sum + project.databaseCount, 0);
  const tracked = selection.filter((entry) => entry.enabled);
  const canManage = hasPermission(access.role, 'providers:manage');

  return (
    <div className="animate-rise flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted">
          No metrics are being collected yet. Collectors arrive in Phase 5.
        </p>
      </header>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Stat label="Projects" value={projects.length} href={`${base}/projects`} />
        <Stat
          label="Providers tracked"
          value={tracked.length}
          of={selection.length}
          href={`${base}/providers`}
        />
        <Stat label="API keys" value={totalKeys} />
        <Stat label="Databases" value={totalDatabases} />
      </dl>

      {/*
        The two prerequisites before anything can be collected, each with the
        one next step. Reported in order, because a project must exist before a
        credential can be attributed to it.
      */}
      {projects.length === 0 ? (
        <Notice
          tone="empty"
          title="Nothing is set up yet"
          action={
            canManage ? (
              <Link
                href={`${base}/projects/new`}
                className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98]"
              >
                Create a project
              </Link>
            ) : undefined
          }
        >
          A project is what usage and cost get attributed to, so one has to exist before an API key
          can be registered against it. After that, choose which providers to track.
        </Notice>
      ) : tracked.length === 0 ? (
        <Notice
          tone="empty"
          title="No providers are being tracked"
          action={
            canManage ? (
              <Link
                href={`${base}/providers`}
                className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98]"
              >
                Choose providers
              </Link>
            ) : undefined
          }
        >
          There {projects.length === 1 ? 'is' : 'are'} {projects.length}{' '}
          {projects.length === 1 ? 'project' : 'projects'} here but no provider selected, so there
          is nothing to collect from.
        </Notice>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-faint">Tracking</h2>
          <div className="flex flex-wrap gap-1.5">
            {tracked.map((entry) => (
              <span
                key={entry.providerId}
                className="rounded-full border border-hairline bg-shell px-2.5 py-1 text-xs text-muted"
              >
                {entry.displayName}
              </span>
            ))}
          </div>
          <p className="text-sm text-muted">
            <Link
              href={`${base}/providers`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              See what each one exposes
            </Link>{' '}
            — they differ substantially, and several report no usage at all.
          </p>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  of,
}: {
  label: string;
  value: number;
  href?: string;
  /** Renders as "2 / 7" when a total is what gives the number meaning. */
  of?: number;
}) {
  const body = (
    <div className="bezel rounded-shell p-1.5 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5">
      <div className="glass rounded-core flex flex-col gap-1 px-4 py-3.5">
        <dt className="text-xs text-muted">{label}</dt>
        <dd className="font-mono text-2xl tabular-nums">
          {value}
          {of === undefined ? null : <span className="text-base text-faint"> / {of}</span>}
        </dd>
      </div>
    </div>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}
