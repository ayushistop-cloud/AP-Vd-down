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

export async function runMigrations(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    console.log(JSON.stringify({ event: 'migrate_skipped', reason: 'DATABASE_URL is not configured' }));
    return;
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const migrationsDir = process.env.MIGRATIONS_DIR ?? join(root, 'migrations');

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
  } finally {
    await pool.end();
  }
}

// Auto-execute if run directly from command line
const isMain = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
if (isMain) {
  runMigrations().catch((err) => {
    console.error(
      JSON.stringify({
        event: 'migrate_failed',
        migration: err.migration ?? null,
        message: err.message,
      }),
    );
    process.exit(1);
  });
}
