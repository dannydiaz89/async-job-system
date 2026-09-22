import { useState } from 'react';
import type { Job, JobStatus } from '@async-jobs/contracts';
import { api, failureMessage } from '../api.js';
import { usePoll } from '../usePoll.js';

// Listed locally rather than imported as a value: importing the contracts module would pull Zod
// into the browser bundle to obtain a six-element array. The guard below is a compile error if
// this list and the contract's union ever drift apart, in either direction.
const STATUS_FILTERS = ['PENDING', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
type StatusDrift =
  | Exclude<JobStatus, (typeof STATUS_FILTERS)[number]>
  | Exclude<(typeof STATUS_FILTERS)[number], JobStatus>;
const _noStatusDrift: StatusDrift extends never ? true : false = true;
void _noStatusDrift;

const PAGE_SIZE = 15;
const POLL_MS = 1_000;
const CANCELLABLE: ReadonlySet<JobStatus> = new Set<JobStatus>(['PENDING', 'RETRYING', 'RUNNING']);

function time(value: string): string {
  return new Date(value).toLocaleTimeString();
}

function worker(job: Job): string {
  if (!job.leaseOwner) return '—';
  // Worker identity is `hostname:uuid`; the short uuid prefix is enough to tell workers apart.
  const [host, id] = job.leaseOwner.split(':');
  return id ? `${host}…${id.slice(0, 6)}` : job.leaseOwner;
}

function Row({ job, onCancel, cancelling }: { job: Job; onCancel: (id: string) => void; cancelling: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr>
        <td>
          <button type="button" className="link" onClick={() => setExpanded((value) => !value)}>
            {job.id.slice(0, 8)}
          </button>
        </td>
        <td><span className={`badge badge-${job.status.toLowerCase()}`}>{job.status}</span></td>
        <td>{job.attempts}/{job.maxAttempts}</td>
        <td>{job.configuration.durationMs} ms</td>
        <td className="mono">{worker(job)}</td>
        <td>{time(job.createdAt)}</td>
        <td>
          {CANCELLABLE.has(job.status) ? (
            <button type="button" onClick={() => onCancel(job.id)} disabled={cancelling}>
              {cancelling ? '…' : 'Cancel'}
            </button>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="detail">
          <td colSpan={7}>
            <dl>
              <dt>Job</dt><dd className="mono">{job.id}</dd>
              <dt>Batch</dt><dd className="mono">{job.batchId ?? '—'}</dd>
              <dt>Cancel requested</dt><dd>{job.cancelRequested ? 'yes' : 'no'}</dd>
              <dt>Started</dt><dd>{job.startedAt ? time(job.startedAt) : '—'}</dd>
              <dt>Completed</dt><dd>{job.completedAt ? time(job.completedAt) : '—'}</dd>
              <dt>Next attempt at</dt><dd>{time(job.availableAt)}</dd>
              <dt>Lease expires</dt><dd>{job.leaseExpiresAt ? time(job.leaseExpiresAt) : '—'}</dd>
              <dt>Error</dt><dd>{job.error ?? '—'}</dd>
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function JobTable({ submissions }: { submissions: number }) {
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const jobs = usePoll(
    (signal) =>
      api.listJobs({ limit: PAGE_SIZE, offset, ...(status ? { status } : {}) }, signal),
    { intervalMs: POLL_MS, resetKey: `${status}:${offset}`, refreshToken: submissions },
  );

  async function cancel(id: string) {
    setCancelling(id);
    setCancelError(null);
    try {
      await api.cancelJob(id);
      jobs.refresh();
    } catch (failure) {
      setCancelError(failureMessage(failure));
    } finally {
      setCancelling(null);
    }
  }

  const total = jobs.data?.page.total ?? 0;
  const rows = jobs.data?.jobs ?? [];
  const showing = total === 0 ? '0' : `${offset + 1}–${offset + rows.length}`;

  return (
    <section>
      <div className="section-head">
        <h2>Jobs</h2>
        <label className="inline">
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as JobStatus | '');
              setOffset(0);
            }}
          >
            <option value="">All</option>
            {STATUS_FILTERS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>

      {/* A failed poll keeps the last table visible, so a blip does not blank the dashboard. */}
      {jobs.error ? <p className="error" role="alert">{jobs.error}</p> : null}
      {cancelError ? <p className="error" role="alert">{cancelError}</p> : null}

      <table>
        <thead>
          <tr>
            <th>ID</th><th>Status</th><th>Attempts</th><th>Duration</th>
            <th>Worker</th><th>Created</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={7} className="empty">{jobs.loading ? 'Loading…' : 'No jobs yet.'}</td></tr>
          ) : (
            rows.map((job) => (
              <Row key={job.id} job={job} onCancel={(id) => void cancel(id)} cancelling={cancelling === job.id} />
            ))
          )}
        </tbody>
      </table>

      <div className="pager">
        <button type="button" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>
          Previous
        </button>
        <span>{showing} of {total}</span>
        <button
          type="button"
          onClick={() => setOffset(offset + PAGE_SIZE)}
          disabled={offset + PAGE_SIZE >= total}
        >
          Next
        </button>
      </div>
    </section>
  );
}
