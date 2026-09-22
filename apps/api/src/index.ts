import { createPool } from '@async-jobs/database';
import { createApp } from './app.js';

const port = Number(process.env.API_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be an integer between 1 and 65535');
}

const pool = createPool('async-jobs-api');
const app = createApp(pool);

const server = app.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'api_started', port }));
});

server.on('error', (error) => {
  console.error(error);
  void pool.end().finally(() => { process.exitCode = 1; });
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: 'api_stopping', signal }));
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  server.close((error) => {
    void pool.end().then(() => {
      clearTimeout(deadline);
      process.exitCode = error ? 1 : 0;
    }).catch((closeError: unknown) => {
      console.error(closeError);
      process.exitCode = 1;
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
