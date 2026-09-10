import { cookies } from 'next/headers';

import { THEME_COOKIE_NAME, isTheme, type Theme } from './theme';

/**
 * Reads the stored theme on the server.
 *
 * Rendering the result into the first HTML response is what prevents the flash
 * of the wrong theme that a client-side-only toggle produces.
 */

/**
 * The user's explicit choice, or `undefined` to follow the system.
 *
 * `undefined` is a real state, not a fallback -- it means no `data-theme`
 * attribute is rendered and `prefers-color-scheme` decides. Defaulting this to
 * `'light'` would override the system preference for everyone who has never
 * touched the toggle.
 */
export async function readThemePreference(): Promise<Theme | undefined> {
  const value = (await cookies()).get(THEME_COOKIE_NAME)?.value;
  return isTheme(value) ? value : undefined;
}
