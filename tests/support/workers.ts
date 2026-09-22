import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

export type FleetOptions = Readonly<{
  connectionString: string;
  count: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
}>;

/**
 * A group of real worker processes.
 *
 * These are separate OS processes, not in-process calls to `runWorker`. That matters: claim
 * contention, `SKIP LOCKED` behavior, and crash recovery are only meaningful between genuinely
 * independent processes that share nothing but the database.
 */
function hasExited(worker: ChildProcess): boolean {
  return worker.exitCode !== null || worker.signalCode !== null;
}

/**
 * Stop one worker and wait for the OS to reap it, so it cannot still hold a database connection
 * when the test's database is dropped.
 *
 * The exit listener is attached before re-checking `hasExited`: a process that exited between the
 * first check and the attach would otherwise never deliver an 'exit' event, and awaiting it would
 * hang forever. The timeout is a second guard against exactly that class of race.
 */
async function stopOne(worker: ChildProcess): Promise<void> {
  if (hasExited(worker)) return;
  const exited = once(worker, 'exit').catch(() => undefined);
  if (!worker.killed) worker.kill('SIGKILL');
  if (hasExited(worker)) return;
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

export class WorkerFleet {
  private readonly processes: ChildProcess[] = [];

  private constructor(private readonly options: FleetOptions) {}

  static start(options: FleetOptions): WorkerFleet {
    const fleet = new WorkerFleet(options);
    for (let index = 0; index < options.count; index += 1) fleet.spawnOne();
    return fleet;
  }

  private spawnOne(): ChildProcess {
    const worker = spawn(process.execPath, ['apps/worker/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: this.options.connectionString,
        WORKER_POLL_INTERVAL_MS: String(this.options.pollIntervalMs ?? 50),
        WORKER_LEASE_DURATION_MS: String(this.options.leaseDurationMs ?? 2_000),
      },
      stdio: 'ignore',
    });
    this.processes.push(worker);
    return worker;
  }

  get size(): number {
    return this.processes.filter((worker) => worker.exitCode === null && !worker.killed).length;
  }

  /** Kill one worker outright, imitating a host or container dying mid-batch. */
  killOne(): void {
    const victim = this.processes.find((worker) => worker.exitCode === null && !worker.killed);
    victim?.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    await Promise.all(this.processes.map((worker) => stopOne(worker)));
  }
}
