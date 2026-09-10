import type { ReactNode } from 'react';

/**
 * The message shown when there is nothing useful to display.
 *
 * These states are load-bearing in an observability tool. "No data" can mean
 * three very different things -- nothing is configured, nothing has been
 * collected yet, or the provider genuinely cannot tell us -- and conflating
 * them is how someone concludes the system is broken when it is working, or
 * that everything is fine when it is blind.
 *
 * So each variant says which of those it is, and what to do about it.
 */

export type NoticeTone =
  /** Nothing is configured yet. There is an action to take. */
  | 'empty'
  /** Working as intended, but the provider cannot supply this. Not a fault. */
  | 'limited'
  /** Something is wrong and needs attention. */
  | 'problem'
  /** Neutral context. */
  | 'info';

const TONE = {
  empty: { color: 'var(--accent)', ring: 'oklch(52% 0.19 277 / 0.22)' },
  limited: { color: 'var(--unknown)', ring: 'oklch(65% 0.01 265 / 0.3)' },
  problem: { color: 'var(--warn)', ring: 'oklch(76% 0.16 76 / 0.3)' },
  info: { color: 'var(--muted)', ring: 'oklch(50% 0.015 265 / 0.22)' },
} as const;

function ToneIcon({ tone }: { tone: NoticeTone }) {
  // Ultra-light strokes, sized to sit on the cap height of the title.
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    className: 'size-[1.15rem]',
    'aria-hidden': true,
  };

  if (tone === 'empty') {
    // An empty tray: nothing here yet, by circumstance rather than fault.
    return (
      <svg {...common}>
        <path
          d="M3.5 14.5h4l1.2 2.2h6.6l1.2-2.2h4M3.5 14.5 6.2 6.3A1.6 1.6 0 0 1 7.7 5.2h8.6a1.6 1.6 0 0 1 1.5 1.1l2.7 8.2v3.9a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6Z"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (tone === 'limited') {
    // An eye with a line through it: we cannot see this.
    return (
      <svg {...common}>
        <path
          d="M2.6 12s3.5-6 9.4-6 9.4 6 9.4 6-3.5 6-9.4 6-9.4-6-9.4-6Z"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.1" />
        <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    );
  }

  if (tone === 'problem') {
    return (
      <svg {...common}>
        <path
          d="M12 3.6 21.4 20H2.6L12 3.6Z"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
        <path d="M12 9.5v4.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="12" cy="16.6" r="0.9" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.1" />
      <path d="M12 11v5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="12" cy="7.8" r="0.9" fill="currentColor" />
    </svg>
  );
}

export interface NoticeProps {
  tone?: NoticeTone;
  title: string;
  children?: ReactNode;
  /** A single next step. Omit when there is genuinely nothing to do. */
  action?: ReactNode;
  /**
   * Where the missing information *can* be found, when we cannot show it.
   * Turns a dead end into a redirection.
   */
  elsewhere?: ReactNode;
}

export function Notice({ tone = 'info', title, children, action, elsewhere }: NoticeProps) {
  const { color, ring } = TONE[tone];

  return (
    <div className="bezel rounded-shell p-1.5">
      <div className="glass rounded-core flex flex-col gap-4 px-5 py-6">
        <div className="flex items-start gap-3.5">
          <span
            className="grid size-9 shrink-0 place-items-center rounded-full"
            style={{ color, boxShadow: `inset 0 0 0 1px ${ring}` }}
          >
            <ToneIcon tone={tone} />
          </span>

          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-sm font-medium leading-snug">{title}</h3>
            {children ? (
              <div className="max-w-prose text-sm leading-relaxed text-muted">{children}</div>
            ) : null}
          </div>
        </div>

        {elsewhere ? (
          <p
            className="border-l-2 pl-3.5 text-xs leading-relaxed text-faint"
            style={{ borderColor: ring }}
          >
            {elsewhere}
          </p>
        ) : null}

        {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

/**
 * A compact inline variant, for sitting inside a card that already has a
 * heading rather than replacing a whole view.
 */
export function InlineNotice({
  tone = 'limited',
  children,
}: {
  tone?: NoticeTone;
  children: ReactNode;
}) {
  const { color } = TONE[tone];

  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
      <span className="mt-px shrink-0" style={{ color }}>
        <ToneIcon tone={tone} />
      </span>
      <span>{children}</span>
    </p>
  );
}
