import Link from 'next/link';

import { Notice } from '@/components/notice';
import { requirePermission } from '@/lib/auth/guards';
import { registerApiKeyAction } from '@/lib/credentials/actions';
import { encryptionConfigurationError } from '@/lib/credentials/crypto';
import { listProjects } from '@/lib/projects/repository';
import { listEnabledProviders } from '@/lib/providers/selection';
import { ApiKeyForm } from './api-key-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Register API key' };

export default async function RegisterApiKeyPage({
  params,
  searchParams,
}: PageProps<'/organizations/[organizationId]/keys/new'>) {
  const { organizationId } = await params;
  const { projectId } = await searchParams;

  // 404s for a developer: the form is unreachable, not merely unlinked.
  await requirePermission(organizationId, 'api_keys:manage');

  const [projects, providers] = await Promise.all([
    listProjects(organizationId),
    listEnabledProviders(organizationId),
  ]);

  const base = `/organizations/${organizationId}`;
  const configurationError = encryptionConfigurationError();

  const header = (
    <header className="flex flex-col gap-2">
      <Link
        href={`${base}/keys`}
        className="w-fit text-xs text-faint transition-colors hover:text-muted"
      >
        ← API keys
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Register API key</h1>
    </header>
  );

  if (configurationError || projects.length === 0 || providers.length === 0) {
    return (
      <div className="animate-rise flex flex-col gap-6">
        {header}
        {configurationError ? (
          <Notice
            tone="problem"
            title="Credential encryption is not configured"
            elsewhere={
              <>
                Run <code className="font-mono">npm run generate:key</code>, set the result as{' '}
                <code className="font-mono">CREDENTIAL_ENCRYPTION_KEY</code>, and restart.
              </>
            }
          >
            {configurationError}
          </Notice>
        ) : projects.length === 0 ? (
          <Notice
            tone="empty"
            title="Create a project first"
            action={
              <Link href={`${base}/projects/new`} className="text-sm underline underline-offset-4">
                Create a project
              </Link>
            }
          >
            A key has to belong to a project so its usage can be attributed.
          </Notice>
        ) : (
          <Notice
            tone="empty"
            title="No providers are being tracked"
            action={
              <Link href={`${base}/providers`} className="text-sm underline underline-offset-4">
                Choose providers
              </Link>
            }
          >
            Keys can only be registered for providers this organization tracks.
          </Notice>
        )}
      </div>
    );
  }

  return (
    <div className="animate-rise flex flex-col gap-6">
      {header}
      <ApiKeyForm
        // The organization id is bound server-side, never read from the form.
        action={registerApiKeyAction.bind(null, organizationId)}
        projects={projects.map((project) => ({
          id: project.id,
          name: project.name,
          environment: project.environment,
        }))}
        providers={providers.map((entry) => ({
          id: entry.providerId,
          type: entry.type,
          name: entry.displayName,
          usage: entry.adapter.capabilities.usage,
        }))}
        defaultProjectId={typeof projectId === 'string' ? projectId : undefined}
        providersHref={`${base}/providers`}
      />
    </div>
  );
}
