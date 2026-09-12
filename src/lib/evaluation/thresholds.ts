/**
 * Every threshold in the system, in one place.
 *
 * The build plan's instruction is exact: centralize thresholds instead of
 * hardcoding them across UI components. The reason is not tidiness. A number
 * repeated in four components is four different answers to "when is this bad",
 * and they diverge the first time one of them is adjusted -- so a card turns
 * amber while the table beside it stays green, and neither is wrong according
 * to its own code.
 *
 * Shape, not just location: each rule is `{ warning, critical }` in the metric's
 * own unit, with a direction. That is what lets the evaluator be one function
 * rather than one `if` per metric, and what will let these come from the
 * database when thresholds become configurable -- the plan says later, and the
 * shape is what makes later cheap.
 */

/** Which side of a threshold is bad. */
export type Direction =
  /** Bigger is worse: connection utilization, latency, error rate. */
  | 'above'
  /** Smaller is worse: cache hit ratio, remaining quota. */
  | 'below';

export interface ThresholdRule {
  /** The metric's dotted path, matching what the collectors produce. */
  metric: string;
  /** Shown next to the number; the evaluator never invents wording. */
  label: string;
  direction: Direction;
  warning: number;
  critical: number;
  unit: 'percent' | 'ms' | 'count' | 'seconds' | 'bytes';
  /**
   * Why this threshold exists, shown to an operator who asks why something is
   * amber. A number with no explanation gets ignored or silenced.
   */
  rationale: string;
}

/**
 * PostgreSQL thresholds.
 *
 * The connection rule is the plan's worked example, kept exactly: under 70% is
 * healthy, 70-85% warning, above 85% critical.
 */
export const DATABASE_THRESHOLDS: readonly ThresholdRule[] = [
  {
    metric: 'connections.utilizationPercent',
    label: 'Connection utilization',
    direction: 'above',
    warning: 70,
    critical: 85,
    unit: 'percent',
    rationale:
      'Running out of connections refuses every new client at once, and the last few slots are reserved for superusers — so "100% full" arrives before the number reaches 100.',
  },
  {
    metric: 'health.responseTimeMs',
    label: 'Response time',
    direction: 'above',
    warning: 500,
    critical: 2_000,
    unit: 'ms',
    rationale:
      'Time to answer a trivial query. When this climbs, the server is saturated rather than the query being slow.',
  },
  {
    metric: 'postgres.cacheHitRatioInterval',
    label: 'Cache hit ratio',
    direction: 'below',
    warning: 95,
    critical: 90,
    unit: 'percent',
    rationale:
      'A healthy OLTP database serves almost everything from shared buffers. A falling ratio means reads are reaching the disk, which shows up as latency everywhere else.',
  },
  {
    metric: 'queries.longRunning',
    label: 'Long-running queries',
    direction: 'above',
    warning: 1,
    critical: 5,
    unit: 'count',
    rationale:
      'A statement running for over a minute holds its snapshot open, which blocks vacuum and lets dead rows accumulate behind it.',
  },
  {
    metric: 'queries.longestRunningSeconds',
    label: 'Longest running query',
    direction: 'above',
    warning: 300,
    critical: 900,
    unit: 'seconds',
    rationale:
      'A single statement running for many minutes is either stuck behind a lock or scanning far more than intended.',
  },
  {
    metric: 'queries.blocked',
    label: 'Blocked connections',
    direction: 'above',
    warning: 1,
    critical: 5,
    unit: 'count',
    rationale:
      'Connections waiting on a lock are doing nothing while holding a connection slot. A few can cascade into all of them.',
  },
  {
    metric: 'queries.deadlocksInInterval',
    label: 'Deadlocks',
    direction: 'above',
    warning: 1,
    critical: 5,
    unit: 'count',
    rationale:
      'PostgreSQL breaks deadlocks by killing a transaction. Any deadlock means an application lost work; a rising count means it is losing work repeatedly.',
  },
  /**
   * Host resources.
   *
   * PostgreSQL exposes none of these, so today every one of them evaluates to
   * `unknown` with that as the reason. They are listed anyway, because the
   * build plan asks for disk, CPU and memory to be evaluated, and an operator
   * is better served by "nothing is watching disk, here is why" than by a
   * dashboard that never mentions disk at all. A future source -- a cloud
   * provider's metrics API, a node agent -- fills them in without touching the
   * evaluator.
   */
  {
    metric: 'resources.diskUsedPercent',
    label: 'Disk used',
    direction: 'above',
    warning: 80,
    critical: 90,
    unit: 'percent',
    rationale:
      'A full disk stops PostgreSQL writing, and recovery from that is manual. The warning has to arrive while there is still room to act.',
  },
  {
    metric: 'resources.cpuPercent',
    label: 'CPU',
    direction: 'above',
    warning: 80,
    critical: 95,
    unit: 'percent',
    rationale:
      'Sustained high CPU shows up as latency in every query at once, rather than in any single slow statement.',
  },
  {
    metric: 'resources.memoryPercent',
    label: 'Memory',
    direction: 'above',
    warning: 85,
    critical: 95,
    unit: 'percent',
    rationale:
      'Memory pressure pushes the operating system to evict cache, which turns cached reads into disk reads across the whole database.',
  },
  {
    metric: 'connections.idleInTransaction',
    label: 'Idle in transaction',
    direction: 'above',
    warning: 5,
    critical: 20,
    unit: 'count',
    rationale:
      'A connection idle inside a transaction holds locks and blocks vacuum indefinitely. It is almost always an application that forgot to commit.',
  },
];

/**
 * AI provider thresholds.
 *
 * Error rate and latency come from collected usage and probes; nothing here is
 * derived from a price list or a guess about a provider's behaviour.
 */
export const AI_THRESHOLDS: readonly ThresholdRule[] = [
  {
    metric: 'ai.errorRatePercent',
    label: 'Request error rate',
    direction: 'above',
    warning: 2,
    critical: 10,
    unit: 'percent',
    rationale:
      'Failed requests are usually paid for in retries. A few percent is normal noise; ten is an outage somebody should already know about.',
  },
  {
    metric: 'ai.latencyMs',
    label: 'Provider latency',
    direction: 'above',
    warning: 2_000,
    critical: 10_000,
    unit: 'ms',
    rationale:
      'Round-trip time to the provider’s API. Rising latency is usually the first sign of a provider incident.',
  },
  {
    metric: 'ai.quotaUsedPercent',
    label: 'Quota used',
    direction: 'above',
    warning: 80,
    critical: 95,
    unit: 'percent',
    rationale:
      'A quota that runs out stops the application, not the dashboard. The warning has to arrive with enough time to raise the limit.',
  },
  {
    metric: 'ai.rateLimitRemainingPercent',
    label: 'Rate limit headroom',
    direction: 'below',
    warning: 20,
    critical: 5,
    unit: 'percent',
    rationale:
      'How much of the current rate-limit window is left. Near zero, requests are about to be rejected rather than merely slowed.',
  },
];

const ALL_RULES = [...DATABASE_THRESHOLDS, ...AI_THRESHOLDS];

const BY_METRIC = new Map(ALL_RULES.map((rule) => [rule.metric, rule]));

/** The rule for one metric path, or undefined when the metric is not judged. */
export function thresholdFor(metric: string): ThresholdRule | undefined {
  return BY_METRIC.get(metric);
}

export function allThresholds(): readonly ThresholdRule[] {
  return ALL_RULES;
}
