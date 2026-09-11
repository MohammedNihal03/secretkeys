import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CredentialStatusBadge } from '@/components/credential-status';
import { InlineNotice, Notice } from '@/components/notice';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import {
  revalidateApiKeyAction,
  setApiKeyStatusAction,
  updateApiKeyMetadataAction,
} from '@/lib/credentials/actions';
import { maskedKey } from '@/lib/credentials/mask';
import { getApiKey } from '@/lib/credentials/repository';
import { describeCredentialStatus } from '@/lib/credentials/status';
import { ENVIRONMENT_LABELS } from '@/lib/projects/schema';
import { getAdapter } from '@/lib/providers/registry';
import { KeyControls, KeyMetadataForm } from './key-controls';

export const dynamic = 'force-dynamic';

function formatTimestamp(date: Date): string {
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export default async function ApiKeyDetailPage({
  params,
  searchParams,
}: PageProps<'/organizations/[organizationId]/keys/[apiKeyId]'>) {
  const { organizationId, apiKeyId } = await params;
  const { registered } = await searchParams;

  const access = await requireOrgAccess(organizationId);

  // Scoped by organization: another tenant's key id resolves to nothing.
  const key = await getApiKey(organizationId, apiKeyId);
  if (!key) notFound();

  const canManage = hasPermission(access.role, 'api_keys:manage');
  const adapter = getAdapter(key.provider.type);
  const view = describeCredentialStatus(key.status, key.lastValidationOutcome);
  const base = `/organizations/${organizationId}`;

  const needsAttributionId =
    adapter.capabilities.usage === 'organization_admin' && !key.providerKeyId;

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          href={`${base}/keys`}
          className="w-fit text-xs text-faint transition-colors hover:text-muted"
        >
          ← API keys
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{key.keyName}</h1>
            <p className="font-mono text-sm text-muted">
              {key.provider.name} · {maskedKey(key.keyLast4)}
            </p>
          </div>
          <CredentialStatusBadge view={view} />
        </div>
      </header>

      {registered === 'valid' ? (
        <Notice tone="info" title="Key saved and validated">
          {key.provider.name} accepted this key. It is stored encrypted, and only its last four
          characters will be shown from now on.
        </Notice>
      ) : registered === 'unverified' ? (
        <Notice
          tone="problem"
          title="Saved, but not verified"
          elsewhere={key.lastValidationDetail ?? undefined}
        >
          {key.provider.name} did not confirm this key — it may have been unavailable or rate
          limiting, or the key may be restricted from the check that was used. It is stored
          encrypted; use <strong className="font-medium text-foreground">Check again</strong> once
          the provider is reachable.
        </Notice>
      ) : null}

      <div className="bezel rounded-shell p-1.5">
        <dl className="glass rounded-core divide-y divide-hairline">
          <Row label="Project">
            <Link
              href={`${base}/projects/${key.project.id}`}
              className="underline-offset-4 hover:underline"
            >
              {key.project.name}
            </Link>
          </Row>
          <Row label="Provider">{key.provider.name}</Row>
          <Row label="Key">
            <span className="font-mono">{maskedKey(key.keyLast4)}</span>
          </Row>
          <Row label="Environment">{ENVIRONMENT_LABELS[key.environment]}</Row>
          {key.baseUrl ? (
            <Row label="Endpoint">
              <span className="break-all font-mono text-xs">{key.baseUrl}</span>
            </Row>
          ) : null}
          <Row label={`${key.provider.name} key ID`}>
            {key.providerKeyId ? (
              <span className="font-mono text-xs">{key.providerKeyId}</span>
            ) : (
              <span className="text-faint">—</span>
            )}
          </Row>
          <Row label="Last checked">
            {key.lastValidatedAt ? (
              <span className="flex flex-col items-end gap-0.5">
                <span className="font-mono text-xs">{formatTimestamp(key.lastValidatedAt)}</span>
                <span className="text-xs text-faint">{view.description}</span>
              </span>
            ) : (
              <span className="text-faint">Never</span>
            )}
          </Row>
          {key.lastValidationDetail && registered !== 'unverified' ? (
            <Row label="Provider said">
              <span className="max-w-md text-right text-xs text-muted">
                {key.lastValidationDetail}
              </span>
            </Row>
          ) : null}
        </dl>
      </div>

      {needsAttributionId ? (
        <InlineNotice tone="limited">
          <strong className="font-medium text-foreground">Usage cannot be attributed yet.</strong>{' '}
          {key.provider.name} reports usage for the whole organization, labelled with its own ID for
          each key. Add this key&apos;s {key.provider.name} key ID below so its usage can be
          credited to {key.project.name}.
        </InlineNotice>
      ) : null}

      <InlineNotice tone="info">{adapter.capabilities.notes}</InlineNotice>

      {canManage ? (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="px-1 text-xs font-medium uppercase tracking-[0.14em] text-faint">
              Actions
            </h2>
            <KeyControls
              apiKeyId={key.id}
              status={key.status}
              onCheck={revalidateApiKeyAction.bind(null, organizationId)}
              onSetStatus={setApiKeyStatusAction.bind(null, organizationId)}
            />
          </section>

          {key.status !== 'revoked' ? (
            <section className="flex flex-col gap-3">
              <h2 className="px-1 text-xs font-medium uppercase tracking-[0.14em] text-faint">
                Details
              </h2>
              <KeyMetadataForm
                action={updateApiKeyMetadataAction.bind(null, organizationId, key.id)}
                defaults={{
                  keyName: key.keyName,
                  environment: key.environment,
                  providerKeyId: key.providerKeyId ?? '',
                }}
                providerName={key.provider.name}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
      <dt className="shrink-0 text-sm text-muted">{label}</dt>
      <dd className="text-right text-sm">{children}</dd>
    </div>
  );
}
