import type { ReactNode } from 'react';

/**
 * A single number, or an honest account of why there isn't one.
 *
 * This is the component that carries the project's central rule into the UI.
 * A metric with no value renders as a dash and the reason, never as `0` and
 * never as blank space, because both of those read as "the figure is zero" to
 * anyone glancing at a dashboard.
 *
 * Numbers are set in the mono face so columns of them line up by digit, which
 * is what makes a change in magnitude visible at a glance.
 */

export interface MetricProps {
  label: string;
  /** The formatted value. Null means the figure does not exist. */
  value: string | null;
  /** Why the value is missing. Shown in place of the number. */
  reason?: string | null;
  /** Shown under the value when it exists: a unit, a comparison, a count. */
  note?: ReactNode;
  align?: 'start' | 'end';
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: 'text-base',
  md: 'text-xl',
  lg: 'text-3xl',
} as const;

export function Metric({ label, value, reason, note, align = 'start', size = 'md' }: MetricProps) {
  return (
    <div className={`flex flex-col gap-1 ${align === 'end' ? 'items-end text-right' : ''}`}>
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">
        {label}
      </span>

      {value === null ? (
        <>
          <span
            className={`font-mono ${SIZES[size]} leading-none text-faint`}
            aria-hidden
            title={reason ?? undefined}
          >
            &ndash;
          </span>
          {reason ? (
            <span className="max-w-[28ch] text-[11px] leading-snug text-faint">{reason}</span>
          ) : null}
        </>
      ) : (
        <>
          <span className={`font-mono ${SIZES[size]} font-medium leading-none tabular-nums`}>
            {value}
          </span>
          {note ? <span className="text-[11px] leading-snug text-faint">{note}</span> : null}
        </>
      )}
    </div>
  );
}

/**
 * Formatting helpers, kept beside the component that uses them so a number is
 * never formatted two different ways on two different pages.
 */

export function formatCount(value: number | null): string | null {
  if (value === null) return null;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString('en-US');
}

export function formatUsd(value: number | null): string | null {
  if (value === null) return null;

  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    // Sub-cent costs are real at per-request prices, so they are not rounded away.
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  });
}

export function formatBytes(value: number | null): string | null {
  if (value === null) return null;

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = Math.abs(value);
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${value < 0 ? '-' : ''}${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatMs(value: number | null): string | null {
  if (value === null) return null;
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

/** "4 minutes ago", from a timestamp. Null when nothing has happened yet. */
export function formatAgo(at: Date | null, now = new Date()): string | null {
  if (!at) return null;

  const seconds = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));

  if (seconds < 60) return 'just now';
  if (seconds < 3_600) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3_600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.round(seconds / 86_400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
