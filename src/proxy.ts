import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME } from '@/lib/auth/cookies';
import { buildContentSecurityPolicy, generateNonce } from '@/lib/security/headers';

/**
 * Per-request security policy, and optimistic route protection.
 *
 * Two jobs:
 *
 * 1. **A Content Security Policy with a fresh nonce on every page.** Next.js
 *    reads the nonce from the request's CSP header during rendering and stamps
 *    it on its own scripts, so only those run. This includes the sign-in page,
 *    which is the page an attacker would most like to inject into.
 *
 * 2. **Redirecting a request with no session cookie to sign-in.** IMPORTANT:
 *    this is not the security boundary. It only checks that a cookie is
 *    *present*; a forged one passes here and is rejected by the guards in
 *    `src/lib/auth/guards.ts`, which do the real validation. The point is to
 *    avoid rendering a page that would only redirect.
 *
 * API routes are excluded: a machine client should receive a 401 JSON body from
 * the route handler, not a redirect to an HTML page, and JSON needs no CSP.
 */

const LOGIN_PATH = '/login';

export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
  });

  const { pathname, search } = request.nextUrl;
  const isLogin = pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`);

  if (!isLogin && !request.cookies.has(SESSION_COOKIE_NAME)) {
    const loginUrl = new URL(LOGIN_PATH, request.url);
    // Preserve where the user was heading. `guards.ts` validates this value
    // before using it, so it cannot become an open redirect.
    loginUrl.searchParams.set('next', `${pathname}${search}`);

    const redirect = NextResponse.redirect(loginUrl);
    redirect.headers.set('Content-Security-Policy', policy);
    return redirect;
  }

  // The nonce travels on the request so rendering can find it...
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // ...and on the response so the browser enforces it.
  response.headers.set('Content-Security-Policy', policy);

  return response;
}

export const config = {
  /**
   * Every page, including sign-in. Excluded: API routes, Next.js build assets,
   * and any path with a file extension.
   *
   * Static files must be excluded or an unauthenticated request for the sign-in
   * page's own stylesheet and images would be redirected to sign-in.
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)'],
};
