import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { claimNextJob, createJob, getJob, requestJobCancellation } from '@async-jobs/database';
import { processClaimedJob, RETRY_DELAY_MS } from '../../apps/worker/src/runner.ts';
import { withTestDatabase } from '../support/database.js';

const workerId = 'phase-6-worker';

async function claimWhenReady(pool: pg.Pool) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const claimed = await claimNextJob(pool, workerId, 5_000);
    if (claimed) return claimed;
    await sleep(25);
  }
  assert.fail('expected a retry to become claimable');
}

test('worker retries deterministic failures and cooperatively resolves cancellation', async () => {
  await withTestDatabase('retry', async ({ pool }) => {

    const eventualSuccess = await createJob(pool, {
      durationMs: 100,
      failUntilAttempt: 1,
      maxAttempts: 2,
      chaosType: 'none',
      chaosOnAttempt: null,
    });
    const firstAttempt = await claimWhenReady(pool);
    await processClaimedJob(pool, workerId, firstAttempt);
    const retrying = await getJob(pool, eventualSuccess.id);
    assert.ok(retrying);
    assert.equal(retrying.status, 'RETRYING');
    assert.equal(retrying.attempts, 1);
    assert.match(retrying.error ?? '', /failUntilAttempt/);
    assert.equal(retrying.leaseOwner, null);

    await sleep(RETRY_DELAY_MS + 50);
    const secondAttempt = await claimWhenReady(pool);
    assert.equal(secondAttempt.id, eventualSuccess.id);
    assert.equal(secondAttempt.attempts, 2);
    await processClaimedJob(pool, workerId, secondAttempt);
    assert.equal((await getJob(pool, eventualSuccess.id))?.status, 'COMPLETED');

    const exhausted = await createJob(pool, {
      durationMs: 100,
      failUntilAttempt: 2,
      maxAttempts: 2,
      chaosType: 'none',
      chaosOnAttempt: null,
    });
    await processClaimedJob(pool, workerId, await claimWhenReady(pool));
    await sleep(RETRY_DELAY_MS + 50);
    await processClaimedJob(pool, workerId, await claimWhenReady(pool));
    const failed = await getJob(pool, exhausted.id);
    assert.ok(failed);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.attempts, 2);
    assert.ok(failed.completedAt);

    const chaosFailure = await createJob(pool, {
      durationMs: 100,
      failUntilAttempt: 0,
      maxAttempts: 2,
      chaosType: 'fail_task',
      chaosOnAttempt: 1,
    });
    await processClaimedJob(pool, workerId, await claimWhenReady(pool));
    await sleep(RETRY_DELAY_MS + 50);
    await processClaimedJob(pool, workerId, await claimWhenReady(pool));
    const chaosCompleted = await getJob(pool, chaosFailure.id);
    assert.ok(chaosCompleted);
    assert.equal(chaosCompleted.status, 'COMPLETED');
    assert.equal(chaosCompleted.attempts, 2);

    const runningCancellation = await createJob(pool, {
      durationMs: 1_000,
      failUntilAttempt: 0,
      maxAttempts: 2,
      chaosType: 'none',
      chaosOnAttempt: null,
    });
    const runningClaim = await claimWhenReady(pool);
    const processing = processClaimedJob(pool, workerId, runningClaim);
    await sleep(100);
    const cancellationRequested = await requestJobCancellation(pool, runningCancellation.id);
    assert.equal(cancellationRequested?.status, 'RUNNING');
    assert.equal(cancellationRequested?.cancelRequested, true);
    await processing;
    const cancelled = await getJob(pool, runningCancellation.id);
    assert.ok(cancelled);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.attempts, 1);
    assert.equal(cancelled.leaseOwner, null);
    assert.ok(cancelled.completedAt);

    const retryCancellation = await createJob(pool, {
      durationMs: 100,
      failUntilAttempt: 1,
      maxAttempts: 2,
      chaosType: 'none',
      chaosOnAttempt: null,
    });
    await processClaimedJob(pool, workerId, await claimWhenReady(pool));
    assert.equal((await getJob(pool, retryCancellation.id))?.status, 'RETRYING');
    const cancelledRetry = await requestJobCancellation(pool, retryCancellation.id);
    assert.equal(cancelledRetry?.status, 'CANCELLED');
    assert.equal(await claimNextJob(pool, workerId, 5_000), null);
  }, { poolSize: 2 });
});
