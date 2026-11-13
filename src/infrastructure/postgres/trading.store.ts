import { Pool, PoolClient } from 'pg';
import { TradingSession, TradingStore, IdempotencyRecord } from '../../application/ports';
import {
  BusinessError,
  ErrorCode,
  Instrument,
  InstrumentType,
  NewOrder,
  Order,
  Snapshot,
  OrderStatus,
} from '../../domain/model';
const orderColumns = `id, userid AS "userId", instrumentid AS "instrumentId", size, price::text, side, type, status,
  to_char(datetime, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS datetime, rejection_reason AS "rejectionReason"`;
class PostgresSession implements TradingSession {
  constructor(
    private readonly db: PoolClient,
    private readonly userId: number,
  ) {}

  async snapshot(): Promise<Snapshot> {
    const orders = await this.db.query<Order>(
      `SELECT ${orderColumns} FROM orders WHERE userid=$1 ORDER BY datetime,id`,
      [this.userId],
    );
    const instruments = await this.db.query<Instrument>(
      'SELECT id,ticker,name,type FROM instruments ORDER BY ticker,id',
    );
    const quotes = await this.db
      .query(`SELECT DISTINCT ON (instrumentid) instrumentid AS "instrumentId", close::text,
      previousclose::text AS "previousClose", date::text FROM marketdata ORDER BY instrumentid,date DESC NULLS LAST,id DESC`);
    return { orders: orders.rows, instruments: instruments.rows, quotes: quotes.rows };
  }

  async findRequest(key: string): Promise<IdempotencyRecord | undefined> {
    return (
      await this.db.query(
        'SELECT fingerprint,response FROM order_requests WHERE userid=$1 AND key=$2',
        [this.userId, key],
      )
    ).rows[0];
  }

  async saveRequest(key: string, fingerprint: string, response: Order) {
    await this.db.query(
      'INSERT INTO order_requests(userid,key,fingerprint,response) VALUES($1,$2,$3,$4::jsonb)',
      [this.userId, key, fingerprint, JSON.stringify(response)],
    );
  }

  async insertOrder(o: NewOrder): Promise<Order> {
    return (
      await this.db.query<Order>(
        `INSERT INTO orders(userid,instrumentid,size,price,side,type,status,datetime,rejection_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,timezone('UTC',clock_timestamp()),$8) RETURNING ${orderColumns}`,
        [this.userId, o.instrumentId, o.size, o.price, o.side, o.type, o.status, o.rejectionReason],
      )
    ).rows[0];
  }

  async getOrder(id: number) {
    return (
      await this.db.query<Order>(`SELECT ${orderColumns} FROM orders WHERE userid=$1 AND id=$2`, [
        this.userId,
        id,
      ])
    ).rows[0];
  }

  async cancelOrder(id: number) {
    return (
      await this.db.query<Order>(
        `UPDATE orders SET status=$3 WHERE userid=$1 AND id=$2 AND status=$4 RETURNING ${orderColumns}`,
        [this.userId, id, OrderStatus.CANCELLED, OrderStatus.NEW],
      )
    ).rows[0];
  }
}

export class PostgresTradingStore extends TradingStore {
  constructor(private readonly pool: Pool) {
    super();
  }

  readUser<T>(userId: number, work: (session: TradingSession) => Promise<T>): Promise<T> {
    return this.runSession(userId, work, false);
  }

  withUserTransaction<T>(
    userId: number,
    work: (session: TradingSession) => Promise<T>,
  ): Promise<T> {
    return this.runSession(userId, work, true);
  }

  private async runSession<T>(
    userId: number,
    work: (session: TradingSession) => Promise<T>,
    lockUser: boolean,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        lockUser
          ? 'BEGIN ISOLATION LEVEL READ COMMITTED'
          : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      await client.query("SET LOCAL lock_timeout = '8s'");
      const user = await client.query(
        `SELECT id FROM users WHERE id=$1 ${lockUser ? 'FOR UPDATE' : ''}`,
        [userId],
      );
      if (!user.rowCount) throw new BusinessError(ErrorCode.USER_NOT_FOUND, 'User not found', 404);
      const result = await work(new PostgresSession(client, userId));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async search(query: string, limit: number, offset: number): Promise<Instrument[]> {
    const literal = query.replace(/[\\%_]/g, '\\$&');
    return (
      await this.pool.query<Instrument>(
        `SELECT id,ticker,name,type FROM instruments WHERE type<>$4
      AND (ticker ILIKE $1 OR name ILIKE $1) ORDER BY ticker,id LIMIT $2 OFFSET $3`,
        [`%${literal}%`, limit, offset, InstrumentType.MONEDA],
      )
    ).rows;
  }
}
