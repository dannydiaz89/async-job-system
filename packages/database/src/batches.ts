import type { Batch, BatchDetail, BatchMetrics, CreateBatchInput, ListBatchesQuery } from '@async-jobs/contracts';
import { createBatchInputSchema } from '@async-jobs/contracts';
import type pg from 'pg';

type BatchRow = pg.QueryResultRow & {
  id: string;
  configuration: unknown;
  createdAt: Date;
};

type BatchMetricsRow = BatchRow & {
  total: number;
  pending: number;
  running: number;
  retrying: number;
  completed: number;
  failed: number;
  cancelled: number;
  startedAt: Date | null;
  completedAt: Date | null;
  elapsedMs: number;
  throughputPerSecond: number | null;
};

const batchColumns = `id, configuration, created_at AS "createdAt"`;

function toBatch(row: BatchRow): Batch {
  return {
    id: row.id,
    configuration: createBatchInputSchema.parse(row.configuration),
    createdAt: row.createdAt.toISOString(),
  };
}

function toBatchMetrics(row: BatchMetricsRow): BatchMetrics {
  const terminalCount = row.completed + row.failed + row.cancelled;
  return {
    total: row.total,
    pending: row.pending,
    running: row.running,
    retrying: row.retrying,
    completed: row.completed,
    failed: row.failed,
    cancelled: row.cancelled,
    queueDepth: row.pending + row.retrying,
    terminalCount,
    terminalProgress: row.total === 0 ? 0 : terminalCount / row.total,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    elapsedMs: row.elapsedMs,
    throughputPerSecond: row.throughputPerSecond,
  };
}

export async function createBatch(pool: pg.Pool, input: CreateBatchInput): Promise<Batch> {
  const { jobCount, ...jobConfiguration } = input;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = await client.query<BatchRow>(`
      INSERT INTO batches (configuration)
      VALUES ($1::jsonb)
      RETURNING ${batchColumns}
    `, [JSON.stringify(input)]);
    const created = batch.rows[0]!;
    await client.query(`
      INSERT INTO jobs (batch_id, configuration, max_attempts)
      SELECT $1, $2::jsonb, $3
      FROM generate_series(1, $4)
    `, [created.id, JSON.stringify(jobConfiguration), jobConfiguration.maxAttempts, jobCount]);
    await client.query('COMMIT');
    return toBatch(created);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listBatches(pool: pg.Pool, query: ListBatchesQuery): Promise<{ batches: Batch[]; total: number }> {
  const [batches, count] = await Promise.all([
    pool.query<BatchRow>(`
      SELECT ${batchColumns}
      FROM batches
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2
    `, [query.limit, query.offset]),
    pool.query<{ total: number }>('SELECT count(*)::integer AS total FROM batches'),
  ]);
  return { batches: batches.rows.map(toBatch), total: count.rows[0]!.total };
}

export async function getBatchDetail(pool: pg.Pool, id: string): Promise<BatchDetail | null> {
  const result = await pool.query<BatchMetricsRow>(`
    WITH snapshot AS (SELECT now() AS observed_at)
    SELECT
      b.id,
      b.configuration,
      b.created_at AS "createdAt",
      count(j.id)::integer AS total,
      count(j.id) FILTER (WHERE j.status = 'PENDING')::integer AS pending,
      count(j.id) FILTER (WHERE j.status = 'RUNNING')::integer AS running,
      count(j.id) FILTER (WHERE j.status = 'RETRYING')::integer AS retrying,
      count(j.id) FILTER (WHERE j.status = 'COMPLETED')::integer AS completed,
      count(j.id) FILTER (WHERE j.status = 'FAILED')::integer AS failed,
      count(j.id) FILTER (WHERE j.status = 'CANCELLED')::integer AS cancelled,
      min(j.started_at) AS "startedAt",
      CASE
        WHEN count(j.id) = count(j.id) FILTER (WHERE j.status IN ('COMPLETED', 'FAILED', 'CANCELLED'))
        THEN max(j.completed_at)
        ELSE null
      END AS "completedAt",
      greatest(0, extract(epoch FROM (
        CASE
          WHEN count(j.id) = count(j.id) FILTER (WHERE j.status IN ('COMPLETED', 'FAILED', 'CANCELLED'))
          THEN max(j.completed_at)
          ELSE (SELECT observed_at FROM snapshot)
        END - b.created_at
      )) * 1000)::double precision AS "elapsedMs",
      CASE
        WHEN extract(epoch FROM (
          CASE
            WHEN count(j.id) = count(j.id) FILTER (WHERE j.status IN ('COMPLETED', 'FAILED', 'CANCELLED'))
            THEN max(j.completed_at)
            ELSE (SELECT observed_at FROM snapshot)
          END - b.created_at
        )) > 0
        THEN count(j.id) FILTER (WHERE j.status = 'COMPLETED') / extract(epoch FROM (
          CASE
            WHEN count(j.id) = count(j.id) FILTER (WHERE j.status IN ('COMPLETED', 'FAILED', 'CANCELLED'))
            THEN max(j.completed_at)
            ELSE (SELECT observed_at FROM snapshot)
          END - b.created_at
        ))
        ELSE null
      END::double precision AS "throughputPerSecond"
    FROM batches b
    LEFT JOIN jobs j ON j.batch_id = b.id
    WHERE b.id = $1
    GROUP BY b.id, b.configuration, b.created_at
  `, [id]);
  const row = result.rows[0];
  if (!row) return null;
  return { ...toBatch(row), metrics: toBatchMetrics(row) };
}
