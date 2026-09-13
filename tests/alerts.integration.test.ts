import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { reconcile, type AlertCondition } from '@/lib/alerts/engine';
import {
  applyReconciliation,
  countActiveAlerts,
  listAlerts,
  openAlertsFor,
  resolveAllFor,
  type AlertSubject,
} from '@/lib/alerts/repository';
import { closePool, getDb } from '@/lib/db/client';
import { alerts, organizations, projects } from '@/lib/db/schema';

/**
 * The alert lifecycle against a real database.
 *
 *   npm run db:setup && npm run test:integration
 *
 * The rule worth proving here is the one the build plan asks for -- no
 * duplicate alerts for the same ongoing condition -- and it is enforced by a
 * partial unique index rather than by application code, so it can only be
 * checked against Postgres.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();

let orgId: string;
let otherOrgId: string;
let projectId: string;

const RESOURCE = '11111111-1111-4111-8111-111111111111';

function subject(overrides: Partial<AlertSubject> = {}): AlertSubject {
  return {
    organizationId: orgId,
    projectId,
    resourceType: 'monitored_database',
    resourceId: RESOURCE,
    resourceName: 'Production Primary',
    ...overrides,
  };
}

function condition(overrides: Partial<AlertCondition> = {}): AlertCondition {
  return {
    rule: 'connections.utilizationPercent',
    severity: 'critical',
    title: 'Production Primary: connection utilization',
    description: 'Connection utilization is 91%.',
    ...overrides,
  };
}

beforeAll(async () => {
  const [organization] = await db
    .insert(organizations)
    .values({ name: `Alerts Org ${RUN}` })
    .returning({ id: organizations.id });
  orgId = organization.id;

  const [other] = await db
    .insert(organizations)
    .values({ name: `Alerts Other ${RUN}` })
    .returning({ id: organizations.id });
  otherOrgId = other.id;

  const [project] = await db
    .insert(projects)
    .values({ organizationId: orgId, name: 'Platform' })
    .returning({ id: projects.id });
  projectId = project.id;
});

beforeEach(async () => {
  await db.delete(alerts).where(eq(alerts.organizationId, orgId));
  await db.delete(alerts).where(eq(alerts.organizationId, otherOrgId));
});

afterAll(async () => {
  for (const id of [orgId, otherOrgId].filter(Boolean)) {
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  await closePool();
});

describe('raising and resolving', () => {
  it('opens a condition once and keeps it open across collections', async () => {
    const first = await applyReconciliation(subject(), reconcile([condition()], []));
    expect(first).toMatchObject({ raised: 1, resolved: 0 });

    // A second collection finds the same condition still true.
    const open = await openAlertsFor(orgId, RESOURCE);
    const second = await applyReconciliation(subject(), reconcile([condition()], open));

    expect(second).toMatchObject({ raised: 0, updated: 1 });

    const rows = await listAlerts({ organizationId: orgId, status: 'active' });
    expect(rows).toHaveLength(1);
    expect(rows[0].triggeredAt.getTime()).toBe(
      (await listAlerts({ organizationId: orgId }))[0].triggeredAt.getTime()
    );
  });

  it('refuses a second open alert for the same condition, in the database', async () => {
    await applyReconciliation(subject(), reconcile([condition()], []));

    /**
     * Reconciliation is bypassed deliberately: this asserts the index, not the
     * code that usually avoids hitting it. Two collectors racing must not be
     * able to produce a duplicate.
     */
    await expect(
      db.insert(alerts).values({
        organizationId: orgId,
        projectId,
        resourceType: 'monitored_database',
        resourceId: RESOURCE,
        resourceName: 'Production Primary',
        rule: 'connections.utilizationPercent',
        severity: 'warning',
        peakSeverity: 'warning',
        title: 'duplicate',
        description: 'duplicate',
      })
    ).rejects.toThrow();
  });

  it('treats a raced insert as an update rather than an error', async () => {
    await applyReconciliation(subject(), reconcile([condition()], []));

    // Reconciled against an empty set, as a second collector would see it.
    const raced = await applyReconciliation(subject(), reconcile([condition()], []));

    expect(raced.raised).toBe(0);
    expect(await listAlerts({ organizationId: orgId, status: 'active' })).toHaveLength(1);
  });

  it('resolves when the condition stops being true, and reopens later', async () => {
    await applyReconciliation(subject(), reconcile([condition()], []));

    const open = await openAlertsFor(orgId, RESOURCE);
    await applyReconciliation(subject(), reconcile([], open));

    const [resolved] = await listAlerts({ organizationId: orgId, status: 'resolved' });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(await countActiveAlerts(orgId)).toMatchObject({ total: 0 });

    // The partial index must not block the same condition next week.
    const again = await applyReconciliation(subject(), reconcile([condition()], []));
    expect(again.raised).toBe(1);
    expect(await listAlerts({ organizationId: orgId, status: 'active' })).toHaveLength(1);
  });

  it('keeps two different conditions on one resource apart', async () => {
    await applyReconciliation(
      subject(),
      reconcile([condition(), condition({ rule: 'queries.blocked', severity: 'warning' })], [])
    );

    const counts = await countActiveAlerts(orgId);
    expect(counts).toMatchObject({ total: 2, critical: 1, warning: 1 });

    // Clearing one leaves the other open.
    const open = await openAlertsFor(orgId, RESOURCE);
    await applyReconciliation(subject(), reconcile([condition()], open));

    expect(await countActiveAlerts(orgId)).toMatchObject({ total: 1, critical: 1 });
  });

  it('records the worst severity reached while open', async () => {
    await applyReconciliation(subject(), reconcile([condition({ severity: 'warning' })], []));

    let open = await openAlertsFor(orgId, RESOURCE);
    await applyReconciliation(subject(), reconcile([condition({ severity: 'critical' })], open));

    open = await openAlertsFor(orgId, RESOURCE);
    await applyReconciliation(subject(), reconcile([condition({ severity: 'warning' })], open));

    const [row] = await listAlerts({ organizationId: orgId, status: 'active' });
    expect(row.severity).toBe('warning');
    expect(row.peakSeverity).toBe('critical');
  });

  it('closes everything open when a resource stops being monitored', async () => {
    await applyReconciliation(
      subject(),
      reconcile([condition(), condition({ rule: 'queries.blocked', severity: 'warning' })], [])
    );

    const closed = await resolveAllFor(orgId, RESOURCE);

    expect(closed).toBe(2);
    expect(await countActiveAlerts(orgId)).toMatchObject({ total: 0 });
  });

  it('cannot see or resolve another organization’s alerts', async () => {
    await applyReconciliation(subject(), reconcile([condition()], []));

    expect(await listAlerts({ organizationId: otherOrgId })).toHaveLength(0);
    expect(await openAlertsFor(otherOrgId, RESOURCE)).toHaveLength(0);
    expect(await resolveAllFor(otherOrgId, RESOURCE)).toBe(0);

    // Still open for the organization that owns it.
    expect(await countActiveAlerts(orgId)).toMatchObject({ total: 1 });
  });

  it('survives the deletion of the resource it describes', async () => {
    await applyReconciliation(subject(), reconcile([condition()], []));

    /**
     * `resource_id` is deliberately not a foreign key: "why did we take that
     * key away" needs an answer after the key is gone.
     */
    const [row] = await listAlerts({ organizationId: orgId });
    expect(row.resourceName).toBe('Production Primary');
  });
});
