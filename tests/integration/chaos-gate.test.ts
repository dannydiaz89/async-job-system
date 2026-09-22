import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../../apps/api/src/app.ts';
import { withTestDatabase } from '../support/database.js';

const chaosJob = {
  durationMs: 200,
  failUntilAttempt: 0,
  maxAttempts: 2,
  chaosType: 'crash_worker',
  chaosOnAttempt: 1,
};
const plainJob = { ...chaosJob, chaosType: 'none', chaosOnAttempt: null };

async function closeServer(server: ReturnType<ReturnType<typeof createApp>['listen']>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function post(baseUrl: string, path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('chaos configuration is admitted only when the API enables it', async () => {
  await withTestDatabase('chaos', async ({ pool }) => {
    let disabled: Awaited<ReturnType<typeof listen>> | undefined;
    let enabled: Awaited<ReturnType<typeof listen>> | undefined;
    try {

      disabled = await listen(createApp(pool, { chaosEnabled: false }));
      enabled = await listen(createApp(pool, { chaosEnabled: true }));

      // Disabled: chaos is refused at admission, ordinary work is unaffected.
      const refusedJob = await post(disabled.baseUrl, '/jobs', chaosJob);
      assert.equal(refusedJob.status, 403);
      assert.match((await refusedJob.json()).error, /ENABLE_CHAOS/);

      const refusedBatch = await post(disabled.baseUrl, '/batches', { ...chaosJob, jobCount: 3 });
      assert.equal(refusedBatch.status, 403);

      assert.equal((await post(disabled.baseUrl, '/jobs', plainJob)).status, 201);
      assert.equal((await post(disabled.baseUrl, '/batches', { ...plainJob, jobCount: 2 })).status, 201);

      // Retries stay demonstrable without chaos: failUntilAttempt is not gated.
      assert.equal((await post(disabled.baseUrl, '/jobs', { ...plainJob, failUntilAttempt: 1 })).status, 201);

      // Enabled: the same chaos submissions are accepted and persisted intact.
      const acceptedJob = await post(enabled.baseUrl, '/jobs', chaosJob);
      assert.equal(acceptedJob.status, 201);
      assert.equal((await acceptedJob.json()).configuration.chaosType, 'crash_worker');

      assert.equal((await post(enabled.baseUrl, '/batches', { ...chaosJob, jobCount: 3 })).status, 201);

      // Invalid chaos configuration is still a validation error, not an authorization one.
      const invalid = await post(enabled.baseUrl, '/jobs', { ...chaosJob, chaosOnAttempt: null });
      assert.equal(invalid.status, 400);

      // The health route reports the gate so a demo can confirm it without guessing.
      assert.equal((await (await fetch(`${disabled.baseUrl}/health`)).json()).chaosEnabled, false);
      assert.equal((await (await fetch(`${enabled.baseUrl}/health`)).json()).chaosEnabled, true);
    } finally {
      if (disabled) await closeServer(disabled.server);
      if (enabled) await closeServer(enabled.server);
    }
  }, { poolSize: 2 });
});
