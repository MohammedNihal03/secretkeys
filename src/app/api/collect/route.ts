import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { runCollection } from '@/lib/collector/runner';
import { getEnv } from '@/lib/env';

/**
 * Trigger endpoint for an external scheduler.
 *
 * The primary way to run a collection is `npm run collect` from cron, systemd
 * or Task Scheduler. This exists for hosted setups whose scheduler can only
 * make an HTTP request.
 *
 * It responds with the run summary rather than scheduling the work with
 * `after()`: the caller is a scheduler, and a scheduler that cannot see whether
 * the run succeeded has no way to alert when collection silently stops.
 */

export const dynamic = 'force-dynamic';

/** Not the session cookie: this is machine-to-machine, so no cookie is involved. */
function providedSecret(request: NextRequest): string | null {
  const authorization = request.headers.get('authorization');

  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim();
  }

  return request.headers.get('x-collector-secret');
}

/**
 * Constant-time comparison over digests.
 *
 * Hashing first makes both sides the same length, so `timingSafeEqual` cannot
 * throw on a length mismatch -- and the length of the configured secret is not
 * leaked by how quickly the comparison fails.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();

  return timingSafeEqual(a, b);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest): Promise<Response> {
  const secret = getEnv().COLLECTOR_TRIGGER_SECRET;

  if (!secret) {
    // Disabled rather than open: this endpoint makes the server call every
    // registered provider, which is not something to leave unauthenticated.
    return Response.json(
      {
        error:
          'Collection over HTTP is disabled. Set COLLECTOR_TRIGGER_SECRET to enable it, or run `npm run collect`.',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const provided = providedSecret(request);

  if (!provided || !secretMatches(provided, secret)) {
    return Response.json(
      { error: 'Authentication required' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // Optional narrowing, so one organization can be collected on its own schedule.
  const organizationId = new URL(request.url).searchParams.get('organizationId') ?? undefined;

  if (organizationId && !UUID.test(organizationId)) {
    return Response.json(
      { error: 'organizationId must be a UUID' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const summary = await runCollection({ organizationId });

  return Response.json(summary, {
    // A run that did nothing because another holds the lock is still a
    // successful request; the body says what happened.
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
