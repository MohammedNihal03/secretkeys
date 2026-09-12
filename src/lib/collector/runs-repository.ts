import { and, desc, eq, lt, sql } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { apiKeys, collectorRuns } from '@/lib/db/schema';
import type { HealthStatus } from '@/lib/health';
import type { CollectorRunRecord } from './types';

/**
 * Reading and writing the collector's audit trail.
 */

export async function recordCollectorRun(record: CollectorRunRecord): Promise<void> {
  await getDb().insert(collectorRuns).values(record);
}

/**
 * Keeps a credential's check state in step with what collection just observed.
 *
 * Without this, a key revoked at the provider would keep showing as
 * "Validated" from whenever it was registered, and the first sign of trouble
 * would be missing metrics rather than a clear "Rejected".
 */
export async function updateCredentialCheck(
  organizationId: string,
  apiKeyId: string,
  outcome: 'valid' | 'invalid' | 'unverified',
  detail: string | null
): Promise<void> {
  await getDb()
    .update(apiKeys)
    .set({
      // The database clock, consistent with every other timestamp.
      lastValidatedAt: sql`now()`,
      lastValidationOutcome: outcome,
      lastValidationDetail: detail,
    })
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, apiKeyId)));
}

export interface KeyCollectionState {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  lastProviderStatus: HealthStatus | null;
}

/**
 * "Last successful request" and "last error" for one credential.
 *
 * Derived from the run history rather than kept as mutable columns, so the
 * answer cannot drift and the runs behind it stay inspectable.
 */
export async function collectionStateForKey(
  organizationId: string,
  apiKeyId: string
): Promise<KeyCollectionState> {
  const db = getDb();
  const scope = and(
    eq(collectorRuns.organizationId, organizationId),
    eq(collectorRuns.apiKeyId, apiKeyId)
  );

  const [lastSuccess] = await db
    .select({ finishedAt: collectorRuns.finishedAt, providerStatus: collectorRuns.providerStatus })
    .from(collectorRuns)
    .where(and(scope, eq(collectorRuns.outcome, 'success')))
    .orderBy(desc(collectorRuns.finishedAt))
    .limit(1);

  const [lastFailure] = await db
    .select({ finishedAt: collectorRuns.finishedAt, error: collectorRuns.error })
    .from(collectorRuns)
    .where(and(scope, eq(collectorRuns.outcome, 'failed')))
    .orderBy(desc(collectorRuns.finishedAt))
    .limit(1);

  const [latest] = await db
    .select({ providerStatus: collectorRuns.providerStatus })
    .from(collectorRuns)
    .where(scope)
    .orderBy(desc(collectorRuns.finishedAt))
    .limit(1);

  return {
    lastSuccessAt: lastSuccess?.finishedAt ?? null,
    lastFailureAt: lastFailure?.finishedAt ?? null,
    lastError: lastFailure?.error ?? null,
    lastProviderStatus: latest?.providerStatus ?? null,
  };
}

/** Recent runs for an organization, newest first. */
export async function recentCollectorRuns(organizationId: string, limit = 20) {
  return getDb()
    .select({
      id: collectorRuns.id,
      apiKeyId: collectorRuns.apiKeyId,
      providerId: collectorRuns.providerId,
      startedAt: collectorRuns.startedAt,
      finishedAt: collectorRuns.finishedAt,
      durationMs: collectorRuns.durationMs,
      outcome: collectorRuns.outcome,
      providerStatus: collectorRuns.providerStatus,
      latencyMs: collectorRuns.latencyMs,
      rateLimited: collectorRuns.rateLimited,
      attempts: collectorRuns.attempts,
      usageEntryCount: collectorRuns.usageEntryCount,
      usagePersistedCount: collectorRuns.usagePersistedCount,
      unavailable: collectorRuns.unavailable,
      error: collectorRuns.error,
    })
    .from(collectorRuns)
    .where(eq(collectorRuns.organizationId, organizationId))
    .orderBy(desc(collectorRuns.startedAt))
    .limit(limit);
}

/**
 * Deletes run history older than a cut-off.
 *
 * The collector writes a row per credential per run, so this table grows
 * steadily and forever while the metrics it describes are summarised elsewhere.
 * Retention is the caller's decision; nothing here prunes on its own.
 */
export async function pruneCollectorRuns(
  olderThan: Date,
  organizationId?: string
): Promise<number> {
  /**
   * Unscoped, this deletes across every tenant, which is what a retention job
   * wants and what nothing else does. Pass an organization id unless you are
   * that job.
   */
  const scope = organizationId
    ? and(lt(collectorRuns.startedAt, olderThan), eq(collectorRuns.organizationId, organizationId))
    : lt(collectorRuns.startedAt, olderThan);

  const deleted = await getDb()
    .delete(collectorRuns)
    .where(scope)
    .returning({ id: collectorRuns.id });

  return deleted.length;
}
