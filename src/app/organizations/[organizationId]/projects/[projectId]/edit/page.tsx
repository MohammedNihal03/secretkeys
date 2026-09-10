import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requirePermission } from '@/lib/auth/guards';
import { updateProjectAction } from '@/lib/projects/actions';
import { getProject } from '@/lib/projects/repository';
import { ProjectForm } from '../../project-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Edit project' };

export default async function EditProjectPage({
  params,
}: PageProps<'/organizations/[organizationId]/projects/[projectId]/edit'>) {
  const { organizationId, projectId } = await params;
  await requirePermission(organizationId, 'projects:manage');

  const project = await getProject(organizationId, projectId);
  if (!project) notFound();

  // Both ids bound server-side; neither is trusted from the submission.
  const action = updateProjectAction.bind(null, organizationId, projectId);

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/organizations/${organizationId}/projects/${projectId}`}
          className="w-fit text-xs text-faint transition-colors hover:text-muted"
        >
          ← {project.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Edit project</h1>
      </header>

      <ProjectForm
        action={action}
        submitLabel="Save changes"
        defaults={{
          name: project.name,
          description: project.description,
          environment: project.environment,
        }}
      />
    </div>
  );
}
