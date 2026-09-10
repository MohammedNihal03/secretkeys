import type { HealthStatus } from '@/lib/health';

/**
 * The four health states, rendered consistently wherever they appear.
 *
 * Colour is never the only signal -- each state carries a text label too, so
 * the badge is still readable with a colour vision deficiency or in a
 * greyscale print.
 */

const STATUS: Record<HealthStatus, { label: string; token: string }> = {
  healthy: { label: 'Healthy', token: 'var(--ok)' },
  degraded: { label: 'Degraded', token: 'var(--warn)' },
  unhealthy: { label: 'Unhealthy', token: 'var(--critical)' },
  unknown: { label: 'Unknown', token: 'var(--unknown)' },
};

export function StatusBadge({ status }: { status: HealthStatus }) {
  const { label, token } = STATUS[status];

  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium" style={{ color: token }}>
      <span className="relative grid size-2.5 place-items-center">
        {/* A soft halo, so the dot reads as lit rather than painted on. */}
        <span
          className="absolute size-2.5 rounded-full opacity-40 blur-[3px]"
          style={{ background: token }}
        />
        <span className="size-2 rounded-full" style={{ background: token }} />
      </span>
      {label}
    </span>
  );
}
