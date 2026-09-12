import Link from 'next/link';

import { Notice } from '@/components/notice';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { encryptionConfigurationError } from '@/lib/credentials/crypto';
import { registerDatabaseAction, type DatabaseFormState } from '@/lib/databases/actions';
import { MONITORING_ROLE_SQL } from '@/lib/databases/queries';
import { listProjects } from '@/lib/projects/repository';
import { DatabaseForm } from './database-form';

/**
 * Registering a PostgreSQL database for monitoring.
 *
 * The page refuses before the form when a prerequisite is missing -- no
 * encryption key, no project, no permission -- rather than letting someone fill
 * in a connection and a password only to be told at the end.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Add a database' };

export default async function NewDatabasePage({
  params,
}: PageProps<'/organizations/[organizationId]/databases/new'>) {
  const { organizationId } = await params;
  const access = await requireOrgAccess(organizationId);

  const base = `/organizations/${organizationId}`;
  const canManage = hasPermission(access.role, 'databases:manage');
  const configurationError = encryptionConfigurationError();
  const projects = await listProjects(organizationId);

  async function action(
    previous: DatabaseFormState,
    formData: FormData
  ): Promise<DatabaseFormState> {
    'use server';
    return registerDatabaseAction(organizationId, previous, formData);
  }

  return (
    <div className="animate-rise flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`${base}/databases`}
          className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint transition-colors hover:text-muted"
        >
          Databases
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Add a database</h1>
        <p className="max-w-[65ch] text-sm text-muted">
          The collector opens its own short-lived, read-only connection to this database. It is
          never reached from the browser, and its password is encrypted before it is stored.
        </p>
      </header>

      {!canManage ? (
        <Notice tone="info" title="You do not have permission to add a database">
          An organization admin can register databases. You can see everything this organization
          already monitors.
        </Notice>
      ) : configurationError ? (
        <Notice tone="problem" title="Encryption is not configured">
          {configurationError} Until it is set, a database password cannot be stored safely, so
          registration is refused rather than stored in the clear.
        </Notice>
      ) : projects.length === 0 ? (
        <Notice
          tone="empty"
          title="Create a project first"
          action={
            <Link
              href={`${base}/projects/new`}
              className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98]"
            >
              Create a project
            </Link>
          }
        >
          A database belongs to a project, which is what its metrics are attributed to. One has to
          exist before a database can be registered against it.
        </Notice>
      ) : (
        <DatabaseForm action={action} projects={projects} roleSql={MONITORING_ROLE_SQL} />
      )}
    </div>
  );
}
