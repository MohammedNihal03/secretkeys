import type { DatabaseSnapshot } from '@/lib/databases/types';
import { assessSnapshot } from '@/lib/evaluation/database';
import { assessProvider, type AiProviderState } from '@/lib/evaluation/ai';
import { conditionsFor, reconcile } from './engine';
import {
  applyReconciliation,
  openAlertsFor,
  type AlertSubject,
  type ApplyResult,
} from './repository';

/**
 * Where alerts come from.
 *
 * Alerts are not evaluated separately from health -- they are the health engine's
 * actionable findings, given a lifecycle. A second set of rules for "when to
 * alert" would drift from the first set within a month, and then the dashboard
 * and the alert list would disagree about whether anything is wrong.
 *
 * So this module is thin on purpose: assess, turn findings into conditions,
 * reconcile against what is open. It runs at the end of a collection, on the
 * snapshot that collection just produced, so an alert is never older than the
 * measurement behind it.
 */

export interface AlertSync extends ApplyResult {
  /** The conditions currently true, for logging and the run summary. */
  active: number;
}

/** Reconciles alerts for one monitored database from its fresh snapshot. */
export async function syncDatabaseAlerts(
  snapshot: DatabaseSnapshot,
  now: Date = new Date()
): Promise<AlertSync> {
  const assessment = assessSnapshot(snapshot);
  const conditions = conditionsFor(assessment.findings, snapshot.target.name);

  const subject: AlertSubject = {
    organizationId: snapshot.target.organizationId,
    projectId: snapshot.target.projectId,
    resourceType: 'monitored_database',
    resourceId: snapshot.target.databaseId,
    resourceName: snapshot.target.name,
  };

  const open = await openAlertsFor(subject.organizationId, subject.resourceId);
  const result = await applyReconciliation(subject, reconcile(conditions, open), now);

  return { ...result, active: conditions.length };
}

export interface ApiKeyAlertTarget {
  organizationId: string;
  projectId: string;
  apiKeyId: string;
  keyName: string;
}

/** Reconciles alerts for one credential from its collected state. */
export async function syncApiKeyAlerts(
  target: ApiKeyAlertTarget,
  state: AiProviderState,
  now: Date = new Date()
): Promise<AlertSync> {
  const assessment = assessProvider(state);
  const conditions = conditionsFor(assessment.findings, target.keyName);

  const subject: AlertSubject = {
    organizationId: target.organizationId,
    projectId: target.projectId,
    resourceType: 'api_key',
    resourceId: target.apiKeyId,
    resourceName: target.keyName,
  };

  const open = await openAlertsFor(subject.organizationId, subject.resourceId);
  const result = await applyReconciliation(subject, reconcile(conditions, open), now);

  return { ...result, active: conditions.length };
}
