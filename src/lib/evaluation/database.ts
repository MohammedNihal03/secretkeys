import type { MetricSummary } from '@/lib/databases/storage';
import type { DatabaseSnapshot } from '@/lib/databases/types';
import { evaluateAll, rankFindings, rollUp, type Finding, type HealthLevel } from './engine';
import { DATABASE_THRESHOLDS } from './thresholds';

/**
 * Judging a monitored database.
 *
 * Two entry points on purpose: a snapshot straight from the collector, and the
 * stored series read back. They must agree, so both funnel into the same
 * `evaluateAll` with the same rules -- the alternative is a detail page that
 * disagrees with the collector that filled it.
 */

export interface DatabaseAssessment {
  level: HealthLevel;
  /** One line an operator can act on, or be reassured by. */
  headline: string;
  findings: Finding[];
  /** True when the database did not answer at all. */
  unreachable: boolean;
}

/**
 * Reachability is decided before any threshold.
 *
 * A database that cannot be reached has no metrics to judge, and reporting it
 * as "unknown" alongside nine unknown metrics buries the one fact that matters.
 */
function unreachableAssessment(name: string, detail: string | null): DatabaseAssessment {
  return {
    level: 'critical',
    headline: detail ? `${name} could not be reached: ${detail}` : `${name} could not be reached.`,
    findings: [
      {
        metric: 'health.reachable',
        label: 'Availability',
        level: 'critical',
        value: 0,
        unit: null,
        message: detail ?? 'The database did not answer.',
      },
    ],
    unreachable: true,
  };
}

function headlineFor(name: string, level: HealthLevel, findings: readonly Finding[]): string {
  const ranked = rankFindings(findings);
  const worst = ranked.find((finding) => finding.level === level);

  if (level === 'healthy') {
    /**
     * Healthy, with the permanent absences named rather than hidden. Someone
     * reading "healthy" deserves to know how much of the picture it covers.
     */
    const structural = findings.filter((finding) => finding.structural).length;

    return structural > 0
      ? `${name} is healthy. ${structural} metric${structural === 1 ? '' : 's'} PostgreSQL cannot report ${structural === 1 ? 'is' : 'are'} listed below.`
      : `${name} is healthy.`;
  }

  if (level === 'unknown') {
    return `${name} is reachable, but ${
      findings.filter((finding) => finding.level === 'unknown' && !finding.structural).length
    } of its metrics could not be read.`;
  }

  return worst ? `${name}: ${worst.message}` : `${name} needs attention.`;
}

/** Judges a snapshot the collector just produced. */
export function assessSnapshot(snapshot: DatabaseSnapshot): DatabaseAssessment {
  if (!snapshot.health.reachable) {
    return unreachableAssessment(snapshot.target.name, snapshot.error ?? null);
  }

  const readings = [
    {
      metric: 'health.responseTimeMs',
      value: snapshot.health.responseTimeMs,
    },
    reading('connections.utilizationPercent', snapshot.connections.utilizationPercent),
    reading('connections.idleInTransaction', snapshot.connections.idleInTransaction),
    reading('queries.longRunning', snapshot.queries.longRunning),
    reading('queries.longestRunningSeconds', snapshot.queries.longestRunningSeconds),
    reading('queries.blocked', snapshot.queries.blocked),
    reading('queries.deadlocksInInterval', snapshot.queries.deadlocksInInterval),
    reading('postgres.cacheHitRatioInterval', snapshot.postgres.cacheHitRatioInterval),
    reading('resources.cpuPercent', snapshot.resources.cpuPercent),
    reading('resources.memoryPercent', snapshot.resources.memoryPercent),
    // Free space is what PostgreSQL cannot report; the rule is expressed as a
    // percentage used, so the reading stays unavailable with that reason.
    reading('resources.diskUsedPercent', snapshot.resources.diskFreeBytes),
  ];

  const findings = evaluateAll(readings, DATABASE_THRESHOLDS);
  const level = rollUp(findings);

  return {
    level,
    headline: headlineFor(snapshot.target.name, level, findings),
    findings: rankFindings(findings),
    unreachable: false,
  };
}

/** Shapes one collector metric into a reading the engine understands. */
function reading(
  metric: string,
  source: { available: true; value: unknown } | { available: false; reason: string; detail: string }
) {
  if (!source.available) {
    return { metric, value: null, reason: source.reason, detail: source.detail };
  }

  return {
    metric,
    value: typeof source.value === 'number' ? source.value : null,
    ...(typeof source.value === 'number'
      ? {}
      : { reason: 'query_error', detail: 'The stored reading was not a number.' }),
  };
}

/**
 * Judges a database from what was stored.
 *
 * Uses the newest reading of each metric. A metric that stopped being collected
 * keeps its last reading rather than disappearing, and `latestAt` is what tells
 * a page whether that reading is current -- staleness is the caller's to decide,
 * since "old" depends on how often the collector runs.
 */
export function assessStoredMetrics(
  name: string,
  metrics: readonly MetricSummary[],
  options: { reachable?: boolean; error?: string | null } = {}
): DatabaseAssessment {
  if (options.reachable === false) {
    return unreachableAssessment(name, options.error ?? null);
  }

  if (metrics.length === 0) {
    return {
      level: 'unknown',
      headline: `No metrics have been collected for ${name} yet.`,
      findings: [],
      unreachable: false,
    };
  }

  const readings = metrics.map((summary) => ({
    metric: summary.metric,
    value: summary.latest,
    reason: summary.latestReason,
    detail: summary.latestDetail,
  }));

  const findings = evaluateAll(readings, DATABASE_THRESHOLDS);
  const level = rollUp(findings);

  return {
    level,
    headline: headlineFor(name, level, findings),
    findings: rankFindings(findings),
    unreachable: false,
  };
}
