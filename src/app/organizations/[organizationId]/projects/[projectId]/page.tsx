import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CredentialStatusBadge } from '@/components/credential-status';
import { InlineNotice } from '@/components/notice';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { maskedKey } from '@/lib/credentials/mask';
import { listApiKeys } from '@/lib/credentials/repository';
import { describeCredentialStatus } from '@/lib/credentials/status';
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

  const keys = await listApiKeys(organizationId, { projectId: project.id });
  const canManageKeys = hasPermission(access.role, 'api_keys:manage');

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

      <InlineNotice tone="info">Monitored databases are registered in Phase 7.</InlineNotice>
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
