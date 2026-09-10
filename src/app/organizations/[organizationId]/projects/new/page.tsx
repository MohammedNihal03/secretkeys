import Link from 'next/link';

import { createProjectAction } from '@/lib/projects/actions';
import { requirePermission } from '@/lib/auth/guards';
import { ProjectForm } from '../project-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'New project' };

export default async function NewProjectPage({
  params,
}: PageProps<'/organizations/[organizationId]/projects/new'>) {
  const { organizationId } = await params;

  // 404s for a developer, so the page is not merely unlinked but unreachable.
  await requirePermission(organizationId, 'projects:manage');

  /**
   * The organization id is bound server-side rather than posted as a hidden
   * field, so a crafted submission cannot create a project in another tenant.
   */
  const action = createProjectAction.bind(null, organizationId);

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/organizations/${organizationId}/projects`}
          className="w-fit text-xs text-faint transition-colors hover:text-muted"
        >
          ← Projects
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
      </header>

      <ProjectForm action={action} submitLabel="Create project" />
    </div>
  );
}
