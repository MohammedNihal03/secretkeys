import Link from 'next/link';

import { formatCount, formatUsd } from '@/components/metric';
import { Notice } from '@/components/notice';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { rankProjectsByConsumption } from '@/lib/dashboard/analytics';
import { listProjects } from '@/lib/projects/repository';
import { ENVIRONMENT_LABELS } from '@/lib/projects/schema';

/**
 * Projects, ranked by what they consumed.
 *
 * The build plan asks this view to answer "which project is consuming the most
 * AI resources", so the list is ordered by consumption rather than by name, and
 * it says which figure it ranked by. Sorting silently by whichever number
 * happened to be present would put a project with a known cost below one with
 * only a token count.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Projects' };

/** How far back the consumption ranking looks. */
const WINDOW_DAYS = 7;

const BASIS_LABEL: Record<string, string> = {
  cost: 'Ranked by cost reported over the last 7 days.',
  tokens: 'Ranked by tokens over the last 7 days. No provider here reports cost.',
  requests: 'Ranked by requests over the last 7 days. No provider here reports tokens or cost.',
  none: 'No usage has been stored yet, so these are listed by name.',
};

export default async function ProjectsPage({
  params,
}: PageProps<'/organizations/[organizationId]/projects'>) {
  const { organizationId } = await params;
  const access = await requireOrgAccess(organizationId);

  const now = new Date();
  const [projects, ranking] = await Promise.all([
    listProjects(organizationId),
    rankProjectsByConsumption(organizationId, {
      from: new Date(now.getTime() - WINDOW_DAYS * 86_400_000),
      to: now,
    }),
  ]);

  const usageById = new Map(ranking.rows.map((row) => [row.id, row]));
  const order = new Map(ranking.rows.map((row, index) => [row.id, index]));

  /**
   * Projects with usage first, in ranked order; the rest after, by name. A
   * project with nothing recorded is not "cheapest", it is unmeasured, so it
   * does not compete for a position in the ranking.
   */
  const ordered = [...projects].sort((a, b) => {
    const rankA = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rankB = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;

    return rankA === rankB ? a.name.localeCompare(b.name) : rankA - rankB;
  });

  const canManage = hasPermission(access.role, 'projects:manage');
  const base = `/organizations/${organizationId}/projects`;

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted">
            What AI usage and database health are attributed to.{' '}
            {projects.length > 0 ? BASIS_LABEL[ranking.basis] : ''}
          </p>
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
          {ordered.map((project) => {
            const usage = usageById.get(project.id);

            return (
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
                      <span className="text-xs text-muted">
                        {usage
                          ? [
                              formatUsd(usage.estimatedCost),
                              usage.totalTokens !== null
                                ? `${formatCount(usage.totalTokens)} tokens`
                                : null,
                              usage.requests !== null
                                ? `${formatCount(usage.requests)} requests`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') || 'Nothing reported for this window'
                          : 'No usage stored'}
                      </span>
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
            );
          })}
        </ul>
      )}
    </div>
  );
}
