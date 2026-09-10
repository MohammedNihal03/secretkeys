import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { getProject } from '@/lib/projects/repository';
import { ENVIRONMENT_LABELS } from '@/lib/projects/schema';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage({
  params,
}: PageProps<'/organizations/[organizationId]/projects/[projectId]'>) {
  const { organizationId, projectId } = await params;
  const access = await requireOrgAccess(organizationId);

  // Scoped by organization, so another tenant's project id resolves to null.
  const project = await getProject(organizationId, projectId);
  if (!project) notFound();

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

      <div className="bezel rounded-shell p-1.5">
        <dl className="glass rounded-core divide-y" style={{ borderColor: 'var(--hairline)' }}>
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

      <p className="text-sm text-muted">
        Registering API keys and databases against this project arrives in Phase 4.
      </p>
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
