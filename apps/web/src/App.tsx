import { useState } from 'react';
import './style.css';
import { api } from './api.js';
import { usePoll } from './usePoll.js';
import { SubmitPanel } from './components/SubmitPanel.js';
import { BatchPanel } from './components/BatchPanel.js';
import { JobTable } from './components/JobTable.js';

export default function App() {
  const [batchId, setBatchId] = useState<string | null>(null);
  // Bumped on every submission. The job table folds this into its poll key, so submitting
  // work refetches at once rather than waiting out an idle backoff.
  const [submissions, setSubmissions] = useState(0);
  // No backoff here: a healthy response is byte-identical every time, and the value of this
  // poll is how quickly it notices the database going away.
  const health = usePoll((signal) => api.health(signal), { intervalMs: 5_000, maxIntervalMs: 5_000 });

  const connected = health.data?.status === 'ok' && health.error === null;
  const chaosEnabled = health.data?.chaosEnabled === true;

  return (
    <main>
      <header>
        <h1>Async job system</h1>
        <div className="status">
          <span className={connected ? 'dot dot-ok' : 'dot dot-bad'} />
          <span role="status">
            {connected ? 'API and PostgreSQL connected' : health.error ?? 'Connecting…'}
          </span>
          {chaosEnabled ? <span className="badge badge-chaos">chaos enabled</span> : null}
        </div>
      </header>

      <SubmitPanel
        chaosEnabled={chaosEnabled}
        onSubmitted={(kind, id) => {
          if (kind === 'batch') setBatchId(id);
          setSubmissions((count) => count + 1);
        }}
      />
      <BatchPanel batchId={batchId} onSelect={setBatchId} />
      <JobTable submissions={submissions} />
    </main>
  );
}
