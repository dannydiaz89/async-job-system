/**
 * Scaling experiment: run the same workload with different worker counts and report what
 * actually happened.
 *
 * Method, and why each part is there:
 *  - Every run uses a freshly created database, so no competing work exists and no earlier run's
 *    rows affect claim order or metrics.
 *  - Workers are started and warmed with a throwaway batch before the measured batch is
 *    submitted, so process startup and first-connection cost are excluded from the measurement.
 *  - Each measured run submits its own fresh batch. Elapsed time is taken from the batch metrics
 *    the API itself derives (creation to last terminal job), so the number reported here is the
 *    same number the dashboard shows.
 *  - Wall-clock time around the whole run is recorded as a cross-check on that derived elapsed.
 *
 * Usage: pnpm scaling [--jobs 60] [--duration 1000] [--workers 1,5]
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import pg from 'pg';
import { createBatch, getBatchDetail, runMigrations } from '@async-jobs/database';
import { WorkerFleet } from '../tests/support/workers.js';

const sourceDatabaseUrl = process.env.DATABASE_URL ?? 'postgres://jobs:jobs@127.0.0.1:5432/jobs';

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const jobCount = Number(flag('jobs', '60'));
const durationMs = Number(flag('duration', '1000'));
const workerCounts = flag('workers', '1,5').split(',').map((value) => Number(value.trim()));

function databaseUrl(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const configuration = {
  durationMs,
  failUntilAttempt: 0,
  maxAttempts: 3,
  chaosType: 'none',
  chaosOnAttempt: null,
} as const;

async function drain(pool: pg.Pool, batchId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await getBatchDetail(pool, batchId);
    if (detail && detail.metrics.terminalCount === detail.metrics.total) return detail;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Batch ${batchId} did not drain within ${timeoutMs} ms`);
}

type Measurement = Readonly<{
  workers: number;
  elapsedMs: number;
  wallClockMs: number;
  throughputPerSecond: number;
  idealMs: number;
}>;

async function measure(pool: pg.Pool, connectionString: string, workers: number): Promise<Measurement> {
  const fleet = WorkerFleet.start({
    connectionString,
    count: workers,
    pollIntervalMs: 100,
    // Comfortably longer than one job, so no healthy worker is ever declared dead mid-run.
    leaseDurationMs: Math.max(10_000, durationMs * 4),
  });
  try {
    // Warm up: prove every worker is alive and claiming before anything is timed.
    const warmup = await createBatch(pool, { ...configuration, durationMs: 100, jobCount: workers * 3 });
    await drain(pool, warmup.id, 60_000);

    const startedAt = Date.now();
    const batch = await createBatch(pool, { ...configuration, jobCount });
    const detail = await drain(pool, batch.id, jobCount * durationMs * 3 + 60_000);
    const wallClockMs = Date.now() - startedAt;

    if (detail.metrics.completed !== jobCount) {
      throw new Error(`Expected ${jobCount} completed jobs, got ${detail.metrics.completed}`);
    }
    return {
      workers,
      elapsedMs: Math.round(detail.metrics.elapsedMs),
      wallClockMs,
      throughputPerSecond: detail.metrics.throughputPerSecond ?? 0,
      idealMs: (jobCount * durationMs) / workers,
    };
  } finally {
    await fleet.stop();
  }
}

async function main() {
  const databaseName = `async_jobs_scaling_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl('postgres'), max: 1 });
  let created = false;
  let pool: pg.Pool | undefined;

  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const connectionString = databaseUrl(databaseName);
    await runMigrations({ connectionString });
    pool = new pg.Pool({ connectionString, max: 4 });
    pool.on('error', () => undefined);

    const version = await pool.query<{ server_version: string }>('SHOW server_version');
    console.log(`Workload: ${jobCount} jobs x ${durationMs} ms  (${(jobCount * durationMs) / 1000}s of work)`);
    console.log(`Host: ${os.cpus().length} logical CPUs, PostgreSQL ${version.rows[0]?.server_version ?? 'unknown'}`);
    console.log(`Each run uses a fresh batch in a fresh database, after a warm-up batch.\n`);

    const results: Measurement[] = [];
    for (const workers of workerCounts) {
      process.stdout.write(`Running with ${workers} worker(s)… `);
      const result = await measure(pool, connectionString, workers);
      results.push(result);
      console.log(`${(result.elapsedMs / 1000).toFixed(1)}s`);
    }

    const baseline = results[0];
    console.log('\n| Workers | Elapsed | Wall clock | Throughput | Ideal | Efficiency | Speedup |');
    console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const result of results) {
      const efficiency = (result.idealMs / result.elapsedMs) * 100;
      const speedup = baseline ? baseline.elapsedMs / result.elapsedMs : 1;
      console.log(
        `| ${result.workers} `
        + `| ${(result.elapsedMs / 1000).toFixed(1)}s `
        + `| ${(result.wallClockMs / 1000).toFixed(1)}s `
        + `| ${result.throughputPerSecond.toFixed(2)}/s `
        + `| ${(result.idealMs / 1000).toFixed(1)}s `
        + `| ${efficiency.toFixed(0)}% `
        + `| ${speedup.toFixed(2)}x |`,
      );
    }
    console.log('\nEfficiency is ideal/elapsed: how close the run came to perfect parallelism.');
    console.log('Speedup is relative to the first worker count measured.');
  } finally {
    await pool?.end().catch(() => undefined);
    if (created) await adminPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
