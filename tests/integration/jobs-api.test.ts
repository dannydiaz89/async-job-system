import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../../apps/api/src/app.ts';
import { withTestDatabase } from '../support/database.js';

const validJob = {
  durationMs: 5_000,
  failUntilAttempt: 0,
  maxAttempts: 3,
  chaosType: 'none',
  chaosOnAttempt: null,
};

async function closeServer(server: ReturnType<ReturnType<typeof createApp>['listen']>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('job API persists, lists, reads, and cancels jobs', async () => {
  await withTestDatabase('api', async ({ pool }) => {
    let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
    try {
      const app = createApp(pool);
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const specResponse = await fetch(`${baseUrl}/openapi.json`);
      assert.equal(specResponse.status, 200);
      const specification = await specResponse.json();
      assert.equal(specification.openapi, '3.1.0');
      assert.deepEqual(Object.keys(specification.paths).sort(), [
        '/batches', '/batches/{id}', '/health', '/jobs', '/jobs/{id}', '/jobs/{id}/cancel',
      ]);
      assert.equal(specification.paths['/jobs'].post.operationId, 'createJob');
      const docsResponse = await fetch(`${baseUrl}/docs/`);
      assert.equal(docsResponse.status, 200);
      assert.match(await docsResponse.text(), /swagger-ui/);

      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validJob),
      });
      assert.equal(createResponse.status, 201);
      const created = await createResponse.json();
      assert.equal(createResponse.headers.get('location'), `/jobs/${created.id}`);
      assert.deepEqual({
        status: created.status,
        attempts: created.attempts,
        maxAttempts: created.maxAttempts,
        configuration: created.configuration,
        cancelRequested: created.cancelRequested,
      }, {
        status: 'PENDING', attempts: 0, maxAttempts: 3, configuration: validJob, cancelRequested: false,
      });

      const invalidResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...validJob, durationMs: 5 }),
      });
      assert.equal(invalidResponse.status, 400);

      const secondCreate = await fetch(`${baseUrl}/jobs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validJob),
      });
      assert.equal(secondCreate.status, 201);

      const pageResponse = await fetch(`${baseUrl}/jobs?limit=1&offset=1`);
      assert.equal(pageResponse.status, 200);
      const page = await pageResponse.json();
      assert.equal(page.page.total, 2);
      assert.equal(page.jobs.length, 1);
      assert.equal((await fetch(`${baseUrl}/jobs?limit=101`)).status, 400);

      const detailResponse = await fetch(`${baseUrl}/jobs/${created.id}`);
      assert.equal(detailResponse.status, 200);
      assert.equal((await detailResponse.json()).id, created.id);
      assert.equal((await fetch(`${baseUrl}/jobs/not-a-uuid`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/jobs/${randomUUID()}`)).status, 404);

      const cancelResponse = await fetch(`${baseUrl}/jobs/${created.id}/cancel`, { method: 'POST' });
      assert.equal(cancelResponse.status, 200);
      const cancelled = await cancelResponse.json();
      assert.equal(cancelled.status, 'CANCELLED');
      assert.equal(cancelled.cancelRequested, true);
      assert.ok(cancelled.completedAt);

      const repeatedCancel = await fetch(`${baseUrl}/jobs/${created.id}/cancel`, { method: 'POST' });
      assert.equal(repeatedCancel.status, 200);
      assert.equal((await repeatedCancel.json()).status, 'CANCELLED');

      const cancelledList = await fetch(`${baseUrl}/jobs?status=CANCELLED`);
      assert.equal(cancelledList.status, 200);
      assert.equal((await cancelledList.json()).page.total, 1);

      const runningInsert = await pool.query<{ id: string }>(`
        INSERT INTO jobs (status, configuration, max_attempts, started_at, lease_owner, lease_expires_at)
        VALUES ('RUNNING', $1::jsonb, 3, now(), 'test-worker', now() + interval '30 seconds')
        RETURNING id
      `, [JSON.stringify(validJob)]);
      const runningId = runningInsert.rows[0]!.id;
      const runningCancel = await fetch(`${baseUrl}/jobs/${runningId}/cancel`, { method: 'POST' });
      assert.equal(runningCancel.status, 202);
      const running = await runningCancel.json();
      assert.equal(running.status, 'RUNNING');
      assert.equal(running.cancelRequested, true);
    } finally {
      if (server) await closeServer(server);
    }
  }, { poolSize: 2 });
});
