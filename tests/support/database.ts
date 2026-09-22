import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '@async-jobs/database';

/**
 * Integration tests run against real PostgreSQL because mocks cannot reproduce row-lock
 * behavior, lease expiry evaluated in database time, or `FOR UPDATE SKIP LOCKED`. Each test
 * gets its own freshly created database so tests never contend for rows with each other or
 * with a developer's local data, and so a failing test cannot leave state behind for the next.
 */
export const sourceDatabaseUrl = process.env.DATABASE_URL ?? 'postgres://jobs:jobs@127.0.0.1:5432/jobs';

export function databaseUrl(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export type TestDatabase = Readonly<{
  name: string;
  connectionString: string;
  pool: pg.Pool;
}>;

export type TestDatabaseOptions = Readonly<{
  /** Connections in the provided pool. Raise it for tests that run workers concurrently. */
  poolSize?: number;
  /** Set false to receive an empty database, for tests that exercise the migration runner. */
  migrate?: boolean;
}>;

/**
 * Create an isolated database, run `body`, and drop it afterwards.
 *
 * The drop uses `WITH (FORCE)` because tests that spawn real worker subprocesses may still be
 * closing their connections when the test body returns; without it the drop fails intermittently
 * and leaks a database.
 */
export async function withTestDatabase<T>(
  label: string,
  body: (database: TestDatabase) => Promise<T>,
  options: TestDatabaseOptions = {},
): Promise<T> {
  const name = `async_jobs_${label}_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl('postgres'), max: 1 });
  let created = false;
  let pool: pg.Pool | undefined;

  try {
    await adminPool.query(`CREATE DATABASE "${name}"`);
    created = true;
    const connectionString = databaseUrl(name);
    if (options.migrate !== false) await runMigrations({ connectionString });
    pool = new pg.Pool({ connectionString, max: options.poolSize ?? 2 });
    // Teardown drops the database with FORCE, which terminates any connection still open on it.
    // Without a handler, pg raises that as an unhandled 'error' event on the pool; because it
    // arrives asynchronously, the test runner attributes it to whichever test is running next.
    // Production pools attach the same handler for the same reason (see createPool).
    pool.on('error', () => undefined);
    return await body({ name, connectionString, pool });
  } finally {
    await pool?.end().catch(() => undefined);
    if (created) await adminPool.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined);
    await adminPool.end();
  }
}

/** Poll `check` until it returns a value, or fail once `timeoutMs` elapses. */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | null>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last !== null) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
}
