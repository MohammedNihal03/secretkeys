import { Metric, formatCount, formatUsd } from '@/components/metric';
import type { UsageTotals } from '@/lib/usage/repository';

/**
 * A set of usage totals, rendered the same way everywhere they appear.
 *
 * One component so the provider page, the key page and the project page cannot
 * disagree about what "requests" means or about how a missing figure is shown.
 * Each metric falls back to the reason it is missing, which is nearly always
 * "this provider does not report it" rather than "nothing happened".
 */

export interface UsageTotalsGridProps {
  totals: UsageTotals;
  /** Named in the fallback text, e.g. "OpenAI does not report cost." */
  subject: string;
  /** True once a collection has run; before that, the reason is different. */
  collected: boolean;
  /** Extra metrics to append, for a page that has more to show. */
  children?: React.ReactNode;
}

export function UsageTotalsGrid({ totals, subject, collected, children }: UsageTotalsGridProps) {
  const notReported = (what: string) =>
    collected
      ? `${subject} does not report ${what}.`
      : 'No collection has run yet for this window.';

  const errorRate =
    totals.requests !== null && totals.failedRequests !== null && totals.requests > 0
      ? (totals.failedRequests / totals.requests) * 100
      : null;

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
      <Metric
        label="Requests"
        value={formatCount(totals.requests)}
        reason={notReported('request counts')}
        note={totals.intervals > 0 ? `${totals.intervals} intervals` : undefined}
      />
      <Metric
        label="Tokens"
        value={formatCount(totals.totalTokens)}
        reason={notReported('token usage')}
        note={
          totals.inputTokens !== null && totals.outputTokens !== null
            ? `${formatCount(totals.inputTokens)} in, ${formatCount(totals.outputTokens)} out`
            : undefined
        }
      />
      <Metric
        label="Cost"
        value={formatUsd(totals.estimatedCost)}
        reason={notReported('cost')}
        note={
          totals.costIntervals > 0 && totals.costIntervals < totals.intervals
            ? `${totals.costIntervals} of ${totals.intervals} intervals`
            : 'as reported by the provider'
        }
      />
      <Metric
        label="Errors"
        value={formatCount(totals.failedRequests)}
        reason={notReported('failed requests separately from successful ones')}
        note={errorRate !== null ? `${errorRate.toFixed(2)}% of requests` : undefined}
      />
      {totals.characters !== null || totals.audioSeconds !== null ? (
        <Metric
          label={totals.characters !== null ? 'Characters' : 'Audio'}
          value={
            totals.characters !== null
              ? formatCount(totals.characters)
              : totals.audioSeconds !== null
                ? `${Math.round(totals.audioSeconds / 60)} min`
                : null
          }
          reason={notReported('a speech meter')}
        />
      ) : null}
      {children}
    </div>
  );
}
