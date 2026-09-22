import assert from 'node:assert/strict';
import test from 'node:test';
import { claimNextJob, createJob, getJob } from '@async-jobs/database';
import { processClaimedJob } from '../../apps/worker/src/runner.ts';
import { withTestDatabase } from '../support/database.js';

test('a worker claims and completes one synthetic job outside its claim transaction', async () => {
  await withTestDatabase('worker', async ({ pool }) => {
    const created = await createJob(pool, {
      durationMs: 150,
      failUntilAttempt: 0,
      maxAttempts: 3,
      chaosType: 'none',
      chaosOnAttempt: null,
    });

    const workerId = 'phase-4-worker';
    const claimed = await claimNextJob(pool, workerId, 5_000);
    assert.ok(claimed);
    assert.equal(claimed.id, created.id);
    assert.equal(claimed.status, 'RUNNING');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.leaseOwner, workerId);
    assert.ok(claimed.startedAt);
    assert.ok(claimed.leaseExpiresAt);

    const startedAt = Date.now();
    await processClaimedJob(pool, workerId, claimed);
    assert.ok(Date.now() - startedAt >= 125);

    const completed = await getJob(pool, created.id);
    assert.ok(completed);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.attempts, 1);
    assert.equal(completed.leaseOwner, null);
    assert.equal(completed.leaseExpiresAt, null);
    assert.ok(completed.completedAt);
    assert.equal(await claimNextJob(pool, workerId, 5_000), null);
  }, { poolSize: 2 });
});
