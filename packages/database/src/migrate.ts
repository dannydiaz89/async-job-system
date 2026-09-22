import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationFilePattern = /^(\d{3,})_([a-z][a-z0-9_-]*)\.sql$/;
const migrationLockName = 'async-job-system:migrations';

export type Migration = Readonly<{
  version: string;
  filename: string;
  sql: string;
}>;

export type MigrationResult = Readonly<{ applied: readonly string[] }>;
export type RunMigrationsOptions = Readonly<{
  connectionString?: string;
  migrationsDirectory?: string;
}>;

function defaultMigrationsDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
}

export async function readMigrations(directory = defaultMigrationsDirectory()): Promise<readonly Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && migrationFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const migrations = await Promise.all(filenames.map(async (filename) => {
    const match = migrationFilePattern.exec(filename);
    const version = match?.[1];
    if (!version) throw new Error(`Invalid migration filename: ${filename}`);
    return { version, filename, sql: await readFile(path.join(directory, filename), 'utf8') };
  }));

  const versions = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error(`Duplicate migration version: ${migration.version}`);
    versions.add(migration.version);
  }
  return migrations;
}

export async function runMigrations(options: RunMigrationsOptions = {}): Promise<MigrationResult> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to run migrations');

  const migrations = await readMigrations(options.migrationsDirectory);
  const pool = new pg.Pool({ connectionString, application_name: 'async-jobs-migrations', max: 1 });
  const client = await pool.connect();
  let lockHeld = false;

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [migrationLockName]);
    lockHeld = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        filename text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedVersions = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const alreadyApplied = new Set(appliedVersions.rows.map((row) => row.version));
    const applied: string[] = [];

    for (const migration of migrations) {
      if (alreadyApplied.has(migration.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)', [migration.version, migration.filename]);
        await client.query('COMMIT');
        applied.push(migration.filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration failed: ${migration.filename}`, { cause: error });
      }
    }
    return { applied };
  } finally {
    if (lockHeld) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [migrationLockName]);
    client.release();
    await pool.end();
  }
}

async function main() {
  const result = await runMigrations();
  console.log(JSON.stringify({ event: 'migrations_complete', applied: result.applied }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
