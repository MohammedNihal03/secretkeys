import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Disables stylistic rules that would fight Prettier. Must come last.
  prettier,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    'next-env.d.ts',
    // Generated SQL migrations and drizzle-kit metadata.
    'drizzle/**',
  ]),
]);

export default eslintConfig;
