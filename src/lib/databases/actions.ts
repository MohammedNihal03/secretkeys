'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requirePermission } from '@/lib/auth/guards';
import { getMonitoredDatabase, setDatabaseStatus, type DatabaseStatus } from './repository';
import { fieldErrors, parseRegisterDatabase, type RegisterDatabaseFieldErrors } from './schema';
import { recheckDatabase, registerMonitoredDatabase } from './service';

/**
 * Monitored-database mutations.
 *
 * Each action re-checks permission server-side. A Server Action is a public
 * endpoint: being reachable only from a page that hid the button is not access
 * control, because the action can be invoked directly.
 *
 * SECURITY: the password field is never echoed back into form state. Every
 * other field is, so a validation error does not wipe what was typed, but a
 * secret that round-trips through a re-render is a secret in a payload the
 * browser caches.
 */

export interface DatabaseFormState {
  errors?: RegisterDatabaseFieldErrors;
  error?: string;
  /** Raw input echoed back, minus the password. */
  values?: Record<string, string>;
}

const ECHOED = [
  'projectId',
  'name',
  'host',
  'port',
  'databaseName',
  'username',
  'ca',
  'sslEnabled',
  'allowUnverifiedCertificate',
  'environment',
] as const;

function echo(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};

  for (const field of ECHOED) {
    const value = formData.get(field);
    if (typeof value === 'string') values[field] = value;
  }

  return values;
}

export async function registerDatabaseAction(
  organizationId: string,
  _previous: DatabaseFormState,
  formData: FormData
): Promise<DatabaseFormState> {
  // Throws (404s) before any input is touched if the caller may not manage databases.
  await requirePermission(organizationId, 'databases:manage');

  const parsed = parseRegisterDatabase(formData);

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error), values: echo(formData) };
  }

  const result = await registerMonitoredDatabase(organizationId, parsed.data);

  if (!result.ok) {
    return 'errors' in result
      ? { errors: result.errors, values: echo(formData) }
      : { error: result.error, values: echo(formData) };
  }

  revalidatePath(`/organizations/${organizationId}/databases`);
  redirect(`/organizations/${organizationId}/databases/${result.databaseId}`);
}

export interface CheckState {
  message?: string;
  tone?: 'ok' | 'problem';
}

/**
 * Re-checks a database on demand, so an operator need not wait for the schedule.
 *
 * The unused `previous` and `formData` are the `useActionState` signature: the
 * button carries no input, and the result never depends on the last one.
 */
export async function recheckDatabaseAction(
  organizationId: string,
  databaseId: string,
  previous: CheckState,
  formData: FormData
): Promise<CheckState> {
  void previous;
  void formData;

  await requirePermission(organizationId, 'databases:manage');

  const database = await getMonitoredDatabase(organizationId, databaseId);
  if (!database) return { message: 'That database is no longer registered.', tone: 'problem' };

  const result = await recheckDatabase(organizationId, databaseId, database);

  revalidatePath(`/organizations/${organizationId}/databases/${databaseId}`);

  if (!result.ok) return { message: result.error, tone: 'problem' };

  return result.check.outcome === 'connected'
    ? {
        message: result.check.serverVersion
          ? `Connected. PostgreSQL ${result.check.serverVersion}.`
          : 'Connected.',
        tone: 'ok',
      }
    : {
        message: result.check.detail ?? 'The database could not be reached.',
        tone: 'problem',
      };
}

export async function setDatabaseStatusAction(
  organizationId: string,
  databaseId: string,
  status: DatabaseStatus
): Promise<void> {
  await requirePermission(organizationId, 'databases:manage');

  await setDatabaseStatus(organizationId, databaseId, status);
  revalidatePath(`/organizations/${organizationId}/databases/${databaseId}`);
  revalidatePath(`/organizations/${organizationId}/databases`);
}
