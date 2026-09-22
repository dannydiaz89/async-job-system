import type { Batch, BatchDetail, CreateBatchInput, CreateJobInput, Job, JobStatus } from '@async-jobs/contracts';

const base = '/api';
const requestTimeoutMs = 8_000;

export type Health = Readonly<{ status: string; service: string; database: string; chaosEnabled: boolean }>;
export type Page = Readonly<{ limit: number; offset: number; total: number }>;
export type JobList = Readonly<{ jobs: Job[]; page: Page }>;
export type BatchList = Readonly<{ batches: Batch[]; page: Page }>;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Turn the API's `{ error, issues }` body into one line a person can act on. */
function describeFailure(payload: unknown, status: number): string {
  if (typeof payload !== 'object' || payload === null) return `Request failed with ${status}`;
  const body = payload as { error?: unknown; issues?: unknown };
  const message = typeof body.error === 'string' ? body.error : `Request failed with ${status}`;
  if (!Array.isArray(body.issues) || body.issues.length === 0) return message;
  const details = body.issues
    .map((issue: unknown) => {
      const { path, message: text } = (issue ?? {}) as { path?: unknown; message?: unknown };
      const field = Array.isArray(path) ? path.join('.') : '';
      return field ? `${field}: ${String(text)}` : String(text);
    })
    .join('; ');
  return `${message} (${details})`;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const signals = [AbortSignal.timeout(requestTimeoutMs)];
  if (options.signal) signals.push(options.signal);

  const init: RequestInit = { cache: 'no-store', signal: AbortSignal.any(signals) };
  if (options.method) init.method = options.method;
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { 'content-type': 'application/json' };
  }

  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'API returned a malformed response');
    }
  }
  if (!response.ok) throw new ApiError(response.status, describeFailure(payload, response.status));
  return payload as T;
}

function query(parameters: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

export const api = {
  health: (signal?: AbortSignal) => request<Health>('/health', signal ? { signal } : {}),

  createJob: (input: CreateJobInput) => request<Job>('/jobs', { method: 'POST', body: input }),

  listJobs: (
    parameters: { limit: number; offset: number; status?: JobStatus | undefined },
    signal?: AbortSignal,
  ) =>
    request<JobList>(
      `/jobs${query({ limit: parameters.limit, offset: parameters.offset, status: parameters.status })}`,
      signal ? { signal } : {},
    ),

  cancelJob: (id: string) => request<Job>(`/jobs/${id}/cancel`, { method: 'POST' }),

  createBatch: (input: CreateBatchInput) => request<Batch>('/batches', { method: 'POST', body: input }),

  listBatches: (parameters: { limit: number; offset: number }, signal?: AbortSignal) =>
    request<BatchList>(`/batches${query(parameters)}`, signal ? { signal } : {}),

  getBatch: (id: string, signal?: AbortSignal) =>
    request<BatchDetail>(`/batches/${id}`, signal ? { signal } : {}),
};

export function failureMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'Request timed out';
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}
