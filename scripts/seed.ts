import { readFile } from 'node:fs/promises';
import { createPool } from '../src/infrastructure/postgres/pool';
import { requireLocalDatabase } from './local-database';
async function main() {
  const pool = createPool(requireLocalDatabase(process.env.DATABASE_URL));
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'LOCK TABLE users, instruments, marketdata, orders IN ACCESS EXCLUSIVE MODE',
      );
      const result =
        await client.query(`SELECT EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM instruments)
        OR EXISTS(SELECT 1 FROM marketdata) OR EXISTS(SELECT 1 FROM orders) AS populated`);
      if (result.rows[0].populated) {
        await client.query('COMMIT');
        console.log('Seed skipped: local database already contains data');
        return;
      }
      const source = await readFile('sql/database.sql', 'utf8');
      const insertStart = source.indexOf('INSERT INTO users');
      if (insertStart < 0) throw new Error('Seed INSERT statements not found');
      await client.query(source.slice(insertStart));
      await client.query('COMMIT');
      console.log('Challenge seed loaded: 4 users, 66 instruments, 126 quotes, 11 orders');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('Local seed failed; run db:migrate first and check connectivity');
  process.exitCode = 1;
});
