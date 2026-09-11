import type { CredentialStatusView } from '@/lib/credentials/status';

/**
 * A credential's state, using the same four colours as health so the dashboard
 * reads consistently -- but with its own label, because "Validated" and
 * "Healthy" are different claims and this one is all that is known yet.
 */

const TONE_COLOR = {
  healthy: 'var(--ok)',
  degraded: 'var(--warn)',
  unhealthy: 'var(--critical)',
  unknown: 'var(--unknown)',
} as const;

export function CredentialStatusBadge({ view }: { view: CredentialStatusView }) {
  const color = TONE_COLOR[view.tone];

  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium"
      style={{ color }}
      title={view.description}
    >
      <span className="relative grid size-2.5 place-items-center">
        <span
          className="absolute size-2.5 rounded-full opacity-40 blur-[3px]"
          style={{ background: color }}
        />
        <span className="size-2 rounded-full" style={{ background: color }} />
      </span>
      {view.label}
    </span>
  );
}
