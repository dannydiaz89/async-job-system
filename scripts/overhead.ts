/**
 * Where does a worker's time go?
 *
 * The scaling experiment reports efficiency below 100%. This script explains that gap by
 * decomposing it, using the database's own timestamps rather than instrumentation inside the
 * worker, so the numbers come from the same source the API and dashboard report.
 *
 * For one worker draining a batch serially:
 *   in-job   = completed_at - started_at, minus the job's configured duration
 *   between  = next started_at - previous completed_at (claim, recovery pass, completion write)
 *
 * Sweeping the duration changes how many 250 ms cancellation-check slices each job is cut into,
 * which separates fixed per-job cost from per-slice cost.
 *
 * Usage: pnpm overhead [--jobs 24] [--durations 250,500,1000,2000]
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createBatch, getBatchDetail, runMigrations } from '@async-jobs/database';
import { WorkerFleet } from '../tests/support/workers.js';

const CANCELLATION_SLICE_MS = 250;
const sourceDatabaseUrl = process.env.DATABASE_URL ?? 'postgres://jobs:jobs@127.0.0.1:5432/jobs';

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const jobCount = Number(flag('jobs', '24'));
const durations = flag('durations', '250,500,1000,2000').split(',').map((v) => Number(v.trim()));

function databaseUrl(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const base = { failUntilAttempt: 0, maxAttempts: 3, chaosType: 'none', chaosOnAttempt: null } as const;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

async function drain(pool: pg.Pool, batchId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const detail = await getBatchDetail(pool, batchId);
    if (detail && detail.metrics.terminalCount === detail.metrics.total) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Batch ${batchId} did not drain`);
}

async function measure(pool: pg.Pool, durationMs: number) {
  const batch = await createBatch(pool, { ...base, durationMs, jobCount });
  await drain(pool, batch.id);

  const rows = await pool.query<{ in_job_ms: string; gap_ms: string | null }>(`
    SELECT
      EXTRACT(epoch FROM (completed_at - started_at)) * 1000 AS in_job_ms,
      EXTRACT(epoch FROM (started_at - lag(completed_at) OVER (ORDER BY started_at))) * 1000 AS gap_ms
    FROM jobs WHERE batch_id = $1 ORDER BY started_at
  `, [batch.id]);

  const inJob = rows.rows.map((row) => Number(row.in_job_ms));
  const gaps = rows.rows.map((row) => row.gap_ms).filter((gap): gap is string => gap !== null).map(Number);
  const slices = Math.ceil(durationMs / CANCELLATION_SLICE_MS);
  const inJobOverhead = mean(inJob) - durationMs;
  return { durationMs, slices, inJobOverhead, perSlice: inJobOverhead / slices, between: mean(gaps) };
}

async function main() {
  const name = `async_jobs_overhead_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl('postgres'), max: 1 });
  let created = false;
  let pool: pg.Pool | undefined;
  let fleet: WorkerFleet | undefined;

  try {
    await adminPool.query(`CREATE DATABASE "${name}"`);
    created = true;
    const connectionString = databaseUrl(name);
    await runMigrations({ connectionString });
    pool = new pg.Pool({ connectionString, max: 4 });
    pool.on('error', () => undefined);

    // One worker, so jobs run strictly serially and the gap between them is unambiguous.
    fleet = WorkerFleet.start({ connectionString, count: 1, pollIntervalMs: 100, leaseDurationMs: 60_000 });
    const warmup = await createBatch(pool, { ...base, durationMs: 100, jobCount: 3 });
    await drain(pool, warmup.id);

    console.log(`One worker, ${jobCount} jobs per duration. Times are per job.\n`);
    console.log('| Duration | Slices | In-job overhead | Per slice | Between jobs | Total | Efficiency |');
    console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const durationMs of durations) {
      const r = await measure(pool, durationMs);
      const total = r.inJobOverhead + r.between;
      console.log(
        `| ${r.durationMs} ms | ${r.slices} | ${r.inJobOverhead.toFixed(1)} ms | ${r.perSlice.toFixed(1)} ms `
        + `| ${r.between.toFixed(1)} ms | ${total.toFixed(1)} ms | ${((r.durationMs / (r.durationMs + total)) * 100).toFixed(1)}% |`,
      );
    }
    console.log(
      `\nEach job is cut into ${CANCELLATION_SLICE_MS} ms slices so cancellation stays responsive.`
      + '\nA rising in-job overhead with slice count is the cost of that responsiveness.',
    );
  } finally {
    await fleet?.stop();
    await pool?.end().catch(() => undefined);
    if (created) await adminPool.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
