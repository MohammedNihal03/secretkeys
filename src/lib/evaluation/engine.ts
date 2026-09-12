import { thresholdFor, type ThresholdRule } from './thresholds';

/**
 * Turning numbers into a colour, and only here.
 *
 * One function decides what "warning" means for every metric in the system.
 * Nothing else in the codebase is allowed to compare a metric to a number --
 * not a page, not a component, not a formatter. A threshold that lives in a
 * component is a threshold that disagrees with the one in the component next to
 * it as soon as either is adjusted.
 *
 * The fourth state carries the weight here. `unknown` is not "we have not
 * looked yet"; it is a metric that was asked for and could not be answered, and
 * it keeps the reason. A dashboard that renders a missing figure as green says
 * everything is fine when nobody is actually watching.
 */

export type HealthLevel = 'healthy' | 'warning' | 'critical' | 'unknown';

export const LEVEL_LABELS: Record<HealthLevel, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
};

/** The plan's vocabulary, kept where the levels are defined. */
export const LEVEL_INDICATORS: Record<HealthLevel, string> = {
  healthy: '🟢',
  warning: '🟡',
  critical: '🔴',
  unknown: '⚫',
};

export interface Finding {
  /** The metric's dotted path. */
  metric: string;
  label: string;
  level: HealthLevel;
  /** Null when the metric could not be read. */
  value: number | null;
  unit: ThresholdRule['unit'] | null;
  /** One sentence, ready to show. Never a template a component has to finish. */
  message: string;
  /** Present when the metric was judged against a rule. */
  rule?: ThresholdRule;
  /** Present on an `unknown`: why the number is missing. */
  reason?: string;
  /**
   * True when this metric can never be read from this source.
   *
   * PostgreSQL exposes no host CPU, memory or free disk, and no amount of
   * configuration changes that. Such a finding is still shown -- an operator
   * should know nothing is watching disk -- but it is excluded from the rollup,
   * because a permanent `unknown` on every healthy database would make the
   * state meaningless within a day and teach people to ignore it.
   *
   * A fixable absence -- a missing grant, a failed query, a rate still waiting
   * for its second sample -- is *not* structural, and does reach the rollup.
   */
  structural?: boolean;
}

/**
 * Reasons that describe the source rather than the setup.
 *
 * The distinction is the difference between "go and fix this" and "this can
 * never be known here".
 */
const STRUCTURAL_REASONS = new Set(['not_exposed_by_postgres', 'too_expensive', 'unsupported']);

export function isStructural(reason: string | null | undefined): boolean {
  return reason !== null && reason !== undefined && STRUCTURAL_REASONS.has(reason);
}

/**
 * Worst level wins, with one deliberate exception.
 *
 * `unknown` outranks `healthy`, because a rollup that reports green while half
 * its inputs are unreadable is the failure mode this whole system exists to
 * avoid. It does not outrank `warning` or `critical`: a known problem is more
 * actionable than an unreadable metric, and should be the thing that surfaces.
 */
export function aggregate(levels: readonly HealthLevel[]): HealthLevel {
  if (levels.length === 0) return 'unknown';

  const precedence: HealthLevel[] = ['critical', 'warning', 'unknown', 'healthy'];
  return precedence.find((candidate) => levels.includes(candidate)) ?? 'unknown';
}

function formatValue(value: number, unit: ThresholdRule['unit']): string {
  switch (unit) {
    case 'percent':
      return `${round(value)}%`;
    case 'ms':
      return `${round(value)} ms`;
    case 'seconds':
      return value >= 120 ? `${round(value / 60)} min` : `${round(value)} s`;
    case 'bytes':
      return formatBytes(value);
    default:
      return String(round(value));
  }
}

function round(value: number): number {
  return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = Math.abs(bytes);
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  const sign = bytes < 0 ? '-' : '';
  return `${sign}${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Whether a reading breaches a rule, and how badly. */
export function levelFor(rule: ThresholdRule, value: number): HealthLevel {
  if (rule.direction === 'above') {
    if (value >= rule.critical) return 'critical';
    if (value >= rule.warning) return 'warning';
    return 'healthy';
  }

  if (value <= rule.critical) return 'critical';
  if (value <= rule.warning) return 'warning';
  return 'healthy';
}

export interface Reading {
  metric: string;
  value: number | null;
  /** Why the value is missing. Required when `value` is null. */
  reason?: string | null;
  detail?: string | null;
  /** Overrides the rule's label, for a metric shown under a different name. */
  label?: string;
}

/**
 * Evaluates one reading.
 *
 * Returns null when no rule covers the metric: that is "this number is not
 * judged", which is different from "this number is fine", and a caller that
 * displays it should say so by showing the value without a colour.
 */
export function evaluate(reading: Reading): Finding | null {
  const rule = thresholdFor(reading.metric);
  if (!rule) return null;

  const label = reading.label ?? rule.label;

  if (reading.value === null) {
    return {
      metric: reading.metric,
      label,
      level: 'unknown',
      value: null,
      unit: rule.unit,
      rule,
      reason: reading.reason ?? 'unavailable',
      ...(isStructural(reading.reason) ? { structural: true } : {}),
      message: reading.detail ?? `${label} could not be read, so it is not being judged.`,
    };
  }

  const level = levelFor(rule, reading.value);
  const shown = formatValue(reading.value, rule.unit);
  const limit = formatValue(level === 'critical' ? rule.critical : rule.warning, rule.unit);
  const comparison = rule.direction === 'above' ? 'at or above' : 'at or below';

  return {
    metric: reading.metric,
    label,
    level,
    value: reading.value,
    unit: rule.unit,
    rule,
    message:
      level === 'healthy'
        ? `${label} is ${shown}.`
        : `${label} is ${shown}, ${comparison} the ${level} threshold of ${limit}.`,
  };
}

/**
 * Evaluates a set of readings, keeping every rule that was asked about.
 *
 * A rule with no reading becomes an explicit `unknown` rather than vanishing.
 * Silently dropping it would turn "we cannot measure disk usage" into a
 * dashboard that simply never mentions disk -- which reads as "disk is fine".
 */
export function evaluateAll(
  readings: readonly Reading[],
  rules: readonly ThresholdRule[]
): Finding[] {
  const byMetric = new Map(readings.map((reading) => [reading.metric, reading]));

  return rules.map((rule) => {
    const reading = byMetric.get(rule.metric);

    if (!reading) {
      return {
        metric: rule.metric,
        label: rule.label,
        level: 'unknown' as const,
        value: null,
        unit: rule.unit,
        rule,
        reason: 'not_collected',
        message: `${rule.label} has not been collected yet.`,
      };
    }

    // `evaluate` returns null only for a metric with no rule, and this one has one.
    return evaluate(reading) as Finding;
  });
}

/**
 * The level a set of findings rolls up to.
 *
 * Structural unknowns are set aside first: they are permanent properties of the
 * data source, and letting them decide the rollup would paint every healthy
 * database amber forever. If *everything* is structural, the answer is still
 * `unknown` -- nothing is actually being judged.
 */
export function rollUp(findings: readonly Finding[]): HealthLevel {
  const judged = findings.filter((finding) => !finding.structural);

  return judged.length > 0 ? aggregate(judged.map((finding) => finding.level)) : 'unknown';
}

/** The findings worth showing first: worst level, then largest breach. */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  const order: Record<HealthLevel, number> = { critical: 0, warning: 1, unknown: 2, healthy: 3 };

  return [...findings].sort((a, b) => {
    if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
    return a.label.localeCompare(b.label);
  });
}
