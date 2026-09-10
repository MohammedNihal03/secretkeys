import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Surface type errors at build time rather than shipping past them.
  // Next 16 removed `next lint`, so linting is a separate CI step.
  typescript: { ignoreBuildErrors: false },

  // `pg` is a native-ish driver and must stay external to the server bundle.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
