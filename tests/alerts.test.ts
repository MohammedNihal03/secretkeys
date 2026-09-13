import { describe, expect, it } from 'vitest';

import { conditionFor, conditionsFor, isAlertable, reconcile } from '@/lib/alerts/engine';
import type { Finding } from '@/lib/evaluation/engine';
import { parseRange, rangeHref } from '@/lib/dashboard/range';
import { extent, plotBand } from '@/components/charts';

/**
 * The alert lifecycle, and the range every historical view is read through.
 *
 * Both are pure, and both are places where a small mistake is invisible in
 * production: a duplicate alert looks like a busy system, and an off-by-one
 * range looks like a quiet day.
 */

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    metric: 'connections.utilizationPercent',
    label: 'Connection utilization',
    level: 'critical',
    value: 91,
    unit: 'percent',
    message: 'Connection utilization is 91%, at or above the critical threshold of 85%.',
    rule: {
      metric: 'connections.utilizationPercent',
      label: 'Connection utilization',
      direction: 'above',
      warning: 70,
      critical: 85,
      unit: 'percent',
      rationale: 'Running out of connections refuses every new client at once.',
    },
    ...overrides,
  };
}

describe('what deserves an alert', () => {
  it('raises for the two actionable levels', () => {
    expect(isAlertable('critical')).toBe(true);
    expect(isAlertable('warning')).toBe(true);
  });

  it('never raises for healthy or unknown', () => {
    /**
     * "We cannot read this" is shown on the resource, where it can be fixed.
     * An alert nobody can clear is what teaches people to ignore the list.
     */
    expect(isAlertable('unknown')).toBe(false);
    expect(isAlertable('healthy')).toBe(false);

    expect(conditionFor(finding({ level: 'unknown' }), 'Primary')).toBeNull();
    expect(conditionFor(finding({ level: 'healthy' }), 'Primary')).toBeNull();
  });

  it('puts the threshold’s reason into the description', () => {
    const condition = conditionFor(finding(), 'Primary');

    // An alert with no explanation gets silenced rather than fixed.
    expect(condition?.description).toContain('91%');
    expect(condition?.description).toContain('refuses every new client');
    expect(condition?.title).toBe('Primary: connection utilization');
  });

  it('keeps one condition per rule, named by the rule', () => {
    const conditions = conditionsFor(
      [
        finding(),
        finding({ metric: 'queries.blocked', label: 'Blocked connections', level: 'warning' }),
        finding({ metric: 'resources.cpuPercent', level: 'unknown' }),
      ],
      'Primary'
    );

    expect(conditions.map((condition) => condition.rule)).toEqual([
      'connections.utilizationPercent',
      'queries.blocked',
    ]);
  });
});

describe('reconciling against what is already open', () => {
  const condition = {
    rule: 'connections.utilizationPercent',
    severity: 'critical' as const,
    title: 'Primary: connection utilization',
    description: 'Connection utilization is 91%.',
  };

  it('raises a condition that is not open', () => {
    const plan = reconcile([condition], []);

    expect(plan.raise).toHaveLength(1);
    expect(plan.update).toHaveLength(0);
    expect(plan.resolve).toHaveLength(0);
  });

  it('updates rather than duplicating an ongoing condition', () => {
    const plan = reconcile(
      [condition],
      [{ id: 'a', rule: condition.rule, severity: 'critical', peakSeverity: 'critical' }]
    );

    // Six hours above a threshold is one alert, not three hundred and sixty.
    expect(plan.raise).toHaveLength(0);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].id).toBe('a');
  });

  it('resolves a condition that is no longer true', () => {
    const plan = reconcile(
      [],
      [{ id: 'a', rule: condition.rule, severity: 'warning', peakSeverity: 'warning' }]
    );

    expect(plan.resolve).toEqual(['a']);
  });

  it('does not suppress a different problem on the same resource', () => {
    /**
     * A time-window suppression would hide this. Identity-based suppression
     * never does, which is the reason for the rule key.
     */
    const plan = reconcile(
      [condition, { ...condition, rule: 'queries.deadlocksInInterval', severity: 'warning' }],
      [{ id: 'a', rule: condition.rule, severity: 'critical', peakSeverity: 'critical' }]
    );

    expect(plan.raise.map((entry) => entry.rule)).toEqual(['queries.deadlocksInInterval']);
    expect(plan.update).toHaveLength(1);
  });

  it('remembers the worst severity an open condition reached', () => {
    const plan = reconcile(
      [{ ...condition, severity: 'warning' }],
      [{ id: 'a', rule: condition.rule, severity: 'critical', peakSeverity: 'critical' }]
    );

    // Eased back to a warning, but this incident did reach critical.
    expect(plan.update[0].peakSeverity).toBe('critical');
  });

  it('raises the peak when a warning escalates', () => {
    const plan = reconcile(
      [condition],
      [{ id: 'a', rule: condition.rule, severity: 'warning', peakSeverity: 'warning' }]
    );

    expect(plan.update[0].peakSeverity).toBe('critical');
  });
});

describe('the historical range', () => {
  const now = new Date('2026-09-13T14:30:00Z');

  it('defaults to seven days', () => {
    const range = parseRange({}, now);

    expect(range.preset).toBe('7d');
    expect(range.days).toBe(7);
    expect(range.bucket).toBe('day');
    expect(range.from.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    // Exclusive, one day past today, because today is still accumulating.
    expect(range.to.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  it('buckets today by the hour', () => {
    const range = parseRange({ range: 'today' }, now);

    expect(range.bucket).toBe('hour');
    expect(range.from.toISOString()).toBe('2026-09-13T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  it('buckets a month by the day, not the week', () => {
    const range = parseRange({ range: '30d' }, now);

    // Weekly bars hide the day a problem started, which is the usual question.
    expect(range.days).toBe(30);
    expect(range.bucket).toBe('day');
  });

  it('reads a custom range with an inclusive end date', () => {
    const range = parseRange({ range: 'custom', from: '2026-09-01', to: '2026-09-03' }, now);

    expect(range.preset).toBe('custom');
    expect(range.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    // The 3rd is included, so the exclusive bound is the 4th.
    expect(range.to.toISOString()).toBe('2026-09-04T00:00:00.000Z');
    expect(range.days).toBe(3);
    expect(range.label).toBe('Sep 1 to Sep 3');
  });

  it('falls back rather than failing on a hand-edited URL', () => {
    // A range is a view preference; a bad one must not break the page.
    for (const params of [
      { range: 'custom', from: 'not-a-date', to: '2026-09-03' },
      { range: 'custom', from: '2026-09-03', to: '2026-09-01' },
      { range: 'custom', from: '2020-01-01', to: '2026-01-01' },
      { range: 'nonsense' },
      { range: 'custom' },
    ]) {
      expect(parseRange(params, now).preset).toBe('7d');
    }
  });

  it('takes the first value when a param is repeated', () => {
    expect(parseRange({ range: ['today', '30d'] }, now).preset).toBe('today');
  });

  it('builds a shareable href for each preset', () => {
    expect(rangeHref('/o/1', '30d')).toBe('/o/1?range=30d');

    const custom = parseRange({ range: 'custom', from: '2026-09-01', to: '2026-09-03' }, now);
    expect(rangeHref('/o/1', 'custom', custom)).toBe(
      '/o/1?range=custom&from=2026-09-01&to=2026-09-03'
    );
  });
});

describe('what a chart reports', () => {
  it('never reports the padding a flat series is drawn inside', () => {
    // A steady 100% cache hit ratio was once labelled "90% to 110%".
    expect(
      extent([
        { label: 'a', value: 100 },
        { label: 'b', value: 100 },
      ])
    ).toEqual({
      min: 100,
      max: 100,
    });

    // The band exists only so the line does not vanish into the axis.
    expect(plotBand(100, 100)).toEqual({ base: 90, span: 20 });
    expect(plotBand(2, 8)).toEqual({ base: 2, span: 6 });
  });

  it('ignores gaps when working out the range', () => {
    expect(
      extent([
        { label: 'a', value: 5 },
        { label: 'b', value: null },
        { label: 'c', value: 9 },
      ])
    ).toEqual({ min: 5, max: 9 });
  });

  it('has no range at all when nothing was collected', () => {
    expect(extent([{ label: 'a', value: null }])).toEqual({ min: 0, max: 0 });
  });
});
