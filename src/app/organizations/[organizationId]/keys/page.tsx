import Link from 'next/link';

import { CredentialStatusBadge } from '@/components/credential-status';
import { Notice } from '@/components/notice';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { encryptionConfigurationError } from '@/lib/credentials/crypto';
import { maskedKey } from '@/lib/credentials/mask';
import { listApiKeys } from '@/lib/credentials/repository';
import { describeCredentialStatus } from '@/lib/credentials/status';
import { listProjects } from '@/lib/projects/repository';
import { ENVIRONMENT_LABELS } from '@/lib/projects/schema';
import { listEnabledProviders } from '@/lib/providers/selection';

/**
 * Registered API keys.
 *
 * The table the build plan describes: project, provider, masked key,
 * environment, state. Only the last four characters of any key ever reach this
 * page -- the repository never selects the ciphertext at all.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'API keys' };

const PRIMARY_LINK =
  'rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98]';

export default async function ApiKeysPage({
  params,
}: PageProps<'/organizations/[organizationId]/keys'>) {
  const { organizationId } = await params;
  const access = await requireOrgAccess(organizationId);
  const canManage = hasPermission(access.role, 'api_keys:manage');

  const [keys, projects, providers] = await Promise.all([
    listApiKeys(organizationId),
    listProjects(organizationId),
    listEnabledProviders(organizationId),
  ]);

  const configurationError = encryptionConfigurationError();
  const base = `/organizations/${organizationId}`;
  const canRegister =
    canManage && !configurationError && projects.length > 0 && providers.length > 0;

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
          <p className="max-w-prose text-sm text-muted">
            Each key belongs to one project and environment — that link is what lets usage and cost
            be attributed. Keys are encrypted at rest; only the last four characters are ever shown.
          </p>
        </div>

        {canRegister ? (
          <Link href={`${base}/keys/new`} className={PRIMARY_LINK}>
            Register key
          </Link>
        ) : null}
      </header>

      {/* Encryption is the prerequisite for everything else on this page. */}
      {configurationError ? (
        <Notice
          tone="problem"
          title="Credential encryption is not configured"
          elsewhere={
            canManage ? (
              <>
                Generate a key with <code className="font-mono">npm run generate:key</code>, set it
                as <code className="font-mono">CREDENTIAL_ENCRYPTION_KEY</code>, and restart. Back
                it up separately from the database — without it, stored keys cannot be recovered.
              </>
            ) : (
              'An organization admin or whoever runs this deployment needs to set it.'
            )
          }
        >
          {canManage ? configurationError : 'API keys cannot be stored or read until it is set.'}
        </Notice>
      ) : null}

      {keys.length === 0 ? (
        projects.length === 0 ? (
          <Notice
            tone="empty"
            title="Create a project first"
            action={
              canManage ? (
                <Link href={`${base}/projects/new`} className={PRIMARY_LINK}>
                  Create a project
                </Link>
              ) : undefined
            }
          >
            Every key is registered against a project, so usage can be attributed to whoever
            actually uses it. There are no projects in this organization yet.
          </Notice>
        ) : providers.length === 0 ? (
          <Notice
            tone="empty"
            title="No providers are being tracked"
            action={
              canManage ? (
                <Link href={`${base}/providers`} className={PRIMARY_LINK}>
                  Choose providers
                </Link>
              ) : undefined
            }
          >
            Keys can only be registered for providers this organization tracks.
          </Notice>
        ) : (
          <Notice
            tone="empty"
            title="No API keys registered yet"
            action={
              canRegister ? (
                <Link href={`${base}/keys/new`} className={PRIMARY_LINK}>
                  Register the first key
                </Link>
              ) : undefined
            }
            elsewhere={canManage ? undefined : 'Only an organization admin can register keys.'}
          >
            Register a key against a project and the dashboard will check it with the provider,
            encrypt it, and start tracking what that provider exposes.
          </Notice>
        )
      ) : (
        <div className="bezel rounded-shell p-1.5">
          <div className="glass rounded-core overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.14em] text-faint">
                  <th className="px-4 py-3 font-medium">Key</th>
                  <th className="px-4 py-3 font-medium">Project</th>
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 font-medium">Environment</th>
                  <th className="px-4 py-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className="border-t" style={{ borderColor: 'var(--hairline)' }}>
                    <td className="px-4 py-3">
                      <Link
                        href={`${base}/keys/${key.id}`}
                        className="flex flex-col gap-0.5 hover:underline hover:underline-offset-4"
                      >
                        <span className="font-medium">{key.keyName}</span>
                        <span className="font-mono text-xs text-muted">
                          {maskedKey(key.keyLast4)}
                        </span>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{key.project.name}</td>
                    <td className="px-4 py-3 text-muted">{key.provider.name}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border border-hairline px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
                        {ENVIRONMENT_LABELS[key.environment]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <CredentialStatusBadge
                        view={describeCredentialStatus(key.status, key.lastValidationOutcome)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
