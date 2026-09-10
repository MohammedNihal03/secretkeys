import Link from 'next/link';

import { requireOrgAccess } from '@/lib/auth/guards';
import { listProjects } from '@/lib/projects/repository';
import { listAdapters } from '@/lib/providers/registry';

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
  await requireOrgAccess(organizationId);

  const projects = await listProjects(organizationId);

  const base = `/organizations/${organizationId}`;
  const totalKeys = projects.reduce((sum, project) => sum + project.apiKeyCount, 0);
  const totalDatabases = projects.reduce((sum, project) => sum + project.databaseCount, 0);

  return (
    <div className="animate-rise flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted">
          No metrics are being collected yet. Collectors arrive in Phase 5.
        </p>
      </header>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Projects" value={projects.length} href={`${base}/projects`} />
        <Stat label="API keys" value={totalKeys} />
        <Stat label="Monitored databases" value={totalDatabases} />
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-faint">
          Available providers
        </h2>
        <p className="text-sm text-muted">
          {listAdapters().length} providers have adapters.{' '}
          <Link
            href={`${base}/providers`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            See what each one exposes
          </Link>{' '}
          — they differ substantially, and several report no usage at all.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href?: string }) {
  const body = (
    <div className="bezel rounded-shell p-1.5 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5">
      <div className="glass rounded-core flex flex-col gap-1 px-4 py-3.5">
        <dt className="text-xs text-muted">{label}</dt>
        <dd className="font-mono text-2xl tabular-nums">{value}</dd>
      </div>
    </div>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}
