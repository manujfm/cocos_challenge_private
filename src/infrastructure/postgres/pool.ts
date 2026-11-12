import 'dotenv/config';
import { Pool } from 'pg';
export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({
    connectionString,
    enableChannelBinding: true,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  });
}
