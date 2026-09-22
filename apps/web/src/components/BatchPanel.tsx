import type { BatchDetail } from '@async-jobs/contracts';
import { api } from '../api.js';
import { usePoll } from '../usePoll.js';

const POLL_MS = 1_000;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

function Detail({ batch }: { batch: BatchDetail }) {
  const { metrics } = batch;
  const percent = Math.round(metrics.terminalProgress * 100);
  // completedAt is set only once every job in the batch is terminal, so it is the
  // authoritative "is this batch finished" signal rather than a count comparison.
  const finished = metrics.completedAt !== null;

  return (
    <>
      <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-fill" style={{ width: `${percent}%` }} />
        <span className="progress-text">
          {metrics.terminalCount} / {metrics.total} terminal ({percent}%)
        </span>
      </div>

      <div className="metrics">
        <Metric label="Queued" value={String(metrics.queueDepth)} />
        <Metric label="Running" value={String(metrics.running)} />
        <Metric label="Completed" value={String(metrics.completed)} />
        <Metric label="Failed" value={String(metrics.failed)} />
        <Metric label="Cancelled" value={String(metrics.cancelled)} />
        <Metric label="Elapsed" value={seconds(metrics.elapsedMs)} />
        <Metric
          label="Throughput"
          value={metrics.throughputPerSecond === null ? '—' : `${metrics.throughputPerSecond.toFixed(2)}/s`}
        />
        <Metric label="State" value={finished ? 'Finished' : 'In progress'} />
      </div>

      <p className="hint">
        Elapsed runs from batch creation, so it includes queue wait and retry delay. Throughput is an
        average of completed jobs since submission, not an instantaneous rate.
      </p>
    </>
  );
}

type Props = Readonly<{ batchId: string | null; onSelect: (id: string | null) => void }>;

export function BatchPanel({ batchId, onSelect }: Props) {
  const batches = usePoll((signal) => api.listBatches({ limit: 10, offset: 0 }, signal), {
    intervalMs: 2_000,
  });
  const detail = usePoll(
    (signal) => (batchId ? api.getBatch(batchId, signal) : Promise.resolve(null)),
    {
      intervalMs: POLL_MS,
      resetKey: batchId ?? '',
      // A batch with a completion time has every job terminal, and terminal states are
      // immutable, so this response can never change again. Polling it is provably wasted.
      stopWhen: (batch) => batch?.metrics.completedAt != null,
    },
  );

  return (
    <section>
      <h2>Batches</h2>

      {batches.error ? <p className="error" role="alert">{batches.error}</p> : null}

      {batches.data && batches.data.batches.length > 0 ? (
        <label className="inline">
          <span>Selected</span>
          <select value={batchId ?? ''} onChange={(event) => onSelect(event.target.value || null)}>
            <option value="">None</option>
            {batches.data.batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.id.slice(0, 8)} · {batch.configuration.jobCount} jobs ·{' '}
                {new Date(batch.createdAt).toLocaleTimeString()}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="hint">{batches.loading ? 'Loading…' : 'No batches submitted yet.'}</p>
      )}

      {detail.error ? <p className="error" role="alert">{detail.error}</p> : null}
      {batchId && detail.data ? <Detail batch={detail.data} /> : null}
    </section>
  );
}
