'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';

import { InlineNotice } from '@/components/notice';
import type { RegisterFormState } from '@/lib/credentials/actions';
import { needsEndpoint } from '@/lib/credentials/requirements';
import { useSubmitWithoutReset } from '@/lib/forms/use-submit-without-reset';
import { ENVIRONMENTS, ENVIRONMENT_LABELS, type Environment } from '@/lib/projects/schema';

/**
 * API key registration form.
 *
 * The secret field is a password input with autofill and spellcheck off, so
 * the key is neither shown on screen nor sent to a browser spelling service.
 * After a failed submission every other field is restored, but the secret is
 * deliberately cleared and must be pasted again.
 */

const FIELD =
  'w-full rounded-xl border border-hairline bg-surface-sunken px-3.5 py-2.5 text-sm text-foreground outline-none transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] placeholder:text-faint focus:border-hairline-strong';

const INITIAL: RegisterFormState = {};

export interface ApiKeyFormProps {
  action: (previous: RegisterFormState, formData: FormData) => Promise<RegisterFormState>;
  projects: { id: string; name: string; environment: Environment }[];
  providers: {
    id: string;
    type: string;
    name: string;
    usage: 'per_key' | 'organization_admin' | 'none';
  }[];
  defaultProjectId?: string;
  providersHref: string;
}

export function ApiKeyForm({
  action,
  projects,
  providers,
  defaultProjectId,
  providersHref,
}: ApiKeyFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  /**
   * Submitting without React's automatic reset keeps every select on the value
   * the user chose. The provider select is the one that matters: after a reset
   * it silently fell back to the first provider, and the key was submitted
   * there instead of to the provider the user picked.
   */
  const submit = useSubmitWithoutReset(formAction);

  /**
   * With no automatic reset, the secret is cleared deliberately after a failed
   * attempt, so a rejected key does not stay sitting in the field.
   */
  const secretRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if ((state.errors || state.error) && secretRef.current) {
      secretRef.current.value = '';
    }
  }, [state]);

  const initialProvider = state.values?.providerId || providers[0]?.id || '';
  const [providerId, setProviderId] = useState(initialProvider);
  const provider = providers.find((candidate) => candidate.id === providerId);

  const showEndpoint = provider ? needsEndpoint(provider.type) : false;
  const showProviderKeyId = provider?.usage === 'organization_admin';

  const initialProject =
    state.values?.projectId ||
    (projects.some((project) => project.id === defaultProjectId) ? defaultProjectId : undefined) ||
    projects[0]?.id;

  return (
    <form
      action={formAction}
      onSubmit={submit}
      className="flex max-w-xl flex-col gap-5"
      autoComplete="off"
    >
      <Field label="Provider" htmlFor="providerId" error={state.errors?.providerId}>
        <select
          id="providerId"
          name="providerId"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          className={FIELD}
        >
          {providers.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-faint">
          Only providers this organization tracks are listed.{' '}
          <Link href={providersHref} className="underline underline-offset-4 hover:text-muted">
            Change which are tracked
          </Link>
          .
        </p>
      </Field>

      <Field label="Project" htmlFor="projectId" error={state.errors?.projectId}>
        <select id="projectId" name="projectId" defaultValue={initialProject} className={FIELD}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Key name" htmlFor="keyName" error={state.errors?.keyName}>
          <input
            id="keyName"
            name="keyName"
            required
            defaultValue={state.values?.keyName}
            placeholder="FYIND Production"
            className={FIELD}
          />
        </Field>

        <Field label="Environment" htmlFor="environment" error={state.errors?.environment}>
          <select
            id="environment"
            name="environment"
            defaultValue={state.values?.environment || 'production'}
            className={FIELD}
          >
            {ENVIRONMENTS.map((environment) => (
              <option key={environment} value={environment}>
                {ENVIRONMENT_LABELS[environment]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {showEndpoint ? (
        <Field label="Resource endpoint" htmlFor="baseUrl" error={state.errors?.baseUrl}>
          <input
            id="baseUrl"
            name="baseUrl"
            type="url"
            inputMode="url"
            defaultValue={state.values?.baseUrl}
            placeholder="https://my-resource.openai.azure.com"
            spellCheck={false}
            className={`${FIELD} font-mono`}
          />
          <p className="mt-1.5 text-xs text-faint">
            Shown on the resource&apos;s Keys and Endpoint page in the Azure portal. Only Azure
            OpenAI hosts are accepted.
          </p>
        </Field>
      ) : null}

      <Field label="API key" htmlFor="secret" error={state.errors?.secret}>
        <input
          id="secret"
          name="secret"
          ref={secretRef}
          type="password"
          required
          // Not a login password: stop managers offering to save or fill it.
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          className={`${FIELD} font-mono`}
        />
        <p className="mt-1.5 text-xs text-faint">
          Checked with {provider?.name ?? 'the provider'}, then encrypted before it is stored. Only
          the last four characters are ever shown again.
          {state.errors || state.error ? ' For safety it is cleared after a failed attempt.' : ''}
        </p>
      </Field>

      {showProviderKeyId ? (
        <Field
          label={`${provider?.name ?? 'Provider'} key ID`}
          htmlFor="providerKeyId"
          error={state.errors?.providerKeyId}
          optional
        >
          <input
            id="providerKeyId"
            name="providerKeyId"
            defaultValue={state.values?.providerKeyId}
            spellCheck={false}
            className={`${FIELD} font-mono`}
          />
          <div className="mt-2">
            <InlineNotice tone="info">
              {provider?.name} reports usage for the whole organization, labelled with its own ID
              for each key — not the key itself. Add that ID, shown in the {provider?.name} console,
              so usage can be attributed to this project. It can be added later.
            </InlineNotice>
          </div>
        </Field>
      ) : null}

      {state.error ? (
        <p
          role="alert"
          className="rounded-xl border px-3.5 py-2.5 text-sm"
          style={{
            borderColor: 'oklch(60% 0.21 22 / 0.3)',
            background: 'oklch(60% 0.21 22 / 0.08)',
            color: 'var(--critical)',
          }}
        >
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-fit rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? `Checking with ${provider?.name ?? 'provider'}…` : 'Validate and save'}
      </button>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  error,
  optional,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium tracking-wide text-muted">
        {label}
        {optional ? <span className="ml-1.5 text-faint">optional</span> : null}
      </label>
      {children}
      {error ? (
        <p
          id={`${htmlFor}-error`}
          role="alert"
          className="text-xs"
          style={{ color: 'var(--critical)' }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
