import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createPool } from '@async-jobs/database';
import { runWorker } from './runner.js';

const workerId = `${hostname()}:${randomUUID()}`;
const pool = createPool('async-jobs-worker');
const controller = new AbortController();
const pollIntervalMs = readPositiveInteger('WORKER_POLL_INTERVAL_MS', 500, 50, 10_000);
const leaseDurationMs = readPositiveInteger('WORKER_LEASE_DURATION_MS', 30_000, 1_000, 300_000);

function readPositiveInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function shutdown(signal: string) {
  if (controller.signal.aborted) return;
  console.log(JSON.stringify({ event: 'worker_stopping', workerId, signal }));
  controller.abort();
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main() {
  try {
    // No connectivity probe here. A probe outside the loop makes an outage at startup fatal:
    // the process exits before any retry logic applies, and under `tsx watch` it never comes
    // back. The poll loop already logs `worker_poll_failed` and backs off, so an unreachable
    // database at boot is handled the same way as one that disappears later.
    console.log(JSON.stringify({ event: 'worker_started', workerId, pollIntervalMs, leaseDurationMs }));
    await runWorker(pool, { workerId, pollIntervalMs, leaseDurationMs, signal: controller.signal });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
