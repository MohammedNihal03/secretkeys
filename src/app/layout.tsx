import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import { AmbientBackground } from '@/components/ambient-background';
import { readThemePreference } from '@/lib/theme-server';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'AI & Database Observability',
    template: '%s · AI & Database Observability',
  },
  description:
    'Self-hosted observability for AI provider usage, cost and limits, and PostgreSQL health.',
};

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  /**
   * The stored preference is rendered into the first HTML response, so the
   * correct theme is painted immediately. When it is `undefined` no attribute
   * is emitted and the stylesheet's `prefers-color-scheme` rules apply -- which
   * is why this must not default to `'light'`.
   */
  const theme = await readThemePreference();

  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="relative flex min-h-full flex-col">
        <AmbientBackground />
        {/* Content sits above the ambient layer, which is `z-0` and inert. */}
        <div className="relative z-10 flex min-h-[100dvh] flex-col">{children}</div>
      </body>
    </html>
  );
}
