import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { getSqlState, PG_ERROR } from '@/lib/db/errors';
import { apiKeys, monitoredDatabases, projects, type Project } from '@/lib/db/schema';
import type { Environment } from './schema';

/**
 * Project persistence.
 *
 * Every function takes `organizationId` as its first argument and filters on
 * it, so a caller cannot accidentally read or write another tenant's project.
 * Authorization happens above this layer -- these functions assume the caller
 * has already been through a guard, and they enforce the tenant boundary
 * regardless.
 */

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  environment: Environment;
  createdAt: Date;
  updatedAt: Date;
  /** Counts of what depends on this project, for the list and detail views. */
  apiKeyCount: number;
  databaseCount: number;
}

export type CreateProjectResult =
  { ok: true; project: Project } | { ok: false; error: 'duplicate_name' };

export type UpdateProjectResult =
  { ok: true; project: Project } | { ok: false; error: 'duplicate_name' | 'not_found' };

export async function listProjects(organizationId: string): Promise<ProjectSummary[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      environment: projects.environment,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      /**
       * Correlated subqueries rather than joins with GROUP BY: a project with
       * both keys and databases would otherwise multiply rows and inflate both
       * counts.
       */
      apiKeyCount: db.$count(apiKeys, eq(apiKeys.projectId, projects.id)),
      databaseCount: db.$count(monitoredDatabases, eq(monitoredDatabases.projectId, projects.id)),
    })
    .from(projects)
    .where(eq(projects.organizationId, organizationId))
    .orderBy(asc(projects.name));

  return rows;
}

export async function getProject(
  organizationId: string,
  projectId: string
): Promise<ProjectSummary | null> {
  const db = getDb();

  const [row] = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      environment: projects.environment,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      apiKeyCount: db.$count(apiKeys, eq(apiKeys.projectId, projects.id)),
      databaseCount: db.$count(monitoredDatabases, eq(monitoredDatabases.projectId, projects.id)),
    })
    .from(projects)
    // Both predicates matter: the id alone would reach another tenant's project.
    .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
    .limit(1);

  return row ?? null;
}

export interface ProjectInput {
  name: string;
  description: string | null;
  environment: Environment;
}

export async function createProject(
  organizationId: string,
  input: ProjectInput
): Promise<CreateProjectResult> {
  try {
    const [project] = await getDb()
      .insert(projects)
      .values({ organizationId, ...input })
      .returning();

    return { ok: true, project };
  } catch (error) {
    /**
     * Let the unique constraint decide, rather than checking for an existing
     * name first. A read-then-write would race two concurrent creates, and the
     * database already enforces uniqueness per organization.
     */
    if (getSqlState(error) === PG_ERROR.uniqueViolation) {
      return { ok: false, error: 'duplicate_name' };
    }

    throw error;
  }
}

export async function updateProject(
  organizationId: string,
  projectId: string,
  input: ProjectInput
): Promise<UpdateProjectResult> {
  try {
    const [project] = await getDb()
      .update(projects)
      .set(input)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
      .returning();

    // No row updated means it does not exist *in this organization*.
    return project ? { ok: true, project } : { ok: false, error: 'not_found' };
  } catch (error) {
    if (getSqlState(error) === PG_ERROR.uniqueViolation) {
      return { ok: false, error: 'duplicate_name' };
    }

    throw error;
  }
}

/**
 * Whether a project can be deleted without destroying monitoring history.
 *
 * Deleting a project cascades to its API keys and monitored databases, so this
 * is checked and surfaced rather than silently discarding registered
 * credentials.
 */
export async function projectDependencies(
  organizationId: string,
  projectId: string
): Promise<{ apiKeyCount: number; databaseCount: number } | null> {
  const project = await getProject(organizationId, projectId);
  if (!project) return null;

  return { apiKeyCount: project.apiKeyCount, databaseCount: project.databaseCount };
}
