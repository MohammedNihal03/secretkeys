import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests. These require a real PostgreSQL instance with migrations
 * applied, reached via DATABASE_URL.
 *
 * They run serially: each test writes real rows, and a shared database makes
 * parallel workers a source of false failures rather than useful signal.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.integration.test.ts'],
    setupFiles: ['./tests/setup.integration.ts'],
    fileParallelism: false,
    // A refused connection should fail fast rather than sit at the default timeout.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
