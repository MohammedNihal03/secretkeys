import { config as loadDotenv } from 'dotenv';

/**
 * Integration tests run outside Next.js, which would normally load these files.
 * Vite only exposes `VITE_`-prefixed variables to `import.meta.env`, so
 * `process.env.DATABASE_URL` has to be populated explicitly.
 *
 * `.env.local` takes precedence, matching Next.js resolution order.
 */
loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env', quiet: true });
