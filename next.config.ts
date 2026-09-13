import type { NextConfig } from 'next';

// A relative import: `next.config.ts` is compiled on its own, without the `@/` alias.
import { staticSecurityHeaders } from './src/lib/security/headers';

const nextConfig: NextConfig = {
  // Surface type errors at build time rather than shipping past them.
  // Next 16 removed `next lint`, so linting is a separate CI step.
  typescript: { ignoreBuildErrors: false },

  // `pg` is a native-ish driver and must stay external to the server bundle.
  serverExternalPackages: ['pg'],

  // No `X-Powered-By: Next.js`: announcing the framework helps nobody but a scanner.
  poweredByHeader: false,

  /**
   * Headers that are identical on every response, API routes included. The
   * Content Security Policy is not here because it carries a per-request nonce;
   * it is set in `src/proxy.ts`.
   */
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: staticSecurityHeaders(process.env.NODE_ENV === 'production'),
      },
    ];
  },
};

export default nextConfig;
