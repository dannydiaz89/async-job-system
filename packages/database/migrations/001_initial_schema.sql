CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE job_status AS ENUM (
  'PENDING',
  'RUNNING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batches_configuration_is_object CHECK (jsonb_typeof(configuration) = 'object')
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES batches(id) ON DELETE RESTRICT,
  status job_status NOT NULL DEFAULT 'PENDING',
  configuration jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_owner text,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_configuration_is_object CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts >= 1),
  CONSTRAINT jobs_attempts_in_range CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT jobs_running_requires_lease CHECK (
    (status = 'RUNNING') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT jobs_running_requires_started_at CHECK (status <> 'RUNNING' OR started_at IS NOT NULL),
  CONSTRAINT jobs_terminal_requires_completed_at CHECK (
    (status IN ('COMPLETED', 'FAILED', 'CANCELLED')) = (completed_at IS NOT NULL)
  )
);

CREATE INDEX jobs_claimable_idx
  ON jobs (available_at, created_at)
  WHERE status IN ('PENDING', 'RETRYING') AND cancel_requested = false;

CREATE INDEX jobs_expired_lease_idx
  ON jobs (lease_expires_at)
  WHERE status = 'RUNNING';

CREATE INDEX jobs_batch_created_idx ON jobs (batch_id, created_at DESC);
CREATE INDEX jobs_recent_idx ON jobs (created_at DESC);
