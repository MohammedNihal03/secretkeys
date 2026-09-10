'use client';

import { useOptimistic, useState, useTransition } from 'react';

import type { ToggleResult } from '@/lib/providers/actions';

/**
 * Switch for tracking a provider.
 *
 * `useOptimistic` flips the switch on the very next paint and lets React
 * reconcile with the server's answer when the transition settles -- so the
 * control feels instant without ever showing a state the server did not
 * confirm. If the action fails, the optimistic value is discarded
 * automatically and the message explains why.
 */

export interface ProviderToggleProps {
  providerId: string;
  displayName: string;
  enabled: boolean;
  /** Absent for a read-only viewer, which renders a static state instead. */
  onToggle?: (providerId: string, enabled: boolean) => Promise<ToggleResult>;
}

export function ProviderToggle({
  providerId,
  displayName,
  enabled,
  onToggle,
}: ProviderToggleProps) {
  const [optimistic, setOptimistic] = useOptimistic(enabled);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  if (!onToggle) {
    return (
      <span
        className="inline-flex items-center gap-2 text-xs"
        style={{ color: enabled ? 'var(--ok)' : 'var(--unknown)' }}
      >
        <span
          className="size-1.5 rounded-full"
          style={{ background: enabled ? 'var(--ok)' : 'var(--unknown)' }}
        />
        {enabled ? 'Tracked' : 'Not tracked'}
      </span>
    );
  }

  function toggle() {
    const next = !optimistic;

    startTransition(async () => {
      setOptimistic(next);
      setError(undefined);

      const result = await onToggle!(providerId, next);
      if (!result.ok) setError(result.error ?? 'Could not save.');
    });
  }

  return (
    <span className="flex items-center gap-2.5">
      {error ? (
        <span role="alert" className="text-xs" style={{ color: 'var(--critical)' }}>
          {error}
        </span>
      ) : null}

      <button
        type="button"
        role="switch"
        aria-checked={optimistic}
        aria-label={`Track ${displayName}`}
        onClick={toggle}
        className="group relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
        style={{
          borderColor: optimistic ? 'transparent' : 'var(--hairline-strong)',
          background: optimistic ? 'var(--ok)' : 'var(--surface-sunken)',
        }}
      >
        {/* The knob. Translated rather than repositioned, so it animates on the GPU. */}
        <span
          className="absolute left-0.5 size-[1.1rem] rounded-full transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-active:scale-90"
          style={{
            background: optimistic ? 'var(--surface-solid)' : 'var(--muted)',
            transform: optimistic ? 'translateX(1.15rem)' : 'translateX(0)',
            boxShadow: '0 1px 2px oklch(0% 0 0 / 0.2)',
          }}
        />
      </button>
    </span>
  );
}

/** Select-all / clear-all, for an organization that wants everything or nothing. */
export function BulkSelect({
  organizationId,
  onSetAll,
}: {
  organizationId: string;
  onSetAll: (organizationId: string, enabled: boolean) => Promise<ToggleResult>;
}) {
  const [pending, startTransition] = useTransition();

  function setAll(enabled: boolean) {
    startTransition(async () => {
      await onSetAll(organizationId, enabled);
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => setAll(true)}
        className="rounded-full border border-hairline bg-shell px-3 py-1.5 text-xs font-medium text-muted transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground active:scale-[0.97] disabled:opacity-50"
      >
        Track all
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setAll(false)}
        className="rounded-full border border-hairline bg-shell px-3 py-1.5 text-xs font-medium text-muted transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground active:scale-[0.97] disabled:opacity-50"
      >
        Clear all
      </button>
    </div>
  );
}
