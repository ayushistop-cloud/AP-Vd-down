#!/usr/bin/env node
/**
 * Minimal forward-only migrator (docs/28-DEPLOYMENT.md release flow).
 * Applies SQL files from ./migrations in filename order, tracking applied
 * versions in schema_migrations. Idempotent.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = process.env.MIGRATIONS_DIR ?? join(root, 'migrations');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(JSON.stringify({ event: 'migrate_failed', reason: 'DATABASE_URL is required' }));
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const already = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (already.rowCount > 0) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(JSON.stringify({ event: 'migration_applied', name: file }));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw Object.assign(err, { migration: file });
    } finally {
      client.release();
    }
  }
  console.log(JSON.stringify({ event: 'migrate_complete', count: files.length }));
} catch (err) {
  console.error(
    JSON.stringify({
      event: 'migrate_failed',
      migration: err.migration ?? null,
      message: err.message,
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
