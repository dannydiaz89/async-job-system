import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { claimNextJob, createJob, getJob } from '@async-jobs/database';
import { withTestDatabase } from '../support/database.js';

const configuration = {
  durationMs: 100,
  failUntilAttempt: 0,
  maxAttempts: 3,
  chaosType: 'none' as const,
  chaosOnAttempt: null,
};

test('a second worker skips a row locked by another claimant', async () => {
  await withTestDatabase('concurrency', async ({ pool }) => {
    let lockingClient: pg.PoolClient | undefined;
    try {
      await createJob(pool, configuration);
      await createJob(pool, configuration);

      lockingClient = await pool.connect();
      await lockingClient.query('BEGIN');
      const locked = await lockingClient.query<{ id: string }>(`
        SELECT id FROM jobs
        WHERE status = 'PENDING'
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE
      `);
      const lockedId = locked.rows[0]!.id;

      const secondClaim = claimNextJob(pool, 'second-worker', 5_000);
      const claimedOrTimeout = await Promise.race([
        secondClaim,
        sleep(500).then(() => 'timed_out' as const),
      ]);
      assert.notEqual(claimedOrTimeout, 'timed_out', 'a SKIP LOCKED claim must not wait for the locked row');
      assert.ok(claimedOrTimeout);
      assert.notEqual(claimedOrTimeout.id, lockedId);
      assert.equal(claimedOrTimeout.status, 'RUNNING');
      assert.equal(claimedOrTimeout.leaseOwner, 'second-worker');

      const lockedJob = await getJob(pool, lockedId);
      assert.ok(lockedJob);
      assert.equal(lockedJob.status, 'PENDING');
    } finally {
      await lockingClient?.query('ROLLBACK').catch(() => undefined);
      lockingClient?.release();
    }
  }, { poolSize: 3 });
});
