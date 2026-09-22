import {
  createBatchInputSchema,
  createJobInputSchema,
  jobIdParamsSchema,
  listJobsQuerySchema,
  listBatchesQuerySchema,
} from '@async-jobs/contracts';
import {
  createBatch,
  createJob,
  getBatchDetail,
  getJob,
  listBatches,
  listJobs,
  requestJobCancellation,
} from '@async-jobs/database';
import express, { type ErrorRequestHandler } from 'express';
import type pg from 'pg';
import swaggerUi from 'swagger-ui-express';
import { ZodError, type ZodType } from 'zod';
import { openApiDocument } from './openapi.js';

class RequestValidationError extends Error {
  constructor(readonly issues: ZodError['issues']) {
    super('Request validation failed');
  }
}

class ChaosDisabledError extends Error {
  constructor() {
    super('Chaos configuration is disabled. Set ENABLE_CHAOS=true to submit failing or crashing jobs.');
  }
}

function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestValidationError(result.error.issues);
  return result.data;
}

export type AppOptions = Readonly<{ chaosEnabled?: boolean }>;

export function createApp(pool: pg.Pool, options: AppOptions = {}): express.Express {
  // Chaos is deliberately gated at admission rather than at execution: workers faithfully run
  // whatever a job row already carries, and this boundary decides what may become a job row.
  const chaosEnabled = options.chaosEnabled ?? process.env.ENABLE_CHAOS === 'true';

  function assertChaosAllowed(configuration: { chaosType: string }): void {
    if (!chaosEnabled && configuration.chaosType !== 'none') throw new ChaosDisabledError();
  }

  // HTTP wiring belongs here; durable state changes remain explicit database operations.
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.get('/openapi.json', (_request, response) => {
    response.set('Cache-Control', 'no-store').json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, { customSiteTitle: 'Async job system API docs' }));

  app.get('/health', async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      await pool.query('SELECT 1');
      response.json({ status: 'ok', service: 'api', database: 'connected', chaosEnabled });
    } catch {
      response.status(503).json({ status: 'unavailable', service: 'api', database: 'unreachable' });
    }
  });

  app.post('/jobs', async (request, response) => {
    const configuration = parse(createJobInputSchema, request.body);
    assertChaosAllowed(configuration);
    const job = await createJob(pool, configuration);
    response.location(`/jobs/${job.id}`).status(201).json(job);
  });

  app.post('/batches', async (request, response) => {
    const input = parse(createBatchInputSchema, request.body);
    assertChaosAllowed(input);
    const batch = await createBatch(pool, input);
    response.location(`/batches/${batch.id}`).status(201).json(batch);
  });

  app.get('/batches', async (request, response) => {
    const query = parse(listBatchesQuerySchema, request.query);
    const result = await listBatches(pool, query);
    response.json({
      batches: result.batches,
      page: { limit: query.limit, offset: query.offset, total: result.total },
    });
  });

  app.get('/batches/:id', async (request, response) => {
    const { id } = parse(jobIdParamsSchema, request.params);
    const batch = await getBatchDetail(pool, id);
    if (!batch) return response.status(404).json({ error: 'Batch not found' });
    return response.json(batch);
  });

  app.get('/jobs', async (request, response) => {
    const query = parse(listJobsQuerySchema, request.query);
    const result = await listJobs(pool, query);
    response.json({
      jobs: result.jobs,
      page: { limit: query.limit, offset: query.offset, total: result.total },
    });
  });

  app.get('/jobs/:id', async (request, response) => {
    const { id } = parse(jobIdParamsSchema, request.params);
    const job = await getJob(pool, id);
    if (!job) return response.status(404).json({ error: 'Job not found' });
    return response.json(job);
  });

  app.post('/jobs/:id/cancel', async (request, response) => {
    const { id } = parse(jobIdParamsSchema, request.params);
    const job = await requestJobCancellation(pool, id);
    if (!job) return response.status(404).json({ error: 'Job not found' });
    return response.status(job.status === 'RUNNING' ? 202 : 200).json(job);
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message, issues: error.issues });
    }
    if (error instanceof ChaosDisabledError) {
      return response.status(403).json({ error: error.message });
    }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      return response.status(400).json({ error: 'Invalid JSON' });
    }
    console.error(error);
    return response.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);
  return app;
}
