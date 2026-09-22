import { useEffect, useState } from 'react';
import type { ChaosType, CreateBatchInput, CreateJobInput } from '@async-jobs/contracts';
import { api, failureMessage } from '../api.js';

type FormState = Readonly<{
  durationMs: number;
  failUntilAttempt: number;
  maxAttempts: number;
  chaosType: ChaosType;
  chaosOnAttempt: number;
  jobCount: number;
}>;

const initialState: FormState = {
  durationMs: 3_000,
  failUntilAttempt: 0,
  maxAttempts: 3,
  chaosType: 'none',
  chaosOnAttempt: 1,
  jobCount: 10,
};

function toConfiguration(form: FormState): CreateJobInput {
  return {
    durationMs: form.durationMs,
    failUntilAttempt: form.failUntilAttempt,
    maxAttempts: form.maxAttempts,
    chaosType: form.chaosType,
    // The API requires null when chaos is off, and a number when it is on.
    chaosOnAttempt: form.chaosType === 'none' ? null : form.chaosOnAttempt,
  };
}

type Props = Readonly<{
  chaosEnabled: boolean;
  onSubmitted: (kind: 'job' | 'batch', id: string) => void;
}>;

export function SubmitPanel({ chaosEnabled, onSubmitted }: Props) {
  const [form, setForm] = useState<FormState>(initialState);
  const [pending, setPending] = useState<'job' | 'batch' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // If the API restarts with chaos disabled, the selector becomes disabled while still holding
  // a chaos value. Submissions would keep sending it and keep getting 403, with no way to pick
  // `none` because the control is disabled. Normalize instead of stranding the form.
  useEffect(() => {
    if (!chaosEnabled) setForm((previous) => (previous.chaosType === 'none' ? previous : { ...previous, chaosType: 'none' }));
  }, [chaosEnabled]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function numberField(key: keyof FormState, label: string, min: number, max: number, hint?: string) {
    return (
      <label>
        <span>{label}</span>
        <input
          type="number"
          min={min}
          max={max}
          value={form[key]}
          onChange={(event) => update(key, Number(event.target.value) as never)}
        />
        {hint ? <small>{hint}</small> : null}
      </label>
    );
  }

  async function submit(kind: 'job' | 'batch') {
    setPending(kind);
    setError(null);
    setNotice(null);
    try {
      if (kind === 'job') {
        const job = await api.createJob(toConfiguration(form));
        setNotice(`Queued job ${job.id.slice(0, 8)}`);
        onSubmitted('job', job.id);
      } else {
        const input: CreateBatchInput = { ...toConfiguration(form), jobCount: form.jobCount };
        const batch = await api.createBatch(input);
        setNotice(`Queued batch ${batch.id.slice(0, 8)} with ${form.jobCount} jobs`);
        onSubmitted('batch', batch.id);
      }
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setPending(null);
    }
  }

  return (
    <section>
      <h2>Submit work</h2>
      <p className="hint">
        Jobs are synthetic: each occupies a worker for its duration, then succeeds or fails as configured.
      </p>

      <div className="grid">
        {numberField('durationMs', 'Duration (ms)', 100, 3_600_000)}
        {numberField('maxAttempts', 'Max attempts', 1, 10)}
        {numberField('failUntilAttempt', 'Fail until attempt', 0, 10, '0 disables; 2 fails attempts 1–2')}
        {numberField('jobCount', 'Batch size', 1, 1_000, 'Used by "Submit batch" only')}

        <label>
          <span>Chaos</span>
          <select
            value={form.chaosType}
            disabled={!chaosEnabled}
            onChange={(event) => update('chaosType', event.target.value as ChaosType)}
          >
            <option value="none">none</option>
            <option value="fail_task">fail_task</option>
            <option value="crash_worker">crash_worker</option>
          </select>
          <small>
            {chaosEnabled
              ? 'crash_worker exits the worker process'
              : 'Disabled. Start the API with ENABLE_CHAOS=true'}
          </small>
        </label>

        {form.chaosType === 'none' ? null : numberField('chaosOnAttempt', 'Chaos on attempt', 1, 10)}
      </div>

      <div className="actions">
        <button type="button" onClick={() => void submit('job')} disabled={pending !== null}>
          {pending === 'job' ? 'Submitting…' : 'Submit job'}
        </button>
        <button type="button" onClick={() => void submit('batch')} disabled={pending !== null}>
          {pending === 'batch' ? 'Submitting…' : `Submit batch of ${form.jobCount}`}
        </button>
      </div>

      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
    </section>
  );
}
