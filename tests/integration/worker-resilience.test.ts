import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { createJob, getJob } from '@async-jobs/database';
import { runWorker } from '../../apps/worker/src/runner.ts';
import { withTestDatabase } from '../support/database.js';

/** A pool that refuses every connection until `outageEndsAt`, imitating a database outage. */
function withOutage(pool: pg.Pool, state: { failing: boolean; attempts: number }): pg.Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'connect' || property === 'query') {
        return (...args: unknown[]) => {
          if (state.failing) {
            state.attempts += 1;
            return Promise.reject(new Error('simulated database outage'));
          }
          return (Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as pg.Pool;
}

test('a worker survives a database outage and resumes without exiting', async () => {
  await withTestDatabase('resilience', async ({ pool }) => {
    const controller = new AbortController();
    const logged: string[] = [];
    const originalLog = console.log;
    try {

      const state = { failing: true, attempts: 0 };
      const flakyPool = withOutage(pool, state);

      console.log = (line: string) => { logged.push(line); };
      const worker = runWorker(flakyPool, {
        workerId: 'resilience-worker',
        pollIntervalMs: 50,
        leaseDurationMs: 5_000,
        signal: controller.signal,
      });
      // Surface an early exit as a failure rather than an unhandled rejection.
      let exited: unknown = null;
      void worker.then(() => { exited = 'resolved'; }, (error: unknown) => { exited = error; });

      // The outage lasts well beyond several poll intervals.
      await sleep(600);
      assert.equal(exited, null, 'worker must not exit while the database is unreachable');
      assert.ok(state.attempts > 1, 'worker must keep retrying rather than giving up');

      const failures = logged.filter((line) => line.includes('worker_poll_failed'));
      assert.ok(failures.length > 0, 'outage must be logged');
      const firstFailure = JSON.parse(failures[0]!);
      assert.equal(firstFailure.workerId, 'resilience-worker');
      assert.ok(firstFailure.backoffMs >= 50, 'failures must back off');

      // Restore the database and give the worker real work to prove it recovered.
      state.failing = false;
      const job = await createJob(pool, {
        durationMs: 100,
        failUntilAttempt: 0,
        maxAttempts: 2,
        chaosType: 'none',
        chaosOnAttempt: null,
      });

      const deadline = Date.now() + 15_000;
      let completed = false;
      while (Date.now() < deadline && !completed) {
        await sleep(100);
        completed = (await getJob(pool, job.id))?.status === 'COMPLETED';
      }

      assert.equal(exited, null, 'worker must still be running after the outage');
      assert.ok(completed, 'worker must process jobs again once the database returns');
      assert.ok(
        logged.some((line) => line.includes('worker_poll_recovered')),
        'recovery from the outage must be observable in the logs',
      );

      controller.abort();
      await worker;
    } finally {
      console.log = originalLog;
      controller.abort();
    }
  }, { poolSize: 3 });
});
