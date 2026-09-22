import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../../apps/api/src/app.ts';
import { withTestDatabase } from '../support/database.js';

const batchInput = {
  durationMs: 500,
  failUntilAttempt: 0,
  maxAttempts: 3,
  chaosType: 'none',
  chaosOnAttempt: null,
  jobCount: 3,
};

async function closeServer(server: ReturnType<ReturnType<typeof createApp>['listen']>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('batch API atomically creates jobs and reports derived metrics', async () => {
  await withTestDatabase('batch', async ({ pool }) => {
    let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
    try {
      server = createApp(pool).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const createResponse = await fetch(`${baseUrl}/batches`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batchInput),
      });
      assert.equal(createResponse.status, 201);
      const batch = await createResponse.json();
      assert.equal(createResponse.headers.get('location'), `/batches/${batch.id}`);
      assert.deepEqual(batch.configuration, batchInput);

      const jobs = await fetch(`${baseUrl}/jobs?limit=10`);
      const jobsPage = await jobs.json();
      assert.equal(jobsPage.page.total, 3);
      assert.ok(jobsPage.jobs.every((job: { batchId: string }) => job.batchId === batch.id));

      const initialDetailResponse = await fetch(`${baseUrl}/batches/${batch.id}`);
      assert.equal(initialDetailResponse.status, 200);
      const initialDetail = await initialDetailResponse.json();
      assert.deepEqual(initialDetail.metrics, {
        total: 3,
        pending: 3,
        running: 0,
        retrying: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        queueDepth: 3,
        terminalCount: 0,
        terminalProgress: 0,
        startedAt: null,
        completedAt: null,
        elapsedMs: initialDetail.metrics.elapsedMs,
        throughputPerSecond: 0,
      });
      assert.ok(initialDetail.metrics.elapsedMs >= 0);

      await pool.query(`
        WITH numbered AS (
          SELECT id, row_number() OVER (ORDER BY id) AS position
          FROM jobs WHERE batch_id = $1
        )
        UPDATE jobs AS job
        SET
          status = CASE numbered.position
            WHEN 1 THEN 'COMPLETED'::job_status
            WHEN 2 THEN 'FAILED'::job_status
            ELSE 'CANCELLED'::job_status
          END,
          started_at = now() - interval '3 seconds',
          completed_at = now(),
          error_message = CASE WHEN numbered.position = 2 THEN 'expected failure' ELSE null END
        FROM numbered
        WHERE job.id = numbered.id
      `, [batch.id]);

      const terminalDetailResponse = await fetch(`${baseUrl}/batches/${batch.id}`);
      const terminalDetail = await terminalDetailResponse.json();
      assert.deepEqual({
        total: terminalDetail.metrics.total,
        completed: terminalDetail.metrics.completed,
        failed: terminalDetail.metrics.failed,
        cancelled: terminalDetail.metrics.cancelled,
        queueDepth: terminalDetail.metrics.queueDepth,
        terminalCount: terminalDetail.metrics.terminalCount,
        terminalProgress: terminalDetail.metrics.terminalProgress,
      }, {
        total: 3, completed: 1, failed: 1, cancelled: 1, queueDepth: 0, terminalCount: 3, terminalProgress: 1,
      });
      assert.ok(terminalDetail.metrics.startedAt);
      assert.ok(terminalDetail.metrics.completedAt);
      assert.ok(terminalDetail.metrics.elapsedMs >= 0);
      assert.ok(terminalDetail.metrics.throughputPerSecond > 0);

      const listResponse = await fetch(`${baseUrl}/batches?limit=1&offset=0`);
      const list = await listResponse.json();
      assert.equal(list.page.total, 1);
      assert.equal(list.batches[0].id, batch.id);
      assert.equal((await fetch(`${baseUrl}/batches?limit=101`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/batches/not-a-uuid`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/batches/${randomUUID()}`)).status, 404);

      const invalidBatch = await fetch(`${baseUrl}/batches`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...batchInput, jobCount: 1_001 }),
      });
      assert.equal(invalidBatch.status, 400);
      assert.equal((await (await fetch(`${baseUrl}/batches`)).json()).page.total, 1);
    } finally {
      if (server) await closeServer(server);
    }
  }, { poolSize: 2 });
});
