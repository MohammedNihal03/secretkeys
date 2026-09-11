'use client';

import { useActionState, useState, useTransition } from 'react';

import { useSubmitWithoutReset } from '@/lib/forms/use-submit-without-reset';

import type { KeyActionResult, MetadataFormState } from '@/lib/credentials/actions';
import type { ApiKeyStatus } from '@/lib/credentials/status';
import { ENVIRONMENTS, ENVIRONMENT_LABELS, type Environment } from '@/lib/projects/schema';

/**
 * Controls for one registered key: check it again, pause it, or revoke it,
 * plus editing its non-secret details.
 *
 * The secret itself cannot be viewed or edited here -- only replaced by
 * registering a new key.
 */

const PILL =
  'rounded-full border border-hairline bg-shell px-4 py-2 text-sm font-medium text-muted transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground active:scale-[0.97] disabled:opacity-50';

export function KeyControls({
  apiKeyId,
  status,
  onCheck,
  onSetStatus,
}: {
  apiKeyId: string;
  status: ApiKeyStatus;
  onCheck: (apiKeyId: string) => Promise<KeyActionResult>;
  onSetStatus: (apiKeyId: string, status: ApiKeyStatus) => Promise<KeyActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<KeyActionResult>();

  function run(task: () => Promise<KeyActionResult>) {
    startTransition(async () => {
      setResult(await task());
    });
  }

  if (status === 'revoked') {
    return (
      <p className="text-sm text-muted">
        This key is revoked. Revocation is permanent; register a new key to replace it.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => onCheck(apiKeyId))}
          className={PILL}
        >
          {pending ? 'Working…' : 'Check again'}
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(() => onSetStatus(apiKeyId, status === 'active' ? 'disabled' : 'active'))
          }
          className={PILL}
        >
          {status === 'active' ? 'Disable' : 'Enable'}
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() => {
            // Irreversible, so it asks once.
            if (
              window.confirm(
                'Revoke this key? This is permanent — it can never be enabled again. Its usage history is kept.'
              )
            ) {
              run(() => onSetStatus(apiKeyId, 'revoked'));
            }
          }}
          className={PILL}
          style={{ color: 'var(--critical)' }}
        >
          Revoke
        </button>
      </div>

      {result ? (
        <p
          role="status"
          className="text-sm"
          style={{ color: result.ok ? 'var(--ok)' : 'var(--critical)' }}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

const FIELD =
  'w-full rounded-xl border border-hairline bg-surface-sunken px-3.5 py-2.5 text-sm text-foreground outline-none transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] placeholder:text-faint focus:border-hairline-strong';

const INITIAL: MetadataFormState = {};

export function KeyMetadataForm({
  action,
  defaults,
  providerName,
}: {
  action: (previous: MetadataFormState, formData: FormData) => Promise<MetadataFormState>;
  defaults: { keyName: string; environment: Environment; providerKeyId: string };
  providerName: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const submit = useSubmitWithoutReset(formAction);
  const values = state.values;

  return (
    <form action={formAction} onSubmit={submit} className="flex max-w-xl flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label htmlFor="keyName" className="text-xs font-medium tracking-wide text-muted">
            Key name
          </label>
          <input
            id="keyName"
            name="keyName"
            required
            defaultValue={values?.keyName ?? defaults.keyName}
            className={FIELD}
          />
          {state.errors?.keyName ? (
            <p role="alert" className="text-xs" style={{ color: 'var(--critical)' }}>
              {state.errors.keyName}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="environment" className="text-xs font-medium tracking-wide text-muted">
            Environment
          </label>
          <select
            id="environment"
            name="environment"
            defaultValue={values?.environment ?? defaults.environment}
            className={FIELD}
          >
            {ENVIRONMENTS.map((environment) => (
              <option key={environment} value={environment}>
                {ENVIRONMENT_LABELS[environment]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="providerKeyId" className="text-xs font-medium tracking-wide text-muted">
          {providerName} key ID <span className="ml-1 text-faint">optional</span>
        </label>
        <input
          id="providerKeyId"
          name="providerKeyId"
          defaultValue={values?.providerKeyId ?? defaults.providerKeyId}
          spellCheck={false}
          className={`${FIELD} font-mono`}
        />
        {state.errors?.providerKeyId ? (
          <p role="alert" className="text-xs" style={{ color: 'var(--critical)' }}>
            {state.errors.providerKeyId}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="w-fit rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98] disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save details'}
        </button>
        {state.saved ? (
          <span role="status" className="text-sm" style={{ color: 'var(--ok)' }}>
            Saved.
          </span>
        ) : null}
        {state.error ? (
          <span role="alert" className="text-sm" style={{ color: 'var(--critical)' }}>
            {state.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
