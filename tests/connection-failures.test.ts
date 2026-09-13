import { describe, expect, it } from 'vitest';

import { describeConnectionFailure } from '@/lib/databases/connection';
import { checkConnection } from '@/lib/databases/service';

/**
 * Naming the ways a connection to a monitored database fails.
 *
 * The build plan singles out `FATAL: sorry, too many clients already` as a
 * failure that must be easy to identify. Raw driver messages are the worst part
 * of diagnosing an outage: `ECONNREFUSED` and `ETIMEDOUT` look alike to someone
 * who has not met them, and mean opposite things.
 */

/** A PostgreSQL error as the driver throws it. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A Node system error. */
function systemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('naming a connection failure', () => {
  it('names a server that has run out of connection slots', () => {
    const detail = describeConnectionFailure(pgError('53300', 'sorry, too many clients already'));

    expect(detail).toContain('no connection slots left');
    expect(detail).toContain('max_connections');
    // The original text survives, so nothing is hidden from the operator.
    expect(detail).toContain('too many clients already');
  });

  it('distinguishes a refused connection from one that never answered', () => {
    const refused = describeConnectionFailure(
      systemError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:5432')
    );
    const silent = describeConnectionFailure(
      systemError('ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.5:5432')
    );

    expect(refused).toContain('Nothing is listening');
    expect(silent).toContain('did not answer');
    expect(silent).toContain('firewall');
  });

  it.each([
    ['28P01', 'password authentication failed', 'password for this role was rejected'],
    ['28000', 'no pg_hba.conf entry for host', 'pg_hba.conf'],
    ['3D000', 'database "app" does not exist', 'does not exist'],
  ])('names SQLSTATE %s', (code, message, expected) => {
    expect(describeConnectionFailure(pgError(code, message))).toContain(expected);
  });

  it('names a host that does not resolve, and a failed TLS handshake', () => {
    expect(
      describeConnectionFailure(systemError('ENOTFOUND', 'getaddrinfo ENOTFOUND db.internal'))
    ).toContain('could not be resolved');

    expect(
      describeConnectionFailure(new Error('self-signed certificate in certificate chain'))
    ).toContain('TLS handshake failed');
  });

  it('finds the SQLSTATE through a wrapping error', () => {
    const wrapped = new Error('Failed query', {
      cause: pgError('53300', 'sorry, too many clients already'),
    });

    expect(describeConnectionFailure(wrapped)).toContain('max_connections');
  });

  it('never repeats a connection string or the role name', () => {
    const detail = describeConnectionFailure(
      pgError(
        '28P01',
        'password authentication failed for user observability at postgresql://observability:hunter2@db:5432/app'
      ),
      { username: 'observability' }
    );

    expect(detail).not.toContain('hunter2');
    expect(detail).not.toContain('observability');
  });
});

describe('what a connection check concludes', () => {
  const input = {
    host: 'db.internal',
    port: 5432,
    databaseName: 'app',
    username: 'observability',
    sslEnabled: true,
  };

  function failingWith(error: Error) {
    return async () => {
      throw error;
    };
  }

  it('rejects a credential the server refused', async () => {
    const check = await checkConnection(
      input,
      { password: 'x' },
      failingWith(pgError('28P01', 'password authentication failed'))
    );

    // Saving a credential already known not to work would be pure noise later.
    expect(check.outcome).toBe('rejected');
  });

  it('treats a full server as unreachable, not as a bad credential', async () => {
    const check = await checkConnection(
      input,
      { password: 'x' },
      failingWith(pgError('53300', 'sorry, too many clients already'))
    );

    // A database at capacity is exactly the kind worth registering and watching.
    expect(check.outcome).toBe('unreachable');
    expect(check.detail).toContain('max_connections');
  });

  it('treats a network failure as unreachable', async () => {
    const check = await checkConnection(
      input,
      { password: 'x' },
      failingWith(systemError('ECONNREFUSED', 'connect ECONNREFUSED'))
    );

    expect(check.outcome).toBe('unreachable');
    expect(check.status).toBe('unknown');
  });
});
