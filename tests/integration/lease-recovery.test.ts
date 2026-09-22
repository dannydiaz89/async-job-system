import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import {
  claimNextJob,
  completeClaimedJob,
  createJob,
  getJob,
  recoverExpiredJobs,
  renewClaimedJobLease,
  requestJobCancellation,
  runMigrations,
} from '@async-jobs/database';
import { processClaimedJob, RETRY_DELAY_MS } from '../../apps/worker/src/runner.ts';
import { withTestDatabase } from '../support/database.js';

const configuration = {
  durationMs: 100,
  failUntilAttempt: 0,
  maxAttempts: 2,
  chaosType: 'none' as const,
  chaosOnAttempt: null,
};

async function claimRequired(pool: pg.Pool, workerId: string, leaseDurationMs: number) {
  const claimed = await claimNextJob(pool, workerId, leaseDurationMs);
  assert.ok(claimed, 'expected an eligible job to be claimed');
  return claimed;
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('crashing worker did not exit within five seconds'));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

test('workers renew leases, recover abandoned claims, reject stale writes, and recover an actual crash', async () => {
  await withTestDatabase('lease', async ({ pool, connectionString }) => {
    let crashingWorker: ChildProcess | undefined;
    try {

      const renewable = await createJob(pool, configuration);
      const renewableClaim = await claimRequired(pool, 'renewing-worker', 300);
      const originalLease = renewableClaim.leaseExpiresAt;
      await sleep(100);
      const renewed = await renewClaimedJobLease(pool, renewableClaim, 'renewing-worker', 1_000);
      assert.ok(renewed?.leaseExpiresAt);
      assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(originalLease ?? ''));
      await sleep(350);
      assert.deepEqual(await recoverExpiredJobs(pool, 25, RETRY_DELAY_MS), []);
      assert.equal((await completeClaimedJob(pool, renewableClaim, 'renewing-worker'))?.status, 'COMPLETED');
      assert.equal((await getJob(pool, renewable.id))?.status, 'COMPLETED');

      const abandoned = await createJob(pool, configuration);
      const staleClaim = await claimRequired(pool, 'stale-worker', 100);
      await sleep(200);
      const recovered = await recoverExpiredJobs(pool, 25, RETRY_DELAY_MS);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.id, abandoned.id);
      assert.equal(recovered[0]?.status, 'RETRYING');
      await sleep(RETRY_DELAY_MS + 75);
      const replacementClaim = await claimRequired(pool, 'replacement-worker', 1_000);
      assert.equal(replacementClaim.id, abandoned.id);
      assert.equal(replacementClaim.attempts, 2);
      assert.equal(await completeClaimedJob(pool, staleClaim, 'stale-worker'), null);
      await processClaimedJob(pool, 'stale-worker', staleClaim, 1_000);
      assert.equal((await getJob(pool, abandoned.id))?.status, 'RUNNING');
      await processClaimedJob(pool, 'replacement-worker', replacementClaim, 1_000);
      assert.equal((await getJob(pool, abandoned.id))?.status, 'COMPLETED');

      const cancelledAbandoned = await createJob(pool, configuration);
      await claimRequired(pool, 'cancelled-worker', 100);
      assert.equal((await requestJobCancellation(pool, cancelledAbandoned.id))?.status, 'RUNNING');
      await sleep(200);
      const cancelledRecovery = await recoverExpiredJobs(pool, 25, RETRY_DELAY_MS);
      assert.equal(cancelledRecovery[0]?.status, 'CANCELLED');
      assert.equal((await getJob(pool, cancelledAbandoned.id))?.status, 'CANCELLED');

      const crashJob = await createJob(pool, {
        ...configuration,
        chaosType: 'crash_worker',
        chaosOnAttempt: 1,
      });
      crashingWorker = spawn(process.execPath, ['apps/worker/dist/index.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: connectionString,
          WORKER_POLL_INTERVAL_MS: '50',
          WORKER_LEASE_DURATION_MS: '1000',
        },
        stdio: 'ignore',
      });
      const exited = await waitForExit(crashingWorker);
      assert.equal(exited.code, 1);
      crashingWorker = undefined;
      assert.equal((await getJob(pool, crashJob.id))?.status, 'RUNNING');
      assert.equal((await getJob(pool, crashJob.id))?.attempts, 1);

      await sleep(1_100);
      const crashRecovery = await recoverExpiredJobs(pool, 25, RETRY_DELAY_MS);
      assert.equal(crashRecovery[0]?.id, crashJob.id);
      assert.equal(crashRecovery[0]?.status, 'RETRYING');
      await sleep(RETRY_DELAY_MS + 75);
      const recoveredCrashClaim = await claimRequired(pool, 'crash-recovery-worker', 1_000);
      assert.equal(recoveredCrashClaim.id, crashJob.id);
      assert.equal(recoveredCrashClaim.attempts, 2);
      await processClaimedJob(pool, 'crash-recovery-worker', recoveredCrashClaim, 1_000);
      assert.equal((await getJob(pool, crashJob.id))?.status, 'COMPLETED');

      const finalCrashJob = await createJob(pool, {
        ...configuration,
        maxAttempts: 1,
        chaosType: 'crash_worker',
        chaosOnAttempt: 1,
      });
      crashingWorker = spawn(process.execPath, ['apps/worker/dist/index.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: connectionString,
          WORKER_POLL_INTERVAL_MS: '50',
          WORKER_LEASE_DURATION_MS: '1000',
        },
        stdio: 'ignore',
      });
      assert.equal((await waitForExit(crashingWorker)).code, 1);
      crashingWorker = undefined;
      await sleep(1_100);
      const finalCrashRecovery = await recoverExpiredJobs(pool, 25, RETRY_DELAY_MS);
      assert.equal(finalCrashRecovery[0]?.id, finalCrashJob.id);
      assert.equal(finalCrashRecovery[0]?.status, 'FAILED');
      assert.equal((await getJob(pool, finalCrashJob.id))?.attempts, 1);
    } finally {
      crashingWorker?.kill('SIGKILL');
    }
  }, { poolSize: 3 });
});
