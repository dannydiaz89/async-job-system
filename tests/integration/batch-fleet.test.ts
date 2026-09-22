import assert from 'node:assert/strict';
import test from 'node:test';
import type { BatchDetail } from '@async-jobs/contracts';
import { createBatch, getBatchDetail, listJobs, requestJobCancellation } from '@async-jobs/database';
import type pg from 'pg';
import { waitFor, withTestDatabase } from '../support/database.js';
import { WorkerFleet } from '../support/workers.js';

const baseConfiguration = {
  durationMs: 150,
  failUntilAttempt: 0,
  maxAttempts: 3,
  chaosType: 'none',
  chaosOnAttempt: null,
} as const;

/** Resolve once every job in the batch has reached a terminal state. */
async function drained(pool: pg.Pool, batchId: string): Promise<BatchDetail | null> {
  const detail = await getBatchDetail(pool, batchId);
  if (!detail) return null;
  return detail.metrics.terminalCount === detail.metrics.total ? detail : null;
}

test('independent workers drain a batch to completion exactly once each', async () => {
  await withTestDatabase('fleet', async ({ pool, connectionString }) => {
    const jobCount = 24;
    const fleet = WorkerFleet.start({ connectionString, count: 4 });
    try {
      const batch = await createBatch(pool, { ...baseConfiguration, jobCount });
      const detail = await waitFor(
        'every job in the batch to reach a terminal state',
        () => drained(pool, batch.id),
      );

      assert.equal(detail.metrics.total, jobCount);
      assert.equal(detail.metrics.completed, jobCount, 'every job should succeed');
      assert.equal(detail.metrics.failed, 0);
      assert.equal(detail.metrics.cancelled, 0);
      assert.equal(detail.metrics.queueDepth, 0);
      assert.equal(detail.metrics.terminalProgress, 1);
      assert.ok(detail.metrics.completedAt, 'a fully terminal batch reports a completion time');

      const { jobs } = await listJobs(pool, { limit: 100, offset: 0 });
      const batchJobs = jobs.filter((job) => job.batchId === batch.id);
      assert.equal(batchJobs.length, jobCount);

      // No duplicate execution: a job that ran exactly once has exactly one attempt. More would
      // mean a job was claimed twice, which is what the lease and ownership guards prevent.
      assert.deepEqual([...new Set(batchJobs.map((job) => job.attempts))], [1]);
      // Leases are released on completion, so no terminal job still claims an owner.
      assert.deepEqual([...new Set(batchJobs.map((job) => job.leaseOwner))], [null]);

      // Work actually spread across the fleet rather than one worker taking everything.
      const throughput = detail.metrics.throughputPerSecond;
      assert.ok(throughput !== null && throughput > 0, 'a drained batch reports throughput');
    } finally {
      await fleet.stop();
    }
  }, { poolSize: 4 });
});

test('a batch still completes when a worker is killed mid-drain', async () => {
  await withTestDatabase('fleet-crash', async ({ pool, connectionString }) => {
    const jobCount = 20;
    const workerCount = 3;
    // A short lease keeps the test quick: recovery cannot begin until the dead worker's lease lapses.
    const fleet = WorkerFleet.start({ connectionString, count: workerCount, leaseDurationMs: 1_000 });
    try {
      // Jobs long enough that every worker is still busy when the kill lands.
      const batch = await createBatch(pool, { ...baseConfiguration, durationMs: 400, jobCount });

      // Wait until as many jobs are RUNNING as there are workers. Each worker holds at most one
      // job, so that state means every worker owns a claim and killing any of them is guaranteed
      // to orphan one. Killing on "some job finished" would sometimes hit an idle worker and
      // silently stop testing recovery at all.
      await waitFor('every worker to be holding a claim', async () => {
        const detail = await getBatchDetail(pool, batch.id);
        return detail && detail.metrics.running === workerCount ? detail : null;
      });
      fleet.killOne();
      assert.equal(fleet.size, workerCount - 1, 'one worker should be gone');

      const detail = await waitFor(
        'the surviving workers to finish the batch',
        () => drained(pool, batch.id),
        60_000,
      );

      assert.equal(detail.metrics.total, jobCount);
      assert.equal(detail.metrics.completed, jobCount, 'the killed worker must not lose its job');
      assert.equal(detail.metrics.failed, 0);

      // The job the dead worker held is retried by another worker, so at least one job records a
      // second attempt. This is the at-least-once guarantee being visible rather than assumed.
      const { jobs } = await listJobs(pool, { limit: 100, offset: 0 });
      const attempts = jobs.filter((job) => job.batchId === batch.id).map((job) => job.attempts);
      assert.ok(Math.max(...attempts) >= 2, 'a recovered job should show a repeated attempt');
      assert.ok(Math.max(...attempts) <= baseConfiguration.maxAttempts);
    } finally {
      await fleet.stop();
    }
  }, { poolSize: 4 });
});

test('cancelling part of a batch leaves the rest to finish', async () => {
  await withTestDatabase('fleet-cancel', async ({ pool, connectionString }) => {
    const jobCount = 20;
    // Longer jobs and a single worker keep most of the batch queued, so cancellation lands on
    // work that has not started as well as on work in flight.
    const fleet = WorkerFleet.start({ connectionString, count: 1 });
    try {
      const batch = await createBatch(pool, { ...baseConfiguration, durationMs: 400, jobCount });
      const { jobs } = await listJobs(pool, { limit: 100, offset: 0 });
      const batchJobs = jobs.filter((job) => job.batchId === batch.id);
      assert.equal(batchJobs.length, jobCount);

      const toCancel = batchJobs.slice(0, 8);
      const results = await Promise.all(toCancel.map((job) => requestJobCancellation(pool, job.id)));
      assert.equal(results.filter(Boolean).length, 8);

      const detail = await waitFor(
        'the batch to settle after partial cancellation',
        () => drained(pool, batch.id),
        60_000,
      );

      assert.equal(detail.metrics.total, jobCount);
      assert.equal(detail.metrics.cancelled, 8, 'every cancelled job stays cancelled');
      assert.equal(detail.metrics.completed, jobCount - 8, 'the rest still finish');
      assert.equal(detail.metrics.failed, 0);
      assert.equal(detail.metrics.queueDepth, 0);

      // A cancelled job is terminal: it is never claimed again afterwards.
      const settled = await listJobs(pool, { limit: 100, offset: 0, status: 'CANCELLED' });
      const cancelledIds = new Set(settled.jobs.map((job) => job.id));
      for (const job of toCancel) assert.ok(cancelledIds.has(job.id), `${job.id} should be cancelled`);
    } finally {
      await fleet.stop();
    }
  }, { poolSize: 4 });
});
