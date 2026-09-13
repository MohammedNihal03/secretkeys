/**
 * HTTP security headers.
 *
 * Kept free of any server-only import so `next.config.ts` and `proxy.ts` can
 * both use it, and so the policy itself is unit-testable as plain strings.
 *
 * Two layers, because they have different lifetimes:
 *
 * - **Static headers** never change per request, so they are set once in
 *   `next.config.ts` and apply to every response, API routes included.
 * - **The Content Security Policy** carries a per-request nonce, so it is built
 *   in `proxy.ts` for every page request. Next.js reads the nonce back out of
 *   the request's CSP header and stamps it on its own script tags.
 */

export interface CspOptions {
  /** A fresh, unguessable value for every request. */
  nonce: string;
  isDev: boolean;
}

/**
 * The Content Security Policy.
 *
 * **Scripts are strict**: only scripts carrying this request's nonce run, and
 * `'strict-dynamic'` extends that trust to what those scripts load. An injected
 * `<script>` has no nonce and does not execute, which is what turns an HTML
 * injection bug from an account takeover into a cosmetic one.
 *
 * **Styles allow inline**, deliberately. The interface sets `style` attributes
 * for data-driven sizes and colours -- a bar's height, a status token -- and a
 * nonce cannot apply to an attribute. The alternative is `'unsafe-inline'` for
 * styles or rewriting every chart, and CSS cannot execute script, so the XSS
 * protection this policy exists for is unaffected.
 *
 * `'unsafe-eval'` and websocket connections are added only in development,
 * where React uses `eval` to rebuild server error stacks and the dev server
 * pushes updates over a socket. Neither is present in a production build.
 */
export function buildContentSecurityPolicy({ nonce, isDev }: CspOptions): string {
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])],
    ],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    // `data:` covers the inline SVG chevron in the stylesheet.
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...(isDev ? ['ws:', 'wss:'] : [])]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    // Forms may only post back here, so an injected form cannot exfiltrate a password.
    ['form-action', ["'self'"]],
    // The dashboard is never framed, which removes clickjacking entirely.
    ['frame-ancestors', ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** A nonce for one request: 128 random bits, base64. */
export function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}

export interface StaticHeader {
  key: string;
  value: string;
}

/**
 * Headers that are the same on every response.
 *
 * HSTS is production-only and deliberately has no `includeSubDomains`: this
 * is self-hosted software, and pinning every subdomain of an operator's domain
 * to HTTPS for a year is a decision about their infrastructure, not ours.
 * Browsers ignore HSTS over plain HTTP, so a LAN deployment is unaffected.
 */
export function staticSecurityHeaders(isProduction: boolean): StaticHeader[] {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // Superseded by `frame-ancestors`, kept for browsers that predate CSP 2.
    { key: 'X-Frame-Options', value: 'DENY' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ...(isProduction ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
  ];
}
