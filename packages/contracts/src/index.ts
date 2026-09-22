import { z } from 'zod';

export const JOB_STATUSES = ['PENDING', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export const CHAOS_TYPES = ['none', 'fail_task', 'crash_worker'] as const;

export const jobStatusSchema = z.enum(JOB_STATUSES);
export const chaosTypeSchema = z.enum(CHAOS_TYPES);

export const syntheticJobConfigurationSchema = z.object({
  durationMs: z.number().int().min(100).max(3_600_000),
  failUntilAttempt: z.number().int().min(0).max(10),
  maxAttempts: z.number().int().min(1).max(10),
  chaosType: chaosTypeSchema,
  chaosOnAttempt: z.number().int().min(1).max(10).nullable(),
}).strict().superRefine((configuration, context) => {
  if (configuration.failUntilAttempt > configuration.maxAttempts) {
    context.addIssue({ code: 'custom', path: ['failUntilAttempt'], message: 'failUntilAttempt cannot exceed maxAttempts' });
  }
  if (configuration.chaosType === 'none' && configuration.chaosOnAttempt !== null) {
    context.addIssue({ code: 'custom', path: ['chaosOnAttempt'], message: 'chaosOnAttempt must be null when chaosType is none' });
  }
  if (configuration.chaosType !== 'none' && configuration.chaosOnAttempt === null) {
    context.addIssue({ code: 'custom', path: ['chaosOnAttempt'], message: 'chaosOnAttempt is required when chaos is enabled' });
  }
  if (configuration.chaosOnAttempt !== null && configuration.chaosOnAttempt > configuration.maxAttempts) {
    context.addIssue({ code: 'custom', path: ['chaosOnAttempt'], message: 'chaosOnAttempt cannot exceed maxAttempts' });
  }
});

export const createJobInputSchema = syntheticJobConfigurationSchema;
export const createBatchInputSchema = syntheticJobConfigurationSchema.extend({
  jobCount: z.number().int().min(1).max(1_000),
});

export const jobIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const listJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  status: jobStatusSchema.optional(),
}).strict();

export const listBatchesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export const jobSchema = z.object({
  id: z.uuid(),
  batchId: z.uuid().nullable(),
  status: jobStatusSchema,
  configuration: syntheticJobConfigurationSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  error: z.string().nullable(),
  cancelRequested: z.boolean(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
  availableAt: z.string().datetime({ offset: true }),
});

export const listJobsResponseSchema = z.object({
  jobs: z.array(jobSchema),
  page: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

export const batchSchema = z.object({
  id: z.uuid(),
  configuration: createBatchInputSchema,
  createdAt: z.string().datetime({ offset: true }),
});

export const batchMetricsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  retrying: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  queueDepth: z.number().int().nonnegative(),
  terminalCount: z.number().int().nonnegative(),
  terminalProgress: z.number().min(0).max(1),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  elapsedMs: z.number().nonnegative(),
  throughputPerSecond: z.number().nonnegative().nullable(),
});

export const batchDetailSchema = batchSchema.extend({ metrics: batchMetricsSchema });

export const listBatchesResponseSchema = z.object({
  batches: z.array(batchSchema),
  page: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type ChaosType = z.infer<typeof chaosTypeSchema>;
export type SyntheticJobConfiguration = z.infer<typeof syntheticJobConfigurationSchema>;
export type CreateJobInput = z.infer<typeof createJobInputSchema>;
export type CreateBatchInput = z.infer<typeof createBatchInputSchema>;
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
export type ListBatchesQuery = z.infer<typeof listBatchesQuerySchema>;
export type Job = z.infer<typeof jobSchema>;
export type Batch = z.infer<typeof batchSchema>;
export type BatchMetrics = z.infer<typeof batchMetricsSchema>;
export type BatchDetail = z.infer<typeof batchDetailSchema>;
