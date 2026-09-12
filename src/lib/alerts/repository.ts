import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { alerts } from '@/lib/db/schema';
import { getSqlState, PG_ERROR } from '@/lib/db/errors';
import type { AlertCondition, OpenAlert, Reconciliation } from './engine';

/**
 * Reading and writing alerts.
 *
 * Every write is scoped by organization, and the reconciliation below is the
 * only place alerts are raised or resolved -- so the "one open alert per
 * condition" rule has exactly one implementation to be wrong in.
 */

export type ResourceType = 'api_key' | 'monitored_database';

export interface AlertView {
  id: string;
  projectId: string | null;
  resourceType: ResourceType;
  resourceId: string;
  resourceName: string;
  rule: string;
  severity: 'warning' | 'critical';
  status: 'active' | 'resolved';
  title: string;
  description: string;
  triggeredAt: Date;
  resolvedAt: Date | null;
  lastSeenAt: Date;
  peakSeverity: 'warning' | 'critical';
}

const COLUMNS = {
  id: alerts.id,
  projectId: alerts.projectId,
  resourceType: alerts.resourceType,
  resourceId: alerts.resourceId,
  resourceName: alerts.resourceName,
  rule: alerts.rule,
  severity: alerts.severity,
  status: alerts.status,
  title: alerts.title,
  description: alerts.description,
  triggeredAt: alerts.triggeredAt,
  resolvedAt: alerts.resolvedAt,
  lastSeenAt: alerts.lastSeenAt,
  peakSeverity: alerts.peakSeverity,
};

export interface AlertQuery {
  organizationId: string;
  status?: 'active' | 'resolved';
  resourceId?: string;
  limit?: number;
}

export async function listAlerts(query: AlertQuery): Promise<AlertView[]> {
  const clauses = [eq(alerts.organizationId, query.organizationId)];

  if (query.status) clauses.push(eq(alerts.status, query.status));
  if (query.resourceId) clauses.push(eq(alerts.resourceId, query.resourceId));

  return getDb()
    .select(COLUMNS)
    .from(alerts)
    .where(and(...clauses))
    /**
     * Critical before warning, then newest first. An alerts list sorted purely
     * by time buries the thing that matters under the thing that just happened.
     */
    .orderBy(desc(alerts.severity), desc(alerts.triggeredAt))
    .limit(query.limit ?? 100);
}

/** How many conditions are currently true, by severity. */
export async function countActiveAlerts(
  organizationId: string
): Promise<{ warning: number; critical: number; total: number }> {
  const [row] = await getDb()
    .select({
      warning: sql<number>`count(*) filter (where ${alerts.severity} = 'warning')::int`,
      critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(alerts)
    .where(and(eq(alerts.organizationId, organizationId), eq(alerts.status, 'active')));

  return row ?? { warning: 0, critical: 0, total: 0 };
}

/** The open alerts for one resource, in the shape reconciliation needs. */
export async function openAlertsFor(
  organizationId: string,
  resourceId: string
): Promise<OpenAlert[]> {
  const rows = await getDb()
    .select({
      id: alerts.id,
      rule: alerts.rule,
      severity: alerts.severity,
      peakSeverity: alerts.peakSeverity,
    })
    .from(alerts)
    .where(
      and(
        eq(alerts.organizationId, organizationId),
        eq(alerts.resourceId, resourceId),
        eq(alerts.status, 'active')
      )
    );

  return rows;
}

export interface AlertSubject {
  organizationId: string;
  projectId: string | null;
  resourceType: ResourceType;
  resourceId: string;
  resourceName: string;
}

export interface ApplyResult {
  raised: number;
  updated: number;
  resolved: number;
}

/**
 * Writes one reconciliation.
 *
 * A duplicate insert is *expected*, not exceptional: two collectors can race,
 * and the partial unique index is what settles it. Catching the violation and
 * counting it as an update is the correct handling -- the condition is open,
 * which is all that was wanted.
 */
export async function applyReconciliation(
  subject: AlertSubject,
  plan: Reconciliation,
  now: Date = new Date()
): Promise<ApplyResult> {
  const db = getDb();
  let raised = 0;

  for (const condition of plan.raise) {
    try {
      await db.insert(alerts).values({
        organizationId: subject.organizationId,
        projectId: subject.projectId,
        resourceType: subject.resourceType,
        resourceId: subject.resourceId,
        resourceName: subject.resourceName,
        rule: condition.rule,
        severity: condition.severity,
        peakSeverity: condition.severity,
        title: condition.title,
        description: condition.description,
        triggeredAt: now,
        lastSeenAt: now,
      });

      raised += 1;
    } catch (error) {
      // Another collection opened the same condition first. Nothing to do.
      if (getSqlState(error) !== PG_ERROR.uniqueViolation) throw error;
    }
  }

  for (const entry of plan.update) {
    await db
      .update(alerts)
      .set({
        severity: entry.condition.severity,
        peakSeverity: entry.peakSeverity,
        // The wording carries the current number, so it is refreshed.
        title: entry.condition.title,
        description: entry.condition.description,
        lastSeenAt: now,
      })
      .where(and(eq(alerts.id, entry.id), eq(alerts.organizationId, subject.organizationId)));
  }

  if (plan.resolve.length > 0) {
    await db
      .update(alerts)
      .set({ status: 'resolved', resolvedAt: now })
      .where(
        and(
          eq(alerts.organizationId, subject.organizationId),
          inArray(alerts.id, plan.resolve),
          // Only an open alert resolves, so a re-run cannot move `resolvedAt`.
          eq(alerts.status, 'active')
        )
      );
  }

  return { raised, updated: plan.update.length, resolved: plan.resolve.length };
}

/**
 * Resolves everything open for a resource.
 *
 * Used when a resource stops being monitored: a paused database or a revoked
 * key leaves conditions that can never be re-observed, and an alert nobody can
 * clear is the kind that teaches people to ignore the list.
 */
export async function resolveAllFor(
  organizationId: string,
  resourceId: string,
  now: Date = new Date()
): Promise<number> {
  const resolved = await getDb()
    .update(alerts)
    .set({ status: 'resolved', resolvedAt: now })
    .where(
      and(
        eq(alerts.organizationId, organizationId),
        eq(alerts.resourceId, resourceId),
        eq(alerts.status, 'active')
      )
    )
    .returning({ id: alerts.id });

  return resolved.length;
}
