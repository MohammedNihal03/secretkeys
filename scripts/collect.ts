import { config as loadDotenv } from 'dotenv';

import { runCollection } from '@/lib/collector/runner';
import { closePool } from '@/lib/db/client';

loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env', quiet: true });

/**
 * Runs one collection.
 *
 * This is the scheduler: an external one. A cron entry, a systemd timer or a
 * Windows scheduled task calling this is more dependable than an interval
 * inside the web process, which would collect twice when two instances run and
 * not at all while none is awake.
 *
 *   npm run collect
 *   npm run collect -- --org=<uuid> --concurrency=2 --window-days=3
 *
 * Exits non-zero only when the run could not be carried out, so a cron job
 * alerts on a broken collector but not on one provider being down -- that is
 * recorded per credential and belongs on the dashboard, not in cron mail.
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

async function main(): Promise<void> {
  const summary = await runCollection({
    organizationId: flag('org'),
    concurrency: positiveInt(flag('concurrency')),
    usageWindowDays: positiveInt(flag('window-days')),
    logger: (message) => console.log(`  ${message}`),
  });

  if (!summary.ran) {
    console.log('\nAnother collection is already running. Nothing was done.');
    return;
  }

  console.log(
    `\nCollected ${summary.targets} credential(s) in ${(summary.durationMs / 1000).toFixed(1)}s`
  );
  console.log(
    `  success ${summary.success}   partial ${summary.partial}   failed ${summary.failed}   skipped ${summary.skipped}`
  );
  console.log(`  usage rows: ${summary.usageEntries} collected, ${summary.usagePersisted} stored`);

  const providers = Object.entries(summary.byProvider);
  if (providers.length > 0) {
    console.log('\nBy provider:');
    for (const [name, stats] of providers.sort(([a], [b]) => a.localeCompare(b))) {
      console.log(
        `  ${name.padEnd(16)} ${stats.success}/${stats.targets} ok, ${stats.partial} partial, ${stats.failed} failed, ${stats.usageEntries} usage rows`
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
