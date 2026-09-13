import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE_NAME } from '@/lib/auth/cookies';
import {
  buildContentSecurityPolicy,
  generateNonce,
  staticSecurityHeaders,
} from '@/lib/security/headers';
import { config, proxy } from '@/proxy';

/**
 * HTTP security headers and the per-request Content Security Policy.
 *
 * What is protected here is the policy's strictness on scripts -- the part that
 * turns an HTML injection bug into a harmless one -- and the proxy applying it
 * to every page, including the sign-in page an attacker would most like to
 * inject into.
 */

function directive(policy: string, name: string): string[] {
  const entry = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));

  return entry ? entry.split(/\s+/).slice(1) : [];
}

describe('the content security policy', () => {
  const production = buildContentSecurityPolicy({ nonce: 'abc123', isDev: false });

  it('runs only scripts carrying this request’s nonce', () => {
    const scripts = directive(production, 'script-src');

    expect(scripts).toContain("'nonce-abc123'");
    expect(scripts).toContain("'strict-dynamic'");
    // Either of these would let an injected script run.
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it('forbids framing, plugins, foreign form targets and base rewriting', () => {
    expect(directive(production, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(production, 'object-src')).toEqual(["'none'"]);
    expect(directive(production, 'form-action')).toEqual(["'self'"]);
    expect(directive(production, 'base-uri')).toEqual(["'self'"]);
  });

  it('adds eval and dev-server sockets only in development', () => {
    const development = buildContentSecurityPolicy({ nonce: 'abc123', isDev: true });

    expect(directive(development, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(development, 'connect-src')).toContain('ws:');
    expect(directive(production, 'connect-src')).toEqual(["'self'"]);
  });

  it('generates a different nonce every time', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
  });
});

describe('static headers', () => {
  const byKey = (isProduction: boolean) =>
    new Map(staticSecurityHeaders(isProduction).map((header) => [header.key, header.value]));

  it('sets the baseline protections on every response', () => {
    const headers = byKey(false);

    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headers.get('Permissions-Policy')).toContain('camera=()');
  });

  it('sends HSTS only in production, and never for every subdomain', () => {
    expect(byKey(false).has('Strict-Transport-Security')).toBe(false);

    // Pinning an operator's whole domain to HTTPS is not this app's decision.
    const hsts = byKey(true).get('Strict-Transport-Security');
    expect(hsts).toBe('max-age=31536000');
    expect(hsts).not.toContain('includeSubDomains');
  });
});

describe('the proxy', () => {
  function request(path: string, withSession = false): NextRequest {
    return new NextRequest(`http://localhost${path}`, {
      headers: withSession ? { cookie: `${SESSION_COOKIE_NAME}=token` } : {},
    });
  }

  function nonceOf(policy: string | null): string | undefined {
    return policy?.match(/'nonce-([^']+)'/)?.[1];
  }

  it('puts a nonce policy on the sign-in page without redirecting it', () => {
    const response = proxy(request('/login'));
    const policy = response.headers.get('Content-Security-Policy');

    expect(response.headers.get('location')).toBeNull();
    expect(nonceOf(policy)).toBeTruthy();
  });

  it('forwards the same nonce to rendering that it sends to the browser', () => {
    const response = proxy(request('/organizations/1', true));
    const nonce = nonceOf(response.headers.get('Content-Security-Policy'));

    // Next.js carries overridden request headers on these response headers.
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toContain(
      `'nonce-${nonce}'`
    );
  });

  it('redirects a page request with no session cookie, preserving the destination', () => {
    const response = proxy(request('/organizations/1/alerts?x=1'));
    const location = new URL(response.headers.get('location') ?? '', 'http://localhost');

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/organizations/1/alerts?x=1');
    // Even the redirect carries the policy.
    expect(response.headers.get('Content-Security-Policy')).toContain('nonce-');
  });

  it('issues a fresh nonce per request', () => {
    const first = nonceOf(proxy(request('/login')).headers.get('Content-Security-Policy'));
    const second = nonceOf(proxy(request('/login')).headers.get('Content-Security-Policy'));

    expect(first).not.toBe(second);
  });

  it('runs on pages and sign-in, but not on API routes or static files', () => {
    // The matcher, as the regular expression Next.js compiles it to.
    const [source] = config.matcher;
    const matcher = new RegExp(`^${source}$`);

    expect(matcher.test('/login')).toBe(true);
    expect(matcher.test('/organizations/abc/databases')).toBe(true);
    expect(matcher.test('/api/health')).toBe(false);
    expect(matcher.test('/_next/static/chunks/app.js')).toBe(false);
    // A stylesheet the sign-in page needs must never be redirected to sign-in.
    expect(matcher.test('/brand/openai.svg')).toBe(false);
  });
});
