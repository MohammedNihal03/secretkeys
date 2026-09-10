import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME } from '@/lib/auth/cookies';

/**
 * Optimistic route protection.
 *
 * IMPORTANT: this is not the security boundary. It only checks whether a
 * session cookie is *present*, which is cheap and requires no database -- proxy
 * code runs separately from render code and may be deployed to a CDN edge.
 * A forged cookie passes this check and is then rejected by the guards in
 * `src/lib/auth/guards.ts`, which do the real validation.
 *
 * The purpose is to avoid rendering a page that would only redirect, and to
 * carry the intended destination through sign-in.
 *
 * API routes are excluded: a machine client should receive a 401 JSON body from
 * the route handler, not a redirect to an HTML login page. Route handlers
 * authorize themselves via `src/lib/api/authorize.ts`.
 */

const LOGIN_PATH = '/login';

export function proxy(request: NextRequest) {
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);
  if (hasSessionCookie) return NextResponse.next();

  const { pathname, search } = request.nextUrl;

  const loginUrl = new URL(LOGIN_PATH, request.url);
  // Preserve where the user was heading. `guards.ts` validates this value
  // before using it, so it cannot become an open redirect.
  loginUrl.searchParams.set('next', `${pathname}${search}`);

  return NextResponse.redirect(loginUrl);
}

export const config = {
  /**
   * Everything except the sign-in page, API routes, and static assets.
   *
   * Without excluding `_next` and static files, this would redirect CSS and
   * JavaScript requests too and break the sign-in page it redirects to.
   */
  matcher: ['/((?!api|login|_next/static|_next/image|favicon.ico).*)'],
};
