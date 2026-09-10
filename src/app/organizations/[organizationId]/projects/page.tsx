import Link from 'next/link';

import { Notice } from '@/components/notice';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { listProjects } from '@/lib/projects/repository';
import { ENVIRONMENT_LABELS } from '@/lib/projects/schema';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage({
  params,
}: PageProps<'/organizations/[organizationId]/projects'>) {
  const { organizationId } = await params;
  const access = await requireOrgAccess(organizationId);

  const projects = await listProjects(organizationId);
  const canManage = hasPermission(access.role, 'projects:manage');
  const base = `/organizations/${organizationId}/projects`;

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted">What AI usage and database health are attributed to.</p>
        </div>

        {/* Hidden for a developer, and also refused server-side by the action. */}
        {canManage ? (
          <Link
            href={`${base}/new`}
            className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98]"
          >
            New project
          </Link>
        ) : null}
      </header>

      {projects.length === 0 ? (
        <Notice
          tone="empty"
          title="No projects yet"
          action={
            canManage ? (
              <Link
                href={`${base}/new`}
                className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98]"
              >
                Create the first project
              </Link>
            ) : undefined
          }
          elsewhere={
            canManage
              ? undefined
              : 'Only an organization admin can create projects. Ask one to add the first.'
          }
        >
          A project is what an API key is registered against, which is what makes per-project cost
          attribution possible. Nothing can be monitored until one exists.
        </Notice>
      ) : (
        <ul className="flex flex-col gap-2">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                href={`${base}/${project.id}`}
                className="bezel rounded-shell block p-1.5 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5"
              >
                <div className="glass rounded-core flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-sm font-medium">{project.name}</span>
                    {project.description ? (
                      <span className="truncate text-xs text-faint">{project.description}</span>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
                    <span className="rounded-full border border-hairline px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em]">
                      {ENVIRONMENT_LABELS[project.environment]}
                    </span>
                    <span className="font-mono tabular-nums">
                      {project.apiKeyCount} {project.apiKeyCount === 1 ? 'key' : 'keys'}
                    </span>
                    <span className="text-faint">·</span>
                    <span className="font-mono tabular-nums">
                      {project.databaseCount} {project.databaseCount === 1 ? 'db' : 'dbs'}
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
