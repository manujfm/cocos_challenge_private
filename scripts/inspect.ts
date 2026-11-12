import { createPool } from '../src/infrastructure/postgres/pool';
import { requireLocalDatabase } from './local-database';
async function main() {
  const pool = createPool(requireLocalDatabase(process.env.DATABASE_URL));
  try {
    console.log(
      (
        await pool.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
   WHERE table_schema='public' ORDER BY table_name,ordinal_position`)
      ).rows,
    );
    console.log(
      (
        await pool.query(`SELECT 'users' AS entity,count(*) FROM users UNION ALL SELECT 'instruments',count(*) FROM instruments
   UNION ALL SELECT 'orders',count(*) FROM orders UNION ALL SELECT 'marketdata',count(*) FROM marketdata`)
      ).rows,
    );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('Database inspection failed');
  process.exitCode = 1;
});
