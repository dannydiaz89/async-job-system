import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatchInputSchema, createJobInputSchema, jobStatusSchema } from '@async-jobs/contracts';

const validJob = {
  durationMs: 5_000,
  failUntilAttempt: 2,
  maxAttempts: 3,
  chaosType: 'none',
  chaosOnAttempt: null,
};

test('accepts a deterministic synthetic job configuration', () => {
  assert.deepEqual(createJobInputSchema.parse(validJob), validJob);
  assert.equal(jobStatusSchema.parse('RETRYING'), 'RETRYING');
});

test('requires coherent retry and chaos configuration', () => {
  assert.equal(createJobInputSchema.safeParse({ ...validJob, failUntilAttempt: 4 }).success, false);
  assert.equal(createJobInputSchema.safeParse({ ...validJob, chaosType: 'crash_worker' }).success, false);
  assert.equal(createJobInputSchema.safeParse({ ...validJob, chaosOnAttempt: 1 }).success, false);
  assert.equal(createJobInputSchema.safeParse({ ...validJob, chaosType: 'fail_task', chaosOnAttempt: 4 }).success, false);
});

test('bounds batch size and rejects unknown fields', () => {
  assert.equal(createBatchInputSchema.safeParse({ ...validJob, jobCount: 1_000 }).success, true);
  assert.equal(createBatchInputSchema.safeParse({ ...validJob, jobCount: 1_001 }).success, false);
  assert.equal(createJobInputSchema.safeParse({ ...validJob, unexpected: true }).success, false);
});
