const chaosDisabledResponse = {
  description: 'Chaos configuration was requested while the API runs with chaos disabled.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

const errorResponse = {
  description: 'The request could not be completed.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

const jobResponse = {
  description: 'Current durable job state.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } },
};

const batchResponse = {
  description: 'Durable batch submission.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Batch' } } },
};

const batchDetailResponse = {
  description: 'Batch submission and metrics derived from its jobs.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchDetail' } } },
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Async job system API',
    version: '0.1.0',
    description: 'API for submitting, inspecting, and cooperatively cancelling synthetic jobs and batches.',
  },
  servers: [{ url: '/', description: 'Current API origin' }],
  paths: {
    '/batches': {
      post: {
        operationId: 'createBatch',
        summary: 'Submit a synthetic batch',
        description: 'Atomically persists one batch and its pending jobs. This endpoint never executes job work. Chaos configuration is rejected with 403 unless the API runs with ENABLE_CHAOS=true.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateBatchInput' } } },
        },
        responses: {
          '201': {
            ...batchResponse,
            headers: { Location: { description: 'Canonical batch resource URL.', schema: { type: 'string' } } },
          },
          '400': errorResponse,
          '403': chaosDisabledResponse,
          '500': errorResponse,
        },
      },
      get: {
        operationId: 'listBatches',
        summary: 'List recent batches',
        parameters: [
          { name: 'limit', in: 'query', description: 'Results to return, from 1 to 100. Defaults to 25.', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
          { name: 'offset', in: 'query', description: 'Results to skip. Defaults to 0.', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': {
            description: 'A bounded, newest-first page of batches.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchList' } } },
          },
          '400': errorResponse,
          '500': errorResponse,
        },
      },
    },
    '/batches/{id}': {
      get: {
        operationId: 'getBatch',
        summary: 'Get one batch and its metrics',
        parameters: [{ $ref: '#/components/parameters/BatchId' }],
        responses: { '200': batchDetailResponse, '400': errorResponse, '404': errorResponse, '500': errorResponse },
      },
    },
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Check API and database readiness',
        responses: {
          '200': {
            description: 'The API can query PostgreSQL.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
          },
          '503': { description: 'PostgreSQL is unavailable.' },
        },
      },
    },
    '/jobs': {
      post: {
        operationId: 'createJob',
        summary: 'Submit a synthetic job',
        description: 'Persists a pending job. This endpoint never executes job work. Chaos configuration is rejected with 403 unless the API runs with ENABLE_CHAOS=true.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SyntheticJobConfiguration' } } },
        },
        responses: {
          '201': {
            ...jobResponse,
            headers: { Location: { description: 'Canonical job resource URL.', schema: { type: 'string' } } },
          },
          '400': errorResponse,
          '403': chaosDisabledResponse,
          '500': errorResponse,
        },
      },
      get: {
        operationId: 'listJobs',
        summary: 'List recent jobs',
        parameters: [
          { name: 'limit', in: 'query', description: 'Results to return, from 1 to 100. Defaults to 25.', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
          { name: 'offset', in: 'query', description: 'Results to skip. Defaults to 0.', schema: { type: 'integer', minimum: 0, default: 0 } },
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/JobStatus' } },
        ],
        responses: {
          '200': {
            description: 'A bounded, newest-first page of jobs.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/JobList' } } },
          },
          '400': errorResponse,
          '500': errorResponse,
        },
      },
    },
    '/jobs/{id}': {
      get: {
        operationId: 'getJob',
        summary: 'Get one job',
        parameters: [{ $ref: '#/components/parameters/JobId' }],
        responses: { '200': jobResponse, '400': errorResponse, '404': errorResponse, '500': errorResponse },
      },
    },
    '/jobs/{id}/cancel': {
      post: {
        operationId: 'cancelJob',
        summary: 'Request cancellation',
        description: 'Cancels pending or retrying jobs immediately. For running jobs, records cooperative cancellation intent.',
        parameters: [{ $ref: '#/components/parameters/JobId' }],
        responses: {
          '200': jobResponse,
          '202': { ...jobResponse, description: 'Cancellation intent recorded; a worker must observe it.' },
          '400': errorResponse,
          '404': errorResponse,
          '500': errorResponse,
        },
      },
    },
  },
  components: {
    parameters: {
      BatchId: { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      JobId: { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
    },
    schemas: {
      JobStatus: { type: 'string', enum: ['PENDING', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'] },
      ChaosType: {
        type: 'string',
        enum: ['none', 'fail_task', 'crash_worker'],
        description: 'Deterministic fault injection for demonstrations. Values other than "none" require the API to run with ENABLE_CHAOS=true.',
      },
      SyntheticJobConfiguration: {
        type: 'object',
        additionalProperties: false,
        required: ['durationMs', 'failUntilAttempt', 'maxAttempts', 'chaosType', 'chaosOnAttempt'],
        properties: {
          durationMs: { type: 'integer', minimum: 100, maximum: 3_600_000, example: 5_000 },
          failUntilAttempt: { type: 'integer', minimum: 0, maximum: 10, example: 0 },
          maxAttempts: { type: 'integer', minimum: 1, maximum: 10, example: 3 },
          chaosType: { $ref: '#/components/schemas/ChaosType' },
          chaosOnAttempt: { type: ['integer', 'null'], minimum: 1, maximum: 10, example: null },
        },
        description: 'failUntilAttempt and chaosOnAttempt cannot exceed maxAttempts. chaosOnAttempt is null only when chaosType is none.',
      },
      CreateBatchInput: {
        type: 'object',
        additionalProperties: false,
        required: ['durationMs', 'failUntilAttempt', 'maxAttempts', 'chaosType', 'chaosOnAttempt', 'jobCount'],
        properties: {
          durationMs: { type: 'integer', minimum: 100, maximum: 3_600_000, example: 5_000 },
          failUntilAttempt: { type: 'integer', minimum: 0, maximum: 10, example: 0 },
          maxAttempts: { type: 'integer', minimum: 1, maximum: 10, example: 3 },
          chaosType: { $ref: '#/components/schemas/ChaosType' },
          chaosOnAttempt: { type: ['integer', 'null'], minimum: 1, maximum: 10, example: null },
          jobCount: { type: 'integer', minimum: 1, maximum: 1_000, example: 25 },
        },
      },
      Job: {
        type: 'object',
        required: ['id', 'batchId', 'status', 'configuration', 'attempts', 'maxAttempts', 'createdAt', 'startedAt', 'completedAt', 'error', 'cancelRequested', 'leaseOwner', 'leaseExpiresAt', 'availableAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          batchId: { type: ['string', 'null'], format: 'uuid' },
          status: { $ref: '#/components/schemas/JobStatus' },
          configuration: { $ref: '#/components/schemas/SyntheticJobConfiguration' },
          attempts: { type: 'integer', minimum: 0 },
          maxAttempts: { type: 'integer', minimum: 1 },
          createdAt: { type: 'string', format: 'date-time' },
          startedAt: { type: ['string', 'null'], format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
          error: { type: ['string', 'null'] },
          cancelRequested: { type: 'boolean' },
          leaseOwner: { type: ['string', 'null'] },
          leaseExpiresAt: { type: ['string', 'null'], format: 'date-time' },
          availableAt: { type: 'string', format: 'date-time' },
        },
      },
      JobList: {
        type: 'object',
        required: ['jobs', 'page'],
        properties: {
          jobs: { type: 'array', items: { $ref: '#/components/schemas/Job' } },
          page: {
            type: 'object',
            required: ['limit', 'offset', 'total'],
            properties: {
              limit: { type: 'integer', minimum: 1 },
              offset: { type: 'integer', minimum: 0 },
              total: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
      Batch: {
        type: 'object',
        required: ['id', 'configuration', 'createdAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          configuration: { $ref: '#/components/schemas/CreateBatchInput' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      BatchList: {
        type: 'object',
        required: ['batches', 'page'],
        properties: {
          batches: { type: 'array', items: { $ref: '#/components/schemas/Batch' } },
          page: {
            type: 'object',
            required: ['limit', 'offset', 'total'],
            properties: {
              limit: { type: 'integer', minimum: 1 },
              offset: { type: 'integer', minimum: 0 },
              total: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
      BatchMetrics: {
        type: 'object',
        required: ['total', 'pending', 'running', 'retrying', 'completed', 'failed', 'cancelled', 'queueDepth', 'terminalCount', 'terminalProgress', 'startedAt', 'completedAt', 'elapsedMs', 'throughputPerSecond'],
        properties: {
          total: { type: 'integer', minimum: 0 },
          pending: { type: 'integer', minimum: 0 },
          running: { type: 'integer', minimum: 0 },
          retrying: { type: 'integer', minimum: 0 },
          completed: { type: 'integer', minimum: 0 },
          failed: { type: 'integer', minimum: 0 },
          cancelled: { type: 'integer', minimum: 0 },
          queueDepth: { type: 'integer', minimum: 0 },
          terminalCount: { type: 'integer', minimum: 0 },
          terminalProgress: { type: 'number', minimum: 0, maximum: 1 },
          startedAt: { type: ['string', 'null'], format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
          elapsedMs: { type: 'number', minimum: 0 },
          throughputPerSecond: { type: ['number', 'null'], minimum: 0 },
        },
      },
      BatchDetail: {
        allOf: [
          { $ref: '#/components/schemas/Batch' },
          {
            type: 'object',
            required: ['metrics'],
            properties: { metrics: { $ref: '#/components/schemas/BatchMetrics' } },
          },
        ],
      },
      Health: {
        type: 'object',
        required: ['status', 'service', 'database'],
        properties: {
          status: { type: 'string', enum: ['ok'] },
          service: { type: 'string', enum: ['api'] },
          database: { type: 'string', enum: ['connected'] },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' }, issues: { type: 'array', items: { type: 'object' } } },
      },
    },
  },
} as const;
