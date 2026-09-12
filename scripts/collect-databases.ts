import { config as loadDotenv } from 'dotenv';

import { runDatabaseCollection } from '@/lib/databases/runner';
import { discardingDatabaseSink } from '@/lib/databases/sink';
import { closePool } from '@/lib/db/client';

loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env', quiet: true });

/**
 * Runs one PostgreSQL monitoring collection.
 *
 * External scheduler, for the same reason the AI collector uses one: an
 * interval inside the web process collects twice when two instances run, and
 * not at all while none is awake.
 *
 *   npm run collect:db
 *   npm run collect:db -- --org=<uuid> --concurrency=2
 *   npm run collect:db -- --dry-run     # connect and read, store nothing
 *
 * Exits non-zero only when the run itself could not be carried out, so cron
 * alerts on a broken collector rather than on one database being down -- that
 * is recorded per target and belongs on the dashboard.
 */

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    console.log('Dry run: databases will be read, but no metrics will be stored.\n');
  }

  const summary = await runDatabaseCollection({
    organizationId: flag('org'),
    concurrency: positiveInt(flag('concurrency')),
    ...(dryRun ? { sink: discardingDatabaseSink } : {}),
    logger: (message) => console.log(`  ${message}`),
  });

  if (!summary.ran) {
    console.log('\nAnother database collection is already running. Nothing was done.');
    return;
  }

  console.log(
    `\nChecked ${summary.targets} database(s) in ${(summary.durationMs / 1000).toFixed(1)}s`
  );
  console.log(
    `  success ${summary.success}   partial ${summary.partial}   failed ${summary.failed}   skipped ${summary.skipped}`
  );
  console.log(`  metrics stored: ${summary.metricsStored}`);

  if (summary.snapshots.length > 0) {
    console.log('\nBy database:');

    for (const snapshot of summary.snapshots) {
      const size = snapshot.resources.databaseSizeBytes;
      const connections = snapshot.connections.current;
      const utilization = snapshot.connections.utilizationPercent;

      console.log(
        `  ${snapshot.target.name.padEnd(24)} ${snapshot.status.padEnd(10)} ` +
          `${String(snapshot.health.responseTimeMs).padStart(5)}ms  ` +
          `${size.available ? formatBytes(size.value).padStart(8) : '       —'}  ` +
          `${connections.available ? `${connections.value} conn` : 'connections unknown'}` +
          `${utilization.available ? ` (${utilization.value}% of max)` : ''}`
      );
    }
  }

  if (summary.problems.length > 0) {
    console.log('\nNeeds attention:');
    for (const problem of summary.problems) console.log(`  - ${problem}`);
  }
}

main()
  .catch((error: unknown) => {
    // Never dump the error object: a driver error can echo the connection string.
    console.error(`Collection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
