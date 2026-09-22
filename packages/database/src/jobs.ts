import type { Job, ListJobsQuery, SyntheticJobConfiguration } from '@async-jobs/contracts';
import { syntheticJobConfigurationSchema } from '@async-jobs/contracts';
import type pg from 'pg';

type JobRow = pg.QueryResultRow & {
  id: string;
  batchId: string | null;
  status: Job['status'];
  configuration: unknown;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  cancelRequested: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  availableAt: Date;
};

const jobColumns = `
  id,
  batch_id AS "batchId",
  status,
  configuration,
  attempts,
  max_attempts AS "maxAttempts",
  created_at AS "createdAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  error_message AS error,
  cancel_requested AS "cancelRequested",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  available_at AS "availableAt"
`;

function toJob(row: JobRow): Job {
  return {
    ...row,
    configuration: syntheticJobConfigurationSchema.parse(row.configuration),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    availableAt: row.availableAt.toISOString(),
  };
}

export async function createJob(pool: pg.Pool, configuration: SyntheticJobConfiguration): Promise<Job> {
  const result = await pool.query<JobRow>(`
    INSERT INTO jobs (configuration, max_attempts)
    VALUES ($1::jsonb, $2)
    RETURNING ${jobColumns}
  `, [JSON.stringify(configuration), configuration.maxAttempts]);
  return toJob(result.rows[0]!);
}

export async function getJob(pool: pg.Pool, id: string): Promise<Job | null> {
  const result = await pool.query<JobRow>(`SELECT ${jobColumns} FROM jobs WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toJob(row) : null;
}

export async function listJobs(pool: pg.Pool, query: ListJobsQuery): Promise<{ jobs: Job[]; total: number }> {
  const values = [query.status ?? null, query.limit, query.offset];
  const [jobsResult, countResult] = await Promise.all([
    pool.query<JobRow>(`
      SELECT ${jobColumns}
      FROM jobs
      WHERE ($1::job_status IS NULL OR status = $1)
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3
    `, values),
    pool.query<{ total: number }>(`
      SELECT count(*)::integer AS total
      FROM jobs
      WHERE ($1::job_status IS NULL OR status = $1)
    `, [query.status ?? null]),
  ]);
  return { jobs: jobsResult.rows.map(toJob), total: countResult.rows[0]!.total };
}

export async function requestJobCancellation(pool: pg.Pool, id: string): Promise<Job | null> {
  const updated = await pool.query<JobRow>(`
    UPDATE jobs
    SET
      cancel_requested = true,
      status = CASE WHEN status IN ('PENDING', 'RETRYING') THEN 'CANCELLED'::job_status ELSE status END,
      completed_at = CASE WHEN status IN ('PENDING', 'RETRYING') THEN now() ELSE completed_at END
    WHERE id = $1 AND status IN ('PENDING', 'RETRYING', 'RUNNING')
    RETURNING ${jobColumns}
  `, [id]);
  if (updated.rows[0]) return toJob(updated.rows[0]);
  return getJob(pool, id);
}

export async function claimNextJob(pool: pg.Pool, workerId: string, leaseDurationMs: number): Promise<Job | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SKIP LOCKED lets independent workers claim other eligible jobs immediately.
    const candidate = await client.query<{ id: string }>(`
      SELECT id
      FROM jobs
      WHERE status IN ('PENDING', 'RETRYING') AND cancel_requested = false AND available_at <= now()
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const id = candidate.rows[0]?.id;
    if (!id) {
      await client.query('COMMIT');
      return null;
    }

    const claimed = await client.query<JobRow>(`
      UPDATE jobs
      SET
        status = 'RUNNING',
        attempts = attempts + 1,
        started_at = COALESCE(started_at, now()),
        lease_owner = $2,
        lease_expires_at = now() + ($3 * interval '1 millisecond')
      WHERE id = $1 AND status IN ('PENDING', 'RETRYING') AND cancel_requested = false
      RETURNING ${jobColumns}
    `, [id, workerId, leaseDurationMs]);
    await client.query('COMMIT');
    return claimed.rows[0] ? toJob(claimed.rows[0]) : null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ownership guard, shared by every write below that resolves a claimed attempt.
 *
 * `id + attempts + lease_owner + status = 'RUNNING'` is the part that actually prevents two
 * workers from resolving the same job. Once a job is recovered and reclaimed, its attempt number
 * and lease owner have both moved, so a write from the previous owner matches zero rows.
 *
 * `lease_expires_at > now()` is a secondary check, and it is looser than it looks: `now()` is
 * transaction-start time in PostgreSQL, not statement time. A write that blocks on the row lock
 * evaluates the lease against the clock as it was before the wait, so it can land after the lease
 * has actually expired. That is deliberate rather than merely tolerated. It only matters when the
 * row is otherwise untouched, meaning the lease lapsed but nothing reclaimed the job, and in that
 * state the writer is still the only claimant and recording its result is correct.
 *
 * Switching to `clock_timestamp()` would reject exactly those writes, leaving a finished job
 * `RUNNING` with a dead lease for recovery to re-run. It would cause duplicate execution, not
 * prevent it.
 */
export async function completeClaimedJob(pool: pg.Pool, job: Job, workerId: string): Promise<Job | null> {
  const result = await pool.query<JobRow>(`
    UPDATE jobs
    SET
      status = CASE WHEN cancel_requested THEN 'CANCELLED'::job_status ELSE 'COMPLETED'::job_status END,
      completed_at = now(),
      error_message = null,
      lease_owner = null,
      lease_expires_at = null
    WHERE id = $1 AND status = 'RUNNING' AND attempts = $2 AND lease_owner = $3 AND lease_expires_at > now()
    RETURNING ${jobColumns}
  `, [job.id, job.attempts, workerId]);
  return result.rows[0] ? toJob(result.rows[0]) : null;
}

export async function renewClaimedJobLease(
  pool: pg.Pool,
  job: Job,
  workerId: string,
  leaseDurationMs: number,
): Promise<Job | null> {
  const result = await pool.query<JobRow>(`
    UPDATE jobs
    SET lease_expires_at = now() + ($4 * interval '1 millisecond')
    WHERE id = $1 AND status = 'RUNNING' AND attempts = $2 AND lease_owner = $3 AND lease_expires_at > now()
    RETURNING ${jobColumns}
  `, [job.id, job.attempts, workerId, leaseDurationMs]);
  return result.rows[0] ? toJob(result.rows[0]) : null;
}

export async function isClaimedJobCancellationRequested(pool: pg.Pool, job: Job, workerId: string): Promise<boolean | null> {
  const result = await pool.query<{ cancelRequested: boolean }>(`
    SELECT cancel_requested AS "cancelRequested"
    FROM jobs
    WHERE id = $1 AND status = 'RUNNING' AND attempts = $2 AND lease_owner = $3 AND lease_expires_at > now()
  `, [job.id, job.attempts, workerId]);
  return result.rows[0]?.cancelRequested ?? null;
}

export async function cancelClaimedJob(pool: pg.Pool, job: Job, workerId: string): Promise<Job | null> {
  const result = await pool.query<JobRow>(`
    UPDATE jobs
    SET
      status = 'CANCELLED',
      completed_at = now(),
      error_message = null,
      lease_owner = null,
      lease_expires_at = null
    WHERE id = $1 AND status = 'RUNNING' AND attempts = $2 AND lease_owner = $3
      AND lease_expires_at > now() AND cancel_requested = true
    RETURNING ${jobColumns}
  `, [job.id, job.attempts, workerId]);
  return result.rows[0] ? toJob(result.rows[0]) : null;
}

export async function resolveClaimedFailure(
  pool: pg.Pool,
  job: Job,
  workerId: string,
  errorMessage: string,
  retryDelayMs: number,
): Promise<Job | null> {
  const result = await pool.query<JobRow>(`
    UPDATE jobs
    SET
      status = CASE
        WHEN cancel_requested THEN 'CANCELLED'::job_status
        WHEN attempts < max_attempts THEN 'RETRYING'::job_status
        ELSE 'FAILED'::job_status
      END,
      completed_at = CASE WHEN cancel_requested OR attempts >= max_attempts THEN now() ELSE null END,
      error_message = CASE WHEN cancel_requested THEN null ELSE $4 END,
      lease_owner = null,
      lease_expires_at = null,
      available_at = CASE
        WHEN cancel_requested OR attempts >= max_attempts THEN available_at
        ELSE now() + ($5 * interval '1 millisecond')
      END
    WHERE id = $1 AND status = 'RUNNING' AND attempts = $2 AND lease_owner = $3 AND lease_expires_at > now()
    RETURNING ${jobColumns}
  `, [job.id, job.attempts, workerId, errorMessage, retryDelayMs]);
  return result.rows[0] ? toJob(result.rows[0]) : null;
}

export async function recoverExpiredJobs(pool: pg.Pool, limit: number, retryDelayMs: number): Promise<Job[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recovered = await client.query<JobRow>(`
      WITH expired AS (
        SELECT id
        FROM jobs
        WHERE status = 'RUNNING' AND lease_expires_at <= now()
        ORDER BY lease_expires_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs
      SET
        status = CASE
          WHEN cancel_requested THEN 'CANCELLED'::job_status
          WHEN attempts < max_attempts THEN 'RETRYING'::job_status
          ELSE 'FAILED'::job_status
        END,
        completed_at = CASE WHEN cancel_requested OR attempts >= max_attempts THEN now() ELSE null END,
        error_message = CASE WHEN cancel_requested THEN null ELSE 'Worker lease expired' END,
        lease_owner = null,
        lease_expires_at = null,
        available_at = CASE
          WHEN cancel_requested OR attempts >= max_attempts THEN available_at
          ELSE now() + ($2 * interval '1 millisecond')
        END
      WHERE id IN (SELECT id FROM expired)
      RETURNING ${jobColumns}
    `, [limit, retryDelayMs]);
    await client.query('COMMIT');
    return recovered.rows.map(toJob);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
