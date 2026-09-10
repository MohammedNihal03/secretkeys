'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requirePermission } from '@/lib/auth/guards';
import { createProject, updateProject } from './repository';
import { parseProjectForm, type FieldErrors } from './schema';

/**
 * Project mutations.
 *
 * Each action re-checks permission server-side via `requirePermission`. A
 * Server Action is a public endpoint -- being reachable only from a page that
 * hid the button is not access control, since the action can be invoked
 * directly.
 */

export interface ProjectFormState {
  errors?: FieldErrors;
  /** Form-level error, for failures not tied to one field. */
  error?: string;
}

export async function createProjectAction(
  organizationId: string,
  _previous: ProjectFormState,
  formData: FormData
): Promise<ProjectFormState> {
  // Throws (404s) before any input is touched if the caller may not manage projects.
  await requirePermission(organizationId, 'projects:manage');

  const parsed = parseProjectForm(formData);
  if (!parsed.ok) return { errors: parsed.errors };

  const result = await createProject(organizationId, parsed.values);

  if (!result.ok) {
    return { errors: { name: 'A project with this name already exists.' } };
  }

  // The list is a dynamic page, but revalidating keeps any cached segment honest.
  revalidatePath(`/organizations/${organizationId}/projects`);
  redirect(`/organizations/${organizationId}/projects/${result.project.id}`);
}

export async function updateProjectAction(
  organizationId: string,
  projectId: string,
  _previous: ProjectFormState,
  formData: FormData
): Promise<ProjectFormState> {
  await requirePermission(organizationId, 'projects:manage');

  const parsed = parseProjectForm(formData);
  if (!parsed.ok) return { errors: parsed.errors };

  const result = await updateProject(organizationId, projectId, parsed.values);

  if (!result.ok) {
    return result.error === 'duplicate_name'
      ? { errors: { name: 'A project with this name already exists.' } }
      : { error: 'This project no longer exists.' };
  }

  revalidatePath(`/organizations/${organizationId}/projects`);
  redirect(`/organizations/${organizationId}/projects/${projectId}`);
}
