/**
 * Theme preference: shared constants.
 *
 * This module must stay free of server-only imports. The theme toggle is a
 * client component and needs the cookie name, so anything importing
 * `next/headers` belongs in `theme-server.ts` instead.
 *
 * The cookie is deliberately not httpOnly, unlike the session cookie: the
 * toggle rewrites it from the client for an instant switch, and a colour
 * preference is not a secret.
 */

export const THEME_COOKIE_NAME = 'observability_theme';
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type Theme = 'light' | 'dark';

export function isTheme(value: string | undefined): value is Theme {
  return value === 'light' || value === 'dark';
}
