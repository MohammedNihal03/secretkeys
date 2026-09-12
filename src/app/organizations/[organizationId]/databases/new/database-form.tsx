'use client';

import { useActionState, useRef, useState } from 'react';

import { InlineNotice } from '@/components/notice';
import type { DatabaseFormState } from '@/lib/databases/actions';
import { useSubmitWithoutReset } from '@/lib/forms/use-submit-without-reset';
import { ENVIRONMENTS, ENVIRONMENT_LABELS, type Environment } from '@/lib/projects/schema';

/**
 * Monitored-database registration form.
 *
 * The password is a password input with autofill and spellcheck off, and it is
 * cleared after a failed attempt rather than echoed back: a secret that
 * round-trips through a re-render sits in a payload the browser can cache.
 *
 * Submission goes through `useSubmitWithoutReset` because React 19 resets a
 * form after its action runs, and a reset `<select>` falls back to its
 * mount-time option. Here that would silently move a database to a different
 * project or environment than the one chosen.
 */

const FIELD =
  'w-full rounded-xl border border-hairline bg-surface-sunken px-3.5 py-2.5 text-sm text-foreground outline-none transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] placeholder:text-faint focus:border-hairline-strong';

const LABEL = 'text-xs font-medium text-muted';
const ERROR = 'text-xs text-[var(--critical)]';

const INITIAL: DatabaseFormState = {};

export interface DatabaseFormProps {
  action: (previous: DatabaseFormState, formData: FormData) => Promise<DatabaseFormState>;
  projects: { id: string; name: string; environment: Environment }[];
  /** The exact grants a monitoring role needs, shown rather than described. */
  roleSql: string;
}

export function DatabaseForm({ action, projects, roleSql }: DatabaseFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const submit = useSubmitWithoutReset(formAction);

  const passwordRef = useRef<HTMLInputElement>(null);
  const [ssl, setSsl] = useState(true);
  const [unverified, setUnverified] = useState(false);

  const values = state.values ?? {};

  return (
    <form action={formAction} onSubmit={submit} className="flex flex-col gap-6">
      {state.error ? <InlineNotice tone="problem">{state.error}</InlineNotice> : null}
      {state.errors?.form ? <InlineNotice tone="problem">{state.errors.form}</InlineNotice> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label className={LABEL} htmlFor="name">
            Name
          </label>
          <input
            id="name"
            name="name"
            className={FIELD}
            defaultValue={values.name ?? ''}
            placeholder="Production primary"
            required
          />
          {state.errors?.name ? <p className={ERROR}>{state.errors.name}</p> : null}
        </div>

        <div className="flex flex-col gap-2">
          <label className={LABEL} htmlFor="projectId">
            Project
          </label>
          <select
            id="projectId"
            name="projectId"
            className={FIELD}
            defaultValue={values.projectId ?? projects[0]?.id ?? ''}
            required
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          {state.errors?.projectId ? <p className={ERROR}>{state.errors.projectId}</p> : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <label className={LABEL} htmlFor="host">
            Host
          </label>
          <input
            id="host"
            name="host"
            className={FIELD}
            defaultValue={values.host ?? ''}
            placeholder="db.internal.example.com"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <p className="text-[11px] text-faint">
            A host name or IP address only. No scheme, port or user.
          </p>
          {state.errors?.host ? <p className={ERROR}>{state.errors.host}</p> : null}
        </div>

        <div className="flex flex-col gap-2">
          <label className={LABEL} htmlFor="port">
            Port
          </label>
          <input
            id="port"
            name="port"
            type="number"
            inputMode="numeric"
            className={`${FIELD} font-mono tabular-nums`}
            defaultValue={values.port ?? '5432'}
            min={1}
            max={65535}
            required
          />
          {state.errors?.port ? <p className={ERROR}>{state.errors.port}</p> : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label className={LABEL} htmlFor="databaseName">
            Database
          </label>
          <input
            id="databaseName"
            name="databaseName"
            className={FIELD}
            defaultValue={values.databaseName ?? ''}
            placeholder="app_production"
            autoComplete="off"
            spellCheck={false}
            required
          />
          {state.errors?.databaseName ? <p className={ERROR}>{state.errors.databaseName}</p> : null}
        </div>

        <div className="flex flex-col gap-2">
          <label className={LABEL} htmlFor="environment">
            Environment
          </label>
          <select
            id="environment"
            name="environment"
            className={FIELD}
            defaultValue={values.environment ?? 'production'}
            required
          >
            {ENVIRONMENTS.map((environment) => (
              <option key={environment} value={environment}>
                {ENVIRONMENT_LABELS[environment]}
              </option>
            ))}
          </select>
          {state.errors?.environment ? <p className={ERROR}>{state.errors.environment}</p> : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label className={LABEL} htmlFor="username">
            Monitoring role
          </label>
          <input
            id="username"
            name="username"
            className={FIELD}
            defaultValue={values.username ?? ''}
            placeholder="observability"
            autoComplete="off"
            spellCheck={false}
            required
          />
          {state.errors?.username ? <p className={ERROR}>{state.errors.username}</p> : null}
        </div>

        <div className="flex flex-col gap-2">
          <label className={LABEL} htmlFor="password">
            Password
          </label>
          <input
            ref={passwordRef}
            id="password"
            name="password"
            type="password"
            className={FIELD}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <p className="text-[11px] text-faint">
            Encrypted before it is stored, and never shown again.
          </p>
          {state.errors?.password ? <p className={ERROR}>{state.errors.password}</p> : null}
        </div>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-hairline p-4">
        <legend className="px-1.5 text-xs font-medium text-muted">Transport</legend>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="sslEnabled"
            className="mt-0.5 size-4 accent-[var(--accent)]"
            checked={ssl}
            onChange={(event) => setSsl(event.target.checked)}
          />
          <span>
            Connect over TLS
            <span className="block text-[11px] text-faint">
              Required by most managed providers. The server certificate is verified.
            </span>
          </span>
        </label>

        {ssl ? (
          <>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="allowUnverifiedCertificate"
                className="mt-0.5 size-4 accent-[var(--accent)]"
                checked={unverified}
                onChange={(event) => setUnverified(event.target.checked)}
              />
              <span>
                Accept an unverified certificate
                <span className="block text-[11px] text-faint">
                  Encrypts the connection but does not prove which server answered, so it cannot
                  detect an interception. Prefer pasting the certificate authority below.
                </span>
              </span>
            </label>

            <div className="flex flex-col gap-2">
              <label className={LABEL} htmlFor="ca">
                Certificate authority (optional)
              </label>
              <textarea
                id="ca"
                name="ca"
                rows={3}
                className={`${FIELD} font-mono text-xs`}
                defaultValue={values.ca ?? ''}
                placeholder="-----BEGIN CERTIFICATE-----"
                spellCheck={false}
              />
              {state.errors?.ca ? <p className={ERROR}>{state.errors.ca}</p> : null}
            </div>
          </>
        ) : null}
      </fieldset>

      <details className="rounded-xl border border-hairline p-4">
        <summary className="cursor-pointer text-xs font-medium text-muted">
          What permissions does the monitoring role need?
        </summary>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          The collector only reads statistics views, over a read-only session with a five second
          statement timeout. It needs to connect, and it needs <code>pg_monitor</code> to see other
          users&rsquo; connections and queries. It never needs a superuser, and it can never write.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed text-muted">
          {roleSql}
        </pre>
      </details>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-95 active:scale-[0.98] disabled:opacity-60"
        >
          {pending ? 'Connecting…' : 'Add database'}
        </button>
        <p className="text-xs text-faint">The connection is tested before anything is saved.</p>
      </div>
    </form>
  );
}
