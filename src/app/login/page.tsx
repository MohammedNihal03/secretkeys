import { redirect } from 'next/navigation';

import {
  AnthropicMark,
  DeepgramMark,
  ElevenLabsMark,
  GeminiMark,
  OpenAIMark,
  PostgresMark,
  QwenMark,
  type BrandMarkProps,
} from '@/components/brand-marks';
import { ThemeToggle } from '@/components/theme-toggle';
import { getCurrentUser } from '@/lib/auth/access';
import { safeRedirectPath } from '@/lib/auth/guards';
import { LoginForm } from './login-form';

/**
 * Sign-in page.
 *
 * Reads the session cookie, so it must not be prerendered.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in' };

/**
 * What the dashboard watches.
 *
 * Each mark carries its name as a `title`, so the row is not conveying meaning
 * through logo recognition alone.
 */
const MONITORS: { name: string; Mark: (props: BrandMarkProps) => React.ReactElement }[] = [
  { name: 'OpenAI', Mark: OpenAIMark },
  { name: 'Anthropic', Mark: AnthropicMark },
  { name: 'Google Gemini', Mark: GeminiMark },
  { name: 'Qwen', Mark: QwenMark },
  { name: 'ElevenLabs', Mark: ElevenLabsMark },
  { name: 'Deepgram', Mark: DeepgramMark },
  { name: 'PostgreSQL', Mark: PostgresMark },
];

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const { next } = await searchParams;
  const target = safeRedirectPath(typeof next === 'string' ? next : undefined);

  /**
   * An already-signed-in visitor is sent on rather than shown the form.
   *
   * This is the real validation, unlike the cookie-presence check in
   * `proxy.ts` -- a stale or forged cookie resolves to no user here and the
   * form is shown instead of bouncing in a loop.
   */
  if (await getCurrentUser()) {
    redirect(target ?? '/');
  }

  return (
    <>
      <ThemeToggle className="fixed right-5 top-5 z-20" />

      <main className="grid flex-1 place-items-center px-4 py-16 sm:px-6">
        <div className="animate-rise w-full max-w-[26rem]">
          {/* Outer tray -- the glass core sits inside it, concentric radii. */}
          <div className="bezel rounded-shell p-2">
            <div className="glass rounded-core flex flex-col gap-7 p-7 sm:p-8">
              <header className="flex flex-col gap-3">
                <span className="w-fit rounded-full border border-hairline px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted">
                  Observability
                </span>
                <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight text-balance">
                  AI &amp; Database Observability
                </h1>
                <p className="text-sm leading-relaxed text-muted">
                  Usage, cost, limits and database health in one place.
                </p>
              </header>

              <LoginForm next={target} />
            </div>
          </div>

          <div className="mt-7 flex flex-col items-center gap-3">
            <span className="text-[10px] uppercase tracking-[0.16em] text-faint">Monitors</span>
            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3 px-4">
              {MONITORS.map(({ name, Mark }) => (
                <span
                  key={name}
                  title={name}
                  className="text-faint/70 transition-colors duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-muted"
                >
                  <span className="sr-only">{name}</span>
                  <Mark className="size-[1.15rem]" />
                </span>
              ))}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
