'use client';

import { useActionState } from 'react';

import { useSubmitWithoutReset } from '@/lib/forms/use-submit-without-reset';

import type { ProjectFormState } from '@/lib/projects/actions';
import {
  ENVIRONMENTS,
  ENVIRONMENT_LABELS,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  type Environment,
} from '@/lib/projects/schema';

/**
 * Create/edit form for a project.
 *
 * The same component serves both, because the only difference is the bound
 * action and the initial values -- duplicating it would let the two drift.
 */

const FIELD_CLASS =
  'w-full rounded-xl border border-hairline bg-surface-sunken px-3.5 py-2.5 text-sm text-foreground outline-none transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] placeholder:text-faint focus:border-hairline-strong';

const INITIAL_STATE: ProjectFormState = {};

export interface ProjectFormProps {
  action: (previous: ProjectFormState, formData: FormData) => Promise<ProjectFormState>;
  submitLabel: string;
  defaults?: {
    name?: string;
    description?: string | null;
    environment?: Environment;
  };
}

export function ProjectForm({ action, submitLabel, defaults }: ProjectFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  // Without this, a failed submit resets the environment select to its first option.
  const submit = useSubmitWithoutReset(formAction);

  return (
    <form action={formAction} onSubmit={submit} className="flex max-w-lg flex-col gap-5">
      <Field label="Name" htmlFor="name" error={state.errors?.name}>
        <input
          id="name"
          name="name"
          required
          maxLength={PROJECT_NAME_MAX}
          defaultValue={state.values?.name ?? defaults?.name}
          placeholder="FYIND"
          aria-invalid={Boolean(state.errors?.name)}
          aria-describedby={state.errors?.name ? 'name-error' : undefined}
          className={FIELD_CLASS}
        />
      </Field>

      <Field label="Description" htmlFor="description" error={state.errors?.description} optional>
        <textarea
          id="description"
          name="description"
          rows={3}
          maxLength={PROJECT_DESCRIPTION_MAX}
          defaultValue={state.values?.description ?? defaults?.description ?? ''}
          placeholder="What this project is for."
          aria-invalid={Boolean(state.errors?.description)}
          className={`${FIELD_CLASS} resize-y`}
        />
      </Field>

      <Field label="Environment" htmlFor="environment" error={state.errors?.environment}>
        <select
          id="environment"
          name="environment"
          defaultValue={state.values?.environment || defaults?.environment || 'production'}
          className={FIELD_CLASS}
        >
          {ENVIRONMENTS.map((environment) => (
            <option key={environment} value={environment}>
              {ENVIRONMENT_LABELS[environment]}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-faint">
          Usage is attributed by each API key&apos;s own environment, so a project can hold keys for
          several.
        </p>
      </Field>

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
        {pending ? 'Saving…' : submitLabel}
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
