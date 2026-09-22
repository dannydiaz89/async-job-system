import assert from 'node:assert/strict';
import test from 'node:test';
import { runMigrations } from '@async-jobs/database';
import { withTestDatabase } from '../support/database.js';

test('migrations are repeatable and enforce job invariants', async () => {
  // This test owns the migration runner, so it asks for an empty database rather than a migrated one.
  await withTestDatabase('migrations', async ({ pool, connectionString }) => {
    assert.deepEqual(await runMigrations({ connectionString }), { applied: ['001_initial_schema.sql'] });
    assert.deepEqual(await runMigrations({ connectionString }), { applied: [] });

    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    assert.deepEqual(tables.rows.map((row) => row.table_name), ['batches', 'jobs', 'schema_migrations']);

    await assert.rejects(
      pool.query(`INSERT INTO jobs (configuration, max_attempts) VALUES ('{}', 0)`),
      /jobs_max_attempts_positive/,
    );
    await assert.rejects(
      pool.query(`
        INSERT INTO jobs (status, configuration, max_attempts, started_at)
        VALUES ('RUNNING', '{}', 1, now())
      `),
      /jobs_running_requires_lease/,
    );
    await assert.rejects(
      pool.query(`INSERT INTO jobs (configuration, max_attempts) VALUES ('[]', 1)`),
      /jobs_configuration_is_object/,
    );
  }, { poolSize: 1, migrate: false });
});
