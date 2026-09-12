'use client';

import { useActionState } from 'react';

import { InlineNotice } from '@/components/notice';
import {
  recheckDatabaseAction,
  setDatabaseStatusAction,
  type CheckState,
} from '@/lib/databases/actions';
import { useSubmitWithoutReset } from '@/lib/forms/use-submit-without-reset';

/**
 * Checking a database now, and pausing collection.
 *
 * "Check now" exists because the collector runs on a schedule an operator does
 * not control: after fixing a firewall rule or granting `pg_monitor`, waiting
 * fifteen minutes to find out whether it worked is the wrong feedback loop.
 *
 * Pausing is a separate idea from health. A paused database is one nobody wants
 * connected to right now (a maintenance window, a decommission in progress);
 * it is not a database that is down, and the list says so differently.
 */

const BUTTON =
  'rounded-full border border-hairline bg-shell px-3.5 py-2 text-xs font-medium text-muted transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground active:scale-[0.97] disabled:opacity-60';

const INITIAL: CheckState = {};

export function DatabaseControls({
  organizationId,
  databaseId,
  status,
}: {
  organizationId: string;
  databaseId: string;
  status: 'active' | 'disabled';
}) {
  const check = recheckDatabaseAction.bind(null, organizationId, databaseId);
  const [state, checkAction, pending] = useActionState(check, INITIAL);
  const submitCheck = useSubmitWithoutReset(checkAction);

  async function toggle() {
    await setDatabaseStatusAction(
      organizationId,
      databaseId,
      status === 'active' ? 'disabled' : 'active'
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <form action={checkAction} onSubmit={submitCheck}>
          <button type="submit" className={BUTTON} disabled={pending}>
            {pending ? 'Checking…' : 'Check now'}
          </button>
        </form>

        <form action={toggle}>
          <button type="submit" className={BUTTON}>
            {status === 'active' ? 'Pause collection' : 'Resume collection'}
          </button>
        </form>
      </div>

      {state.message ? (
        <div className="max-w-[42ch]">
          <InlineNotice tone={state.tone === 'ok' ? 'info' : 'problem'}>
            {state.message}
          </InlineNotice>
        </div>
      ) : null}

      {status !== 'active' ? (
        <p className="text-[11px] text-faint">
          Collection is paused. Nothing connects to this database until it resumes.
        </p>
      ) : null}
    </div>
  );
}
