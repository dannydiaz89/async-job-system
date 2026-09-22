import pg from 'pg';

export { createBatch, getBatchDetail, listBatches } from './batches.js';
export { readMigrations, runMigrations } from './migrate.js';
export {
  claimNextJob,
  cancelClaimedJob,
  completeClaimedJob,
  createJob,
  getJob,
  isClaimedJobCancellationRequested,
  listJobs,
  recoverExpiredJobs,
  renewClaimedJobLease,
  requestJobCancellation,
  resolveClaimedFailure,
} from './jobs.js';

export function createPool(applicationName: string): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new pg.Pool({
    connectionString,
    application_name: applicationName,
    max: 5,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });

  // Idle connections can fail between queries, including during a database restart.
  pool.on('error', (error: Error) => {
    console.error(JSON.stringify({ event: 'database_connection_error', applicationName, message: error.message }));
  });
  return pool;
}
