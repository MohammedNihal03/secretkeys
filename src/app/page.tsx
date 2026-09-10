import Link from 'next/link';

import { StatusBadge } from '@/components/status-badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { listMemberships } from '@/lib/auth/access';
import { signOut } from '@/lib/auth/actions';
import { requireUser } from '@/lib/auth/guards';
import { permissionsForRole } from '@/lib/auth/permissions';
import { getHealthReport } from '@/lib/health';

/**
 * Signed-in landing page.
 *
 * Phase 2 scope: it proves authentication, membership and role resolution work
 * end to end. The organization dashboard itself arrives in Phase 10, once
 * collectors are producing real metrics -- there is deliberately nothing here
 * that would need fabricated numbers to look finished.
 */

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  org_admin: 'Organization admin',
  developer: 'Developer',
};

export default async function Home() {
  // The real security boundary. `proxy.ts` only checked the cookie exists.
  const { user } = await requireUser('/');
  const [memberships, health] = await Promise.all([listMemberships(), getHealthReport()]);

  return (
    <>
      <header className="flex items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted">
          Observability
        </span>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-full border border-hairline bg-shell px-3.5 py-2 text-xs font-medium text-muted transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground active:scale-[0.97]"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-5 py-12 sm:px-6">
        <div className="animate-rise flex flex-col gap-3">
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight">
            Signed in as {user.name}
          </h1>
          <p className="text-sm text-muted">
            No metrics are being collected yet — collectors arrive in Phase 5.
          </p>
        </div>

        <section
          className="bezel rounded-shell animate-rise p-2"
          style={{ animationDelay: '80ms' }}
        >
          <div className="glass rounded-core divide-y" style={{ borderColor: 'var(--hairline)' }}>
            <Row label="System">
              <StatusBadge status={health.status} />
            </Row>
            <Row label="Dashboard database">
              <span className="flex items-center gap-3">
                <span className="font-mono text-xs text-faint">
                  {health.checks.database.latencyMs}ms
                </span>
                <StatusBadge status={health.checks.database.status} />
              </span>
            </Row>
            <Row label="Signed in as">
              <span className="font-mono text-xs text-muted">{user.email}</span>
            </Row>
          </div>
        </section>

        <section className="animate-rise flex flex-col gap-3" style={{ animationDelay: '160ms' }}>
          <h2 className="px-1 text-xs font-medium uppercase tracking-[0.14em] text-faint">
            Organizations
          </h2>

          {memberships.length === 0 ? (
            <p className="rounded-xl border border-hairline bg-shell px-4 py-3.5 text-sm text-muted">
              You are not a member of any organization yet. An administrator can add you, or create
              one with <code className="font-mono text-xs">npm run bootstrap</code>.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {memberships.map((membership) => (
                <li key={membership.organizationId}>
                  <Link
                    href={`/organizations/${membership.organizationId}`}
                    className="bezel rounded-shell block p-1.5 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5"
                  >
                    <div className="glass rounded-core px-4 py-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium">{membership.organizationName}</span>
                        <span className="rounded-full border border-hairline px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                          {ROLE_LABEL[membership.role] ?? membership.role}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs text-faint">
                        {permissionsForRole(membership.role).length} permissions
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="px-1 text-xs text-faint">
          Machine-readable health at{' '}
          <a className="font-mono underline underline-offset-4 hover:text-muted" href="/api/health">
            /api/health
          </a>
        </p>
      </main>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </div>
  );
}
