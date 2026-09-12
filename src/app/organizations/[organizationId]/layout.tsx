import Link from 'next/link';

import { InlineNotice } from '@/components/notice';
import { ThemeToggle } from '@/components/theme-toggle';
import { signOut } from '@/lib/auth/actions';
import { requireOrgAccess } from '@/lib/auth/guards';
import { canManageAnything } from '@/lib/auth/permissions';

/**
 * Organization shell.
 *
 * The guard here is what protects every page beneath it: `requireOrgAccess`
 * 404s for a non-member, so a signed-in user cannot probe another tenant's
 * organization id. Child pages still guard their own mutations, because a
 * layout guard does not cover Server Actions.
 */

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  org_admin: 'Admin',
  developer: 'Developer',
};

export default async function OrganizationLayout({
  children,
  params,
}: LayoutProps<'/organizations/[organizationId]'>) {
  const { organizationId } = await params;
  const access = await requireOrgAccess(organizationId);

  const base = `/organizations/${organizationId}`;

  const links = [
    { href: base, label: 'Overview' },
    { href: `${base}/projects`, label: 'Projects' },
    { href: `${base}/keys`, label: 'API keys' },
    { href: `${base}/databases`, label: 'Databases' },
    { href: `${base}/providers`, label: 'Providers' },
  ];

  return (
    <>
      {/*
        One container width for the whole shell.

        The header and the navigation used to run edge to edge while the content
        below was capped at `max-w-4xl`, which left a wide empty gutter down both
        sides of every page on a desktop screen and made the header look detached
        from what it labelled. A dashboard is a dense surface: it should use the
        window it is given, with one shared gutter so every row starts on the
        same vertical line.
      */}
      <header className="mx-auto flex w-full max-w-(--shell-width) flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-8">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint transition-colors hover:text-muted"
          >
            Observability
          </Link>
          <span className="text-faint">/</span>
          <span className="text-sm font-medium">{access.organizationName}</span>
          <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
            {ROLE_LABEL[access.role] ?? access.role}
          </span>
        </div>

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

      <nav className="border-y border-hairline">
        <ul className="mx-auto flex w-full max-w-(--shell-width) gap-1 overflow-x-auto px-5 sm:px-8">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="inline-block whitespace-nowrap px-3 py-3 text-sm text-muted transition-colors duration-300 hover:text-foreground"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mx-auto w-full max-w-(--shell-width) flex-1 px-5 py-8 sm:px-8">
        {children}
      </div>

      {!canManageAnything(access.role) ? (
        <footer className="mx-auto w-full max-w-(--shell-width) px-5 pb-8 sm:px-8">
          {/*
            Deliberately not a StatusBadge: its "Unknown" label reads as a health
            state, which on a monitoring page suggests something is wrong.
          */}
          <InlineNotice tone="info">
            <strong className="font-medium text-foreground">Read-only access.</strong> You can see
            everything this organization tracks; an organization admin can change providers,
            projects and databases.
          </InlineNotice>
        </footer>
      ) : null}
    </>
  );
}
