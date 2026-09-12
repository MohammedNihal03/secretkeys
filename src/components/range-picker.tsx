import Link from 'next/link';

import { PRESETS, type TimeRange } from '@/lib/dashboard/range';

/**
 * The time range control.
 *
 * Links rather than a client component: each range is a real URL, so it can be
 * bookmarked, shared with whoever is being asked to look at the problem, and
 * opened in a second tab beside the first. A state toggle would give none of
 * that, and would cost a JavaScript bundle to take it away.
 *
 * The custom range is a plain form that navigates with GET, for the same
 * reason, and it works with JavaScript disabled.
 */

export function RangePicker({ range, base }: { range: TimeRange; base: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <nav
        aria-label="Time range"
        className="flex items-center gap-1 rounded-full border border-hairline bg-shell p-1"
      >
        {PRESETS.map((preset) => {
          const active = range.preset === preset.value;

          return (
            <Link
              key={preset.value}
              href={`${base}?range=${preset.value}`}
              aria-current={active ? 'page' : undefined}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                active
                  ? 'bg-foreground text-background'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              {preset.label}
            </Link>
          );
        })}
      </nav>

      <form
        method="get"
        action={base}
        className="flex flex-wrap items-center gap-1.5 rounded-full border border-hairline bg-shell px-2 py-1"
      >
        <input type="hidden" name="range" value="custom" />
        <label className="sr-only" htmlFor="range-from">
          From
        </label>
        <input
          id="range-from"
          type="date"
          name="from"
          defaultValue={range.from.toISOString().slice(0, 10)}
          className="rounded-full bg-transparent px-2 py-1 font-mono text-[11px] text-muted outline-none focus:text-foreground"
        />
        <span className="text-[11px] text-faint">to</span>
        <label className="sr-only" htmlFor="range-to">
          To
        </label>
        <input
          id="range-to"
          type="date"
          name="to"
          /* Inclusive to a reader, so one day back from the exclusive bound. */
          defaultValue={new Date(range.to.getTime() - 86_400_000).toISOString().slice(0, 10)}
          className="rounded-full bg-transparent px-2 py-1 font-mono text-[11px] text-muted outline-none focus:text-foreground"
        />
        <button
          type="submit"
          className="rounded-full px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-foreground"
        >
          Apply
        </button>
      </form>
    </div>
  );
}
