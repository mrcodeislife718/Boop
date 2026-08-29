import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from 'pg';

export type AppliedMigration = { name: string; appliedAt: string };

export async function applyBoopMigrations(pool: Pool, migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url))): Promise<AppliedMigration[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boop_schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const { createHash } = await import('node:crypto');
  const names = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const applied: AppliedMigration[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(migrationsDir, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await pool.query('SELECT checksum,applied_at FROM boop_schema_migrations WHERE name=$1', [name]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration was modified: ${name}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      const result = await client.query(
        `INSERT INTO boop_schema_migrations (name,checksum) VALUES ($1,$2) RETURNING applied_at`,
        [name, checksum],
      );
      await client.query('COMMIT');
      applied.push({ name, appliedAt: new Date(result.rows[0].applied_at).toISOString() });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return applied;
}
