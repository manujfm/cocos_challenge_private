import { readFile } from 'node:fs/promises';
import { createPool } from '../src/infrastructure/postgres/pool';
import { requireLocalDatabase } from './local-database';
async function main() {
  const pool = createPool(requireLocalDatabase(process.env.DATABASE_URL));
  const client = await pool.connect().catch(async () => {
    await pool.end();
    throw new Error('Local database connection failed');
  });
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(48637219)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const name = '001_schema.sql';
    if (!(await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) {
      await client.query(await readFile(`sql/${name}`, 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
    await client.query('COMMIT');
    console.log('Migrations applied');
  } catch {
    await client.query('ROLLBACK');
    throw new Error('Migration failed; check database schema and connectivity');
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
