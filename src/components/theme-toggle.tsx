'use client';

import { THEME_COOKIE_MAX_AGE, THEME_COOKIE_NAME } from '@/lib/theme';

/**
 * Light/dark toggle.
 *
 * Writes the cookie and flips `data-theme` on <html> in the same click, so the
 * change is instant with no round trip, and the next server render already
 * agrees with what the user sees.
 *
 * Both icons are always rendered and CSS reveals the right one -- see
 * `.only-light` / `.only-dark`. Picking in JS would require knowing the system
 * preference, which the server cannot, producing a flicker on first paint.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  function toggle() {
    const root = document.documentElement;

    /**
     * Resolve what is on screen right now. An explicit choice wins; otherwise
     * ask the media query, because no attribute means "follow the system".
     */
    const explicit = root.dataset.theme;
    const current =
      explicit === 'dark' || explicit === 'light'
        ? explicit
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';

    const next = current === 'dark' ? 'light' : 'dark';

    root.dataset.theme = next;
    document.cookie = `${THEME_COOKIE_NAME}=${next}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle colour theme"
      className={`group grid size-9 place-items-center rounded-full border border-hairline bg-shell text-muted transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground active:scale-[0.94] ${className}`}
    >
      {/* Sun -- shown while light is active, i.e. click for dark. */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="only-light size-[1.05rem] transition-transform duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:rotate-45"
        aria-hidden
      >
        <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.1" />
        <path
          d="M12 2.2v2.1M12 19.7v2.1M2.2 12h2.1M19.7 12h2.1M5.1 5.1l1.5 1.5M17.4 17.4l1.5 1.5M18.9 5.1l-1.5 1.5M6.6 17.4l-1.5 1.5"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>

      {/* Moon -- shown while dark is active. */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="only-dark size-[1.05rem] transition-transform duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-rotate-12"
        aria-hidden
      >
        <path
          d="M20.4 14.6A8.6 8.6 0 0 1 9.4 3.6a8.8 8.8 0 1 0 11 11Z"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
