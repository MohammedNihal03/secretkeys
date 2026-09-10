import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside Next.js, which would otherwise load .env for us.
loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env', quiet: true });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and set it.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
