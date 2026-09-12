import type { Finding, HealthLevel } from '@/lib/evaluation/engine';

/**
 * Deciding which findings deserve an alert, and what the alert says.
 *
 * Pure: no database, no clock beyond what is passed in. What is worth waking
 * someone for is a judgement, and a judgement is worth testing.
 *
 * Two rules shape everything here:
 *
 * 1. **Only actionable levels raise alerts.** `critical` and `warning` do;
 *    `unknown` does not. "We cannot read this metric" is shown on the resource
 *    itself, where it can be fixed. Raising an alert for it would fill the list
 *    with conditions nobody can clear, and a list like that gets ignored --
 *    which costs more than the missing metric ever would.
 * 2. **A condition is identified by its rule, not by its message.** The text
 *    changes every collection as the number moves; the rule does not. Keying on
 *    the rule is what makes "still above 85%" an update rather than a new alert.
 */

export type AlertSeverity = 'warning' | 'critical';

export interface AlertCondition {
  /** The rule that raised it, e.g. `connections.utilizationPercent`. */
  rule: string;
  severity: AlertSeverity;
  title: string;
  description: string;
}

export function isAlertable(level: HealthLevel): level is AlertSeverity {
  return level === 'critical' || level === 'warning';
}

/**
 * Turns one finding into a condition, or nothing.
 *
 * The description carries the rule's rationale, because an alert with no
 * explanation gets silenced rather than fixed: someone reading "cache hit ratio
 * is 88%" at three in the morning needs to know why that number matters before
 * they can decide whether it does.
 */
export function conditionFor(finding: Finding, subject: string): AlertCondition | null {
  if (!isAlertable(finding.level)) return null;

  const rationale = finding.rule?.rationale;

  return {
    rule: finding.metric,
    severity: finding.level,
    title: `${subject}: ${finding.label.toLowerCase()}`,
    description: rationale ? `${finding.message} ${rationale}` : finding.message,
  };
}

/** Every condition currently true for one resource. */
export function conditionsFor(
  findings: readonly Finding[],
  subject: string
): AlertCondition[] {
  return findings
    .map((finding) => conditionFor(finding, subject))
    .filter((condition): condition is AlertCondition => condition !== null);
}

/** An alert already open for a resource, as far as reconciliation cares. */
export interface OpenAlert {
  id: string;
  rule: string;
  severity: AlertSeverity;
  peakSeverity: AlertSeverity;
}

export interface Reconciliation {
  /** Conditions that were not already open. */
  raise: AlertCondition[];
  /** Open alerts whose condition is still true, with the severity to store. */
  update: { id: string; condition: AlertCondition; peakSeverity: AlertSeverity }[];
  /** Open alerts whose condition is no longer true. */
  resolve: string[];
}

const RANK: Record<AlertSeverity, number> = { warning: 0, critical: 1 };

/**
 * Compares what is true now against what is already open.
 *
 * The whole duplicate-suppression rule lives in this function, and it is a set
 * difference rather than a time window. Suppressing by "do not alert twice
 * within an hour" would also suppress a second, genuinely different problem on
 * the same resource; suppressing by identity never does.
 */
export function reconcile(
  conditions: readonly AlertCondition[],
  open: readonly OpenAlert[]
): Reconciliation {
  const openByRule = new Map(open.map((alert) => [alert.rule, alert]));
  const currentRules = new Set(conditions.map((condition) => condition.rule));

  const raise: AlertCondition[] = [];
  const update: Reconciliation['update'] = [];

  for (const condition of conditions) {
    const existing = openByRule.get(condition.rule);

    if (!existing) {
      raise.push(condition);
      continue;
    }

    update.push({
      id: existing.id,
      condition,
      /**
       * The peak never goes down while the alert is open. A condition that
       * escalated to critical and eased back to warning should not resolve
       * looking like it was only ever a warning.
       */
      peakSeverity:
        RANK[condition.severity] > RANK[existing.peakSeverity]
          ? condition.severity
          : existing.peakSeverity,
    });
  }

  return {
    raise,
    update,
    resolve: open.filter((alert) => !currentRules.has(alert.rule)).map((alert) => alert.id),
  };
}
