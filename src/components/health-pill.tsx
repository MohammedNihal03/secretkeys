import { LEVEL_LABELS, type HealthLevel } from '@/lib/evaluation/engine';

/**
 * The four evaluated states, rendered identically wherever they appear.
 *
 * Distinct from `StatusBadge`, which shows a *collector's* observation
 * (healthy / degraded / unhealthy / unknown). This one shows a *judgement* from
 * the evaluation engine, and the vocabulary differs on purpose: "warning" is a
 * threshold decision, "degraded" is something a provider told us.
 *
 * Colour is never the only signal. Every pill carries its word, so it survives
 * a colour vision deficiency and a greyscale print.
 */

const TOKEN: Record<HealthLevel, string> = {
  healthy: 'var(--ok)',
  warning: 'var(--warn)',
  critical: 'var(--critical)',
  unknown: 'var(--unknown)',
};

export function HealthPill({ level, size = 'md' }: { level: HealthLevel; size?: 'sm' | 'md' }) {
  const token = TOKEN[level];

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-medium ${
        size === 'sm' ? 'py-0.5 text-[11px]' : 'py-1 text-xs'
      }`}
      style={{
        color: token,
        borderColor: 'color-mix(in oklch, currentColor 28%, transparent)',
        background: 'color-mix(in oklch, currentColor 8%, transparent)',
      }}
    >
      <span className="relative grid size-2 place-items-center">
        {/* A soft halo, so the dot reads as lit rather than painted on. */}
        <span
          className="absolute size-2 rounded-full opacity-45 blur-[2.5px]"
          style={{ background: token }}
        />
        <span className="size-1.5 rounded-full" style={{ background: token }} />
      </span>
      {LEVEL_LABELS[level]}
    </span>
  );
}

/** The same four states as a bare dot, for dense rows where a word will not fit. */
export function HealthDot({ level, title }: { level: HealthLevel; title: string }) {
  return (
    <span
      className="relative grid size-2.5 shrink-0 place-items-center"
      title={title}
      role="img"
      aria-label={`${LEVEL_LABELS[level]}: ${title}`}
    >
      <span
        className="absolute size-2.5 rounded-full opacity-40 blur-[3px]"
        style={{ background: TOKEN[level] }}
      />
      <span className="size-2 rounded-full" style={{ background: TOKEN[level] }} />
    </span>
  );
}
