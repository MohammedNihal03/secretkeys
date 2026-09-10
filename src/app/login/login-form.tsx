'use client';

import { useActionState } from 'react';

import { signIn, type SignInState } from '@/lib/auth/actions';

const INITIAL_STATE: SignInState = {};

const FIELD_CLASS =
  'w-full rounded-xl border border-hairline bg-surface-sunken px-3.5 py-2.5 text-sm text-foreground shadow-[inset_0_1px_1px_oklch(0%_0_0/0.04)] outline-none transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] placeholder:text-faint focus:border-hairline-strong';

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(signIn, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="flex flex-col gap-2">
        <label htmlFor="email" className="text-xs font-medium tracking-wide text-muted">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          placeholder="you@company.com"
          className={FIELD_CLASS}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-xs font-medium tracking-wide text-muted">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••••••"
          className={FIELD_CLASS}
        />
      </div>

      {state.error ? (
        // `role="alert"` announces the failure without stealing focus.
        <p
          role="alert"
          className="rounded-xl border px-3.5 py-2.5 text-sm"
          style={{
            borderColor: 'oklch(60% 0.21 22 / 0.3)',
            background: 'oklch(60% 0.21 22 / 0.08)',
            color: 'var(--critical)',
          }}
        >
          {state.error}
        </p>
      ) : null}

      {/* Pill CTA with the arrow nested in its own circle, flush to the padding. */}
      <button
        type="submit"
        disabled={pending}
        className="group mt-1 flex items-center justify-between gap-3 rounded-full bg-foreground py-1.5 pl-6 pr-1.5 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98] disabled:opacity-60"
      >
        <span>{pending ? 'Signing in' : 'Sign in'}</span>
        <span className="grid size-9 place-items-center rounded-full bg-background/15 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:scale-105">
          {pending ? (
            <svg viewBox="0 0 24 24" fill="none" className="size-4 animate-spin" aria-hidden>
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                strokeWidth="1.6"
                opacity="0.25"
              />
              <path
                d="M21 12a9 9 0 0 0-9-9"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden>
              <path
                d="M5 12h13m-5.5-5.5L18 12l-5.5 5.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </button>
    </form>
  );
}
