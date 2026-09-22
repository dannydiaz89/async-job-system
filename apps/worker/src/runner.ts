import type { Job } from '@async-jobs/contracts';
import {
  cancelClaimedJob,
  claimNextJob,
  completeClaimedJob,
  isClaimedJobCancellationRequested,
  recoverExpiredJobs,
  renewClaimedJobLease,
  resolveClaimedFailure,
} from '@async-jobs/database';
import type pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';

export type WorkerRunnerOptions = Readonly<{
  workerId: string;
  pollIntervalMs: number;
  leaseDurationMs: number;
  signal: AbortSignal;
}>;

export const RETRY_DELAY_MS = 250;
const LEASE_RECOVERY_BATCH_SIZE = 25;
const MAX_POLL_BACKOFF_MS = 10_000;

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

async function waitFor(durationMs: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(durationMs, undefined, { signal });
  } catch {
    // Abort is the expected path during graceful shutdown.
  }
}

async function waitForSyntheticDuration(
  pool: pg.Pool,
  workerId: string,
  job: Job,
  leaseDurationMs: number,
): Promise<'cancelled' | 'finished' | 'ownership_lost'> {
  const { durationMs } = job.configuration;
  const leaseRenewalIntervalMs = Math.max(250, Math.floor(leaseDurationMs / 3));
  let nextLeaseRenewalAt = Date.now() + leaseRenewalIntervalMs;
  let remainingMs = durationMs;
  while (remainingMs > 0) {
    const cancellationState = await isClaimedJobCancellationRequested(pool, job, workerId);
    if (cancellationState === null) return 'ownership_lost';
    if (cancellationState) return 'cancelled';
    const intervalMs = Math.min(remainingMs, 250, Math.max(1, nextLeaseRenewalAt - Date.now()));
    await sleep(intervalMs);
    remainingMs -= intervalMs;
    if (Date.now() >= nextLeaseRenewalAt) {
      const renewed = await renewClaimedJobLease(pool, job, workerId, leaseDurationMs);
      if (!renewed) return 'ownership_lost';
      nextLeaseRenewalAt = Date.now() + leaseRenewalIntervalMs;
    }
  }
  const cancellationState = await isClaimedJobCancellationRequested(pool, job, workerId);
  if (cancellationState === null) return 'ownership_lost';
  return cancellationState ? 'cancelled' : 'finished';
}

function syntheticFailureMessage(job: Job): string | null {
  if (job.attempts <= job.configuration.failUntilAttempt) {
    return `Synthetic failure for attempt ${job.attempts}: failUntilAttempt is ${job.configuration.failUntilAttempt}`;
  }
  if (job.configuration.chaosType === 'fail_task' && job.configuration.chaosOnAttempt === job.attempts) {
    return `Synthetic failure for attempt ${job.attempts}: fail_task was configured`;
  }
  return null;
}

function shouldCrashWorker(job: Job): boolean {
  return job.configuration.chaosType === 'crash_worker' && job.configuration.chaosOnAttempt === job.attempts;
}

export async function processClaimedJob(
  pool: pg.Pool,
  workerId: string,
  job: Job,
  leaseDurationMs = 30_000,
): Promise<void> {
  try {
    const workResult = await waitForSyntheticDuration(pool, workerId, job, leaseDurationMs);
    if (workResult === 'ownership_lost') {
      log('job_ownership_lost', { workerId, jobId: job.id, attempt: job.attempts });
      return;
    }
    if (workResult === 'cancelled') {
      const resolved = await cancelClaimedJob(pool, job, workerId);
      if (resolved) log('job_cancelled', { workerId, jobId: job.id, attempt: job.attempts });
      else log('job_cancellation_rejected', { workerId, jobId: job.id, attempt: job.attempts });
      return;
    }

    if (shouldCrashWorker(job)) {
      log('worker_crashing', { workerId, jobId: job.id, attempt: job.attempts });
      process.exit(1);
    }

    const failureMessage = syntheticFailureMessage(job);
    if (failureMessage) {
      const resolved = await resolveClaimedFailure(pool, job, workerId, failureMessage, RETRY_DELAY_MS);
      if (resolved) log('job_failure_resolved', {
        workerId, jobId: job.id, attempt: job.attempts, status: resolved.status, message: failureMessage,
      });
      else log('job_failure_rejected', { workerId, jobId: job.id, attempt: job.attempts, message: failureMessage });
      return;
    }

    const completed = await completeClaimedJob(pool, job, workerId);
    if (completed?.status === 'COMPLETED') log('job_completed', { workerId, jobId: job.id, attempt: job.attempts });
    else if (completed?.status === 'CANCELLED') log('job_cancelled', { workerId, jobId: job.id, attempt: job.attempts });
    else log('job_completion_rejected', { workerId, jobId: job.id, attempt: job.attempts });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown worker error';
    const resolved = await resolveClaimedFailure(pool, job, workerId, message, RETRY_DELAY_MS);
    if (resolved) log('job_failure_resolved', {
      workerId, jobId: job.id, attempt: job.attempts, status: resolved.status, message,
    });
    else log('job_failure_rejected', { workerId, jobId: job.id, attempt: job.attempts, message });
  }
}

export async function runWorker(pool: pg.Pool, options: WorkerRunnerOptions): Promise<void> {
  let consecutiveFailures = 0;

  while (!options.signal.aborted) {
    try {
      const recovered = await recoverExpiredJobs(pool, LEASE_RECOVERY_BATCH_SIZE, RETRY_DELAY_MS);
      for (const job of recovered) {
        log('expired_lease_recovered', { workerId: options.workerId, jobId: job.id, attempt: job.attempts, status: job.status });
      }
      const job = await claimNextJob(pool, options.workerId, options.leaseDurationMs);
      if (consecutiveFailures > 0) {
        log('worker_poll_recovered', { workerId: options.workerId, afterFailures: consecutiveFailures });
        consecutiveFailures = 0;
      }
      if (job) {
        log('job_claimed', { workerId: options.workerId, jobId: job.id, attempt: job.attempts });
        await processClaimedJob(pool, options.workerId, job, options.leaseDurationMs);
        continue;
      }
      await waitFor(options.pollIntervalMs, options.signal);
    } catch (error) {
      // Reached when even recording an outcome failed, which is what an unreachable database
      // looks like. Nothing more needs recording: the lease on any held job lapses, and a
      // recovery pass resolves it once the database is back and some worker is free to run one.
      // Staying alive and backing off is strictly better than exiting and losing the process.
      consecutiveFailures += 1;
      const backoffMs = Math.min(MAX_POLL_BACKOFF_MS, options.pollIntervalMs * 2 ** (consecutiveFailures - 1));
      log('worker_poll_failed', {
        workerId: options.workerId,
        consecutiveFailures,
        backoffMs,
        message: error instanceof Error ? error.message : 'Unknown worker error',
      });
      await waitFor(backoffMs, options.signal);
    }
  }
}
