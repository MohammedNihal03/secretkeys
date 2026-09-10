import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      // Integration tests need a real PostgreSQL instance, so they are opt-in
      // via `npm run test:integration`.
      '**/*.integration.test.ts',
    ],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/lib/**'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
