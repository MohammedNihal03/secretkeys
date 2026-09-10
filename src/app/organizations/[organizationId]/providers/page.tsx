import { requireOrgAccess } from '@/lib/auth/guards';
import { listAdapters } from '@/lib/providers/registry';
import type { AIProviderAdapter, LimitsSource, UsageSource } from '@/lib/providers/types';

/**
 * Provider capability matrix.
 *
 * The most useful page at this phase, because it answers the question an
 * administrator will otherwise ask as a bug report: "why is there no cost for
 * Gemini?" Providers differ enormously, and stating the limitation up front is
 * the alternative to showing a plausible-looking zero.
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

const TONE_COLOR = {
  yes: 'var(--ok)',
  partial: 'var(--warn)',
  no: 'var(--unknown)',
} as const;

const METER_LABEL: Record<string, string> = {
  requests: 'requests',
  tokens: 'tokens',
  characters: 'characters',
  audio_seconds: 'audio',
};

export default async function ProvidersPage({
  params,
}: PageProps<'/organizations/[organizationId]/providers'>) {
  const { organizationId } = await params;
  await requireOrgAccess(organizationId);

  const adapters = listAdapters();

  return (
    <div className="animate-rise flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
        <p className="max-w-prose text-sm text-muted">
          What each provider actually lets us read. These differ substantially — where a metric is
          not exposed it is recorded as unavailable, never as zero.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        {adapters.map((adapter) => (
          <ProviderCard key={adapter.type} adapter={adapter} />
        ))}
      </div>

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
        </ul>
      </section>
    </div>
  );
}

function ProviderCard({ adapter }: { adapter: AIProviderAdapter }) {
  const usage = USAGE_LABEL[adapter.capabilities.usage];
  const cost = USAGE_LABEL[adapter.capabilities.cost];
  const limits = LIMITS_LABEL[adapter.capabilities.limits];

  return (
    <article className="bezel rounded-shell p-1.5">
      <div className="glass rounded-core flex flex-col gap-4 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-medium">{adapter.displayName}</h3>
            <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-faint">
              {adapter.category === 'llm' ? 'LLM' : 'Speech'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Capability label="Usage" {...usage} />
            <Capability label="Cost" {...cost} />
            <Capability label="Limits" {...limits} />
          </div>
        </div>

        <p className="max-w-prose text-xs leading-relaxed text-muted">
          {adapter.capabilities.notes}
        </p>

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
