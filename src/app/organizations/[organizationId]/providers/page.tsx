import { InlineNotice, Notice } from '@/components/notice';
import { requireOrgAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { setAllProvidersAction, toggleProviderAction } from '@/lib/providers/actions';
import { listProviderSelection, type ProviderSelection } from '@/lib/providers/selection';
import type { LimitsSource, UsageSource } from '@/lib/providers/types';
import { BulkSelect, ProviderToggle } from './provider-toggle';

/**
 * Provider selection and capability matrix.
 *
 * Two jobs on one page: choose which providers this organization tracks, and be
 * honest about what each one can actually report. The second matters because
 * providers differ enormously, and an unexplained blank is indistinguishable
 * from a broken dashboard.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Providers' };

const USAGE_LABEL: Record<UsageSource, { text: string; tone: 'yes' | 'partial' | 'no' }> = {
  per_key: { text: 'Per key', tone: 'yes' },
  organization_admin: { text: 'Admin key', tone: 'partial' },
  none: { text: 'Not exposed', tone: 'no' },
};

const LIMITS_LABEL: Record<LimitsSource, { text: string; tone: 'yes' | 'partial' | 'no' }> = {
  endpoint: { text: 'Endpoint', tone: 'yes' },
  response_headers: { text: 'Headers only', tone: 'partial' },
  none: { text: 'Not exposed', tone: 'no' },
};

const TONE_COLOR = { yes: 'var(--ok)', partial: 'var(--warn)', no: 'var(--unknown)' } as const;

const METER_LABEL: Record<string, string> = {
  requests: 'requests',
  tokens: 'tokens',
  characters: 'characters',
  audio_seconds: 'audio',
};

/** Where to look when the provider itself will not tell us. */
const ELSEWHERE: Partial<Record<string, string>> = {
  google_gemini:
    'Token counts and spend for a Gemini API key are visible in Google AI Studio and the Google Cloud console billing reports.',
  groq: 'Usage and spend are visible in the Groq console. Per-request token counts are returned inside each inference response.',
  qwen: 'Usage and spend are visible in the Alibaba Cloud Model Studio console.',
  elevenlabs:
    'Character usage is read here as a quota. A full history is available in the ElevenLabs usage dashboard.',
  deepgram: 'Remaining credit is available from the Deepgram console, or its /balances endpoint.',
  mistral: 'Usage and spend are visible in the Mistral console.',
  azure_openai:
    'Usage and cost for the resource are in Azure Monitor metrics and Azure Cost Management in the Azure portal.',
};

export default async function ProvidersPage({
  params,
}: PageProps<'/organizations/[organizationId]/providers'>) {
  const { organizationId } = await params;
  const access = await requireOrgAccess(organizationId);

  const selection = await listProviderSelection(organizationId);
  const canManage = hasPermission(access.role, 'providers:manage');

  const tracked = selection.filter((entry) => entry.enabled);
  const untracked = selection.filter((entry) => !entry.enabled);

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
          <p className="max-w-prose text-sm text-muted">
            Choose which services this organization tracks. {tracked.length} of {selection.length}{' '}
            selected.
          </p>
        </div>

        {canManage ? (
          <BulkSelect organizationId={organizationId} onSetAll={setAllProvidersAction} />
        ) : null}
      </header>

      {/* Everything switched off is a deliberate state, but a confusing one to
          land on later, so it says so plainly. */}
      {tracked.length === 0 ? (
        <Notice
          tone="empty"
          title="No providers are being tracked"
          action={
            canManage ? (
              <span className="text-sm text-muted">
                Switch on the services you use below, or choose{' '}
                <strong className="font-medium text-foreground">Track all</strong>.
              </span>
            ) : undefined
          }
        >
          Nothing will be collected until at least one provider is selected. Most organizations
          track only the two or three services they actually use — there is no benefit to monitoring
          the rest.
        </Notice>
      ) : null}

      <section className="flex flex-col gap-3">
        {tracked.length > 0 && untracked.length > 0 ? (
          <h2 className="px-1 text-xs font-medium uppercase tracking-[0.14em] text-faint">
            Tracked
          </h2>
        ) : null}

        {tracked.map((entry) => (
          <ProviderCard
            key={entry.providerId}
            entry={entry}
            organizationId={organizationId}
            canManage={canManage}
          />
        ))}
      </section>

      {untracked.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="px-1 text-xs font-medium uppercase tracking-[0.14em] text-faint">
            Not tracked
          </h2>
          {untracked.map((entry) => (
            <ProviderCard
              key={entry.providerId}
              entry={entry}
              organizationId={organizationId}
              canManage={canManage}
              dimmed
            />
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-2 border-t border-hairline pt-6">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-faint">
          Reading this table
        </h2>
        <ul className="flex max-w-prose flex-col gap-1.5 text-sm text-muted">
          <li>
            <strong className="font-medium text-foreground">Per key</strong> — readable with the
            project&apos;s own API key.
          </li>
          <li>
            <strong className="font-medium text-foreground">Admin key</strong> — readable only with
            a separate organization admin credential, and reported for the whole organization
            grouped by the provider&apos;s key id.
          </li>
          <li>
            <strong className="font-medium text-foreground">Headers only</strong> — limits appear
            solely on responses to real API calls, so they cannot be polled independently.
          </li>
          <li>
            <strong className="font-medium text-foreground">Not exposed</strong> — the provider has
            no such API. Recorded as unavailable, never as zero.
          </li>
        </ul>
      </section>
    </div>
  );
}

function ProviderCard({
  entry,
  organizationId,
  canManage,
  dimmed,
}: {
  entry: ProviderSelection;
  organizationId: string;
  canManage: boolean;
  dimmed?: boolean;
}) {
  const { adapter } = entry;
  const usage = USAGE_LABEL[adapter.capabilities.usage];
  const cost = USAGE_LABEL[adapter.capabilities.cost];
  const limits = LIMITS_LABEL[adapter.capabilities.limits];

  /**
   * A provider that reports no usage, no cost and no limits can only be
   * monitored for reachability. Saying so is the difference between an
   * informed operator and a bug report.
   */
  const reportsNothing =
    adapter.capabilities.usage === 'none' &&
    adapter.capabilities.cost === 'none' &&
    adapter.capabilities.limits === 'none';

  const boundToggle = canManage ? toggleProviderAction.bind(null, organizationId) : undefined;

  return (
    <article
      className="bezel rounded-shell p-1.5 transition-opacity duration-500"
      style={dimmed ? { opacity: 0.55 } : undefined}
    >
      <div className="glass rounded-core flex flex-col gap-3.5 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-medium">{adapter.displayName}</h3>
            <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-faint">
              {adapter.category === 'llm' ? 'LLM' : 'Speech'}
            </span>
          </div>

          <ProviderToggle
            providerId={entry.providerId}
            displayName={adapter.displayName}
            enabled={entry.enabled}
            onToggle={boundToggle}
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Capability label="Usage" {...usage} />
          <Capability label="Cost" {...cost} />
          <Capability label="Limits" {...limits} />
        </div>

        {reportsNothing ? (
          <InlineNotice tone="limited">
            <strong className="font-medium text-foreground">
              Only reachability can be monitored.
            </strong>{' '}
            {adapter.displayName} publishes no usage, cost or quota API, so this dashboard can
            confirm the credential works and the service is responding — nothing more.
            {ELSEWHERE[adapter.type] ? ` ${ELSEWHERE[adapter.type]}` : ''}
          </InlineNotice>
        ) : (
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            {adapter.capabilities.notes}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.12em] text-faint">Meters</span>
          {adapter.capabilities.meters.map((meter) => (
            <span
              key={meter}
              className="rounded-full bg-shell px-2 py-0.5 font-mono text-[10px] text-muted"
            >
              {METER_LABEL[meter] ?? meter}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

function Capability({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: 'yes' | 'partial' | 'no';
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.12em] text-faint">{label}</span>
      <span
        className="inline-flex items-center gap-1.5 text-xs"
        style={{ color: TONE_COLOR[tone] }}
      >
        <span className="size-1.5 rounded-full" style={{ background: TONE_COLOR[tone] }} />
        {text}
      </span>
    </div>
  );
}
