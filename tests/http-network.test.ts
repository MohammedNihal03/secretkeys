import { describe, expect, it } from 'vitest';

import { describeNetworkError } from '@/lib/providers/http';

/**
 * Node's fetch reports every transport failure as "fetch failed". These pin the
 * translation of the underlying cause into something an administrator can act on.
 */

function fetchFailure(code?: string): Error {
  return Object.assign(new TypeError('fetch failed'), code ? { cause: { code } } : {});
}

describe('describeNetworkError', () => {
  it.each([
    ['ENOTFOUND', /host name could not be resolved/],
    ['EAI_AGAIN', /host name could not be resolved/],
    ['ECONNREFUSED', /refused the connection/],
    ['ECONNRESET', /connection was reset/],
    ['UND_ERR_CONNECT_TIMEOUT', /timed out/],
    ['CERT_HAS_EXPIRED', /TLS certificate/],
  ])('explains %s', (code, pattern) => {
    expect(describeNetworkError(fetchFailure(code))).toMatch(pattern);
  });

  it('never returns the bare "fetch failed" for a known cause', () => {
    expect(describeNetworkError(fetchFailure('ENOTFOUND'))).not.toBe('fetch failed');
  });

  it('keeps an unknown code visible alongside the message', () => {
    expect(describeNetworkError(fetchFailure('EWEIRD'))).toBe('fetch failed (EWEIRD)');
  });

  it('falls back to the message when there is no cause', () => {
    expect(describeNetworkError(fetchFailure())).toBe('fetch failed');
    expect(describeNetworkError('not an error')).toBe('network error');
  });

  it('scrubs a key-shaped value out of an unexpected message', () => {
    const error = Object.assign(new Error('failed for sk-abcdefghijklmnop'), { cause: {} });
    expect(describeNetworkError(error)).not.toContain('sk-abcdefghijklmnop');
  });
});
