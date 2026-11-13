import 'reflect-metadata';
import 'dotenv/config';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import request from 'supertest';
import { TradingController } from '../src/infrastructure/http/trading.controller';
import { ErrorFilter } from '../src/infrastructure/http/error.filter';
import { TradingService } from '../src/application/trading.service';
import { PostgresTradingStore } from '../src/infrastructure/postgres/trading.store';
import { requireLocalDatabase } from '../scripts/local-database';

// Never fall back to the application database for tests.
const url = process.env.TEST_DATABASE_URL
  ? requireLocalDatabase(process.env.TEST_DATABASE_URL)
  : undefined;

// Instruments: 1 = TEST (latest close 12, previous 10), 2 = ARS (cash), 3 = NOQ (no quotes).
const STOCK = 1;
const CASH = 2;
const NO_QUOTE = 3;
const USER = 1;
const OTHER_USER = 2;

describe('Orders API against PostgreSQL', { skip: !url }, () => {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  let admin: Pool;
  let pool: Pool;
  let app: INestApplication;

  const http = () => request(app.getHttpServer());
  const marketBuy = (size: number) => ({ instrumentId: STOCK, side: 'BUY', type: 'MARKET', size });
  const placeOrder = (body: object, { user = USER, key }: { user?: number; key?: string } = {}) => {
    const req = http().post(`/api/v1/users/${user}/orders`);
    return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body);
  };
  const portfolio = async (user = USER) =>
    (await http().get(`/api/v1/users/${user}/portfolio`).expect(200)).body;
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await pool.query(sql, params)).rows[0].count);

  /** Inserts an existing movement directly, as if it had happened before. */
  const givenOrder = (
    instrumentId: number,
    side: string,
    size: number,
    price = '1',
    status = 'FILLED',
    user = USER,
  ) =>
    pool.query(
      `INSERT INTO orders(userid,instrumentid,size,price,side,type,status,datetime)
       VALUES($1,$2,$3,$4,$5,'MARKET',$6,clock_timestamp())`,
      [user, instrumentId, size, price, side, status],
    );
  const givenCash = (amount: number, user = USER) =>
    givenOrder(CASH, 'CASH_IN', amount, '1', 'FILLED', user);

  before(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
    await pool.query(await readFile('sql/001_schema.sql', 'utf8'));
    await pool.query(`
      INSERT INTO instruments(id,ticker,name,type) VALUES
        (${STOCK},'TEST','Test Asset','ACCIONES'),
        (${CASH},'ARS','Pesos','MONEDA'),
        (${NO_QUOTE},'NOQ','No Quote Corp','ACCIONES');
      INSERT INTO marketdata(instrumentid,close,previousclose,date) VALUES
        (${STOCK},10,9,'2023-07-13'),
        (${STOCK},12,10,'2023-07-14');`);

    @Module({
      controllers: [TradingController],
      providers: [
        { provide: TradingService, useValue: new TradingService(new PostgresTradingStore(pool)) },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    })
    class TestModule {}

    app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE order_requests, orders, users RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO users(id,email) VALUES(${USER},'user@test'),(${OTHER_USER},'other@test')`,
    );
  });

  after(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  describe('POST /users/:userId/orders', () => {
    test('MARKET buy fills at the latest close and updates the portfolio', async () => {
      await givenCash(100);

      const { body } = await placeOrder(marketBuy(2)).expect(201);
      assert.equal(body.status, 'FILLED');
      assert.equal(body.price, '12.00');
      assert.equal(body.size, 2);

      const current = await portfolio();
      assert.equal(current.cash, '76.00');
      assert.equal(current.positions[0].quantity, 2);
    });

    test('amount buys the maximum whole number of shares', async () => {
      await givenCash(100);
      const body = { instrumentId: STOCK, side: 'BUY', type: 'MARKET', amount: '25.00' };
      assert.equal((await placeOrder(body).expect(201)).body.size, 2);
    });

    test('a buy above available cash is stored as REJECTED', async () => {
      await givenCash(10);

      const { body } = await placeOrder(marketBuy(1)).expect(201);
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_FUNDS');
      assert.equal(await count(`SELECT count(*) FROM orders WHERE status='REJECTED'`), 1);
      assert.equal((await portfolio()).cash, '10.00');
    });

    test('a sell above held shares is stored as REJECTED', async () => {
      await givenOrder(STOCK, 'BUY', 2, '10');

      const { body } = await placeOrder({ ...marketBuy(3), side: 'SELL' }).expect(201);
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_SHARES');
    });

    test('a LIMIT buy stays NEW and reserves cash until it is cancelled', async () => {
      await givenCash(100);
      const limit = { instrumentId: STOCK, side: 'BUY', type: 'LIMIT', amount: '95', price: '10' };

      const pending = (await placeOrder(limit).expect(201)).body;
      assert.equal(pending.status, 'NEW');
      assert.equal(pending.size, 9);
      assert.equal((await portfolio()).availableCash, '10.00');
      assert.equal((await placeOrder(marketBuy(1)).expect(201)).body.status, 'REJECTED');

      await http().patch(`/api/v1/users/${USER}/orders/${pending.id}/cancel`).expect(200);
      assert.equal((await portfolio()).availableCash, '100.00');
      assert.equal((await placeOrder(marketBuy(1)).expect(201)).body.status, 'FILLED');
    });

    test('a LIMIT sell reserves shares, so they cannot be sold twice', async () => {
      await givenOrder(STOCK, 'BUY', 5, '10');
      const limit = { instrumentId: STOCK, side: 'SELL', type: 'LIMIT', size: 4, price: '20' };

      assert.equal((await placeOrder(limit).expect(201)).body.status, 'NEW');
      assert.equal((await portfolio()).positions[0].availableQuantity, 1);

      const second = await placeOrder({ ...marketBuy(2), side: 'SELL' }).expect(201);
      assert.equal(second.body.rejectionReason, 'INSUFFICIENT_SHARES');
    });

    test('business errors respond without creating an order', async () => {
      await givenCash(100);
      const cases: [object, number, string][] = [
        [{ ...marketBuy(1), instrumentId: CASH }, 422, 'INVALID_INSTRUMENT'],
        [{ ...marketBuy(1), instrumentId: 999 }, 404, 'INSTRUMENT_NOT_FOUND'],
        [{ ...marketBuy(1), instrumentId: NO_QUOTE }, 422, 'PRICE_UNAVAILABLE'],
        [{ instrumentId: STOCK, side: 'BUY', type: 'MARKET', amount: '5' }, 422, 'INVALID_SIZE'],
      ];
      for (const [body, status, code] of cases)
        assert.equal((await placeOrder(body).expect(status)).body.code, code);

      await placeOrder(marketBuy(1), { user: 999 }).expect(404);
      assert.equal(await count(`SELECT count(*) FROM orders WHERE side='BUY'`), 0);
    });

    test('malformed requests return 400 without creating an order', async () => {
      await givenCash(100);
      const bodies = [
        { ...marketBuy(1), size: 1.5 },
        { ...marketBuy(1), amount: '10' },
        { ...marketBuy(1), type: 'LIMIT' },
        { ...marketBuy(1), instrumentId: '1 OR 1=1' },
      ];
      for (const body of bodies) await placeOrder(body).expect(400);

      await placeOrder(marketBuy(1), { key: '' }).expect(400);
      await placeOrder(marketBuy(1), { key: 'x'.repeat(129) }).expect(400);
      await http().post('/api/v1/users/abc/orders').send(marketBuy(1)).expect(400);
      assert.equal(await count(`SELECT count(*) FROM orders WHERE side='BUY'`), 0);
    });

    test('concurrent orders for the same user cannot overspend', async () => {
      await givenCash(100);

      const responses = await Promise.all([placeOrder(marketBuy(5)), placeOrder(marketBuy(5))]);
      assert.deepEqual(responses.map((r) => r.body.status).sort(), ['FILLED', 'REJECTED']);
    });

    test('a failure saving the idempotency key rolls back the order', async () => {
      await givenCash(100);
      await pool.query(`
        CREATE FUNCTION fail_request() RETURNS trigger LANGUAGE plpgsql
          AS $$ BEGIN RAISE EXCEPTION 'test fault'; END $$;
        CREATE TRIGGER fail_request BEFORE INSERT ON order_requests
          FOR EACH ROW EXECUTE FUNCTION fail_request();`);
      try {
        await placeOrder(marketBuy(1), { key: 'rollback' }).expect(500);
        assert.equal(await count(`SELECT count(*) FROM orders WHERE side='BUY'`), 0);
      } finally {
        await pool.query('DROP TRIGGER fail_request ON order_requests; DROP FUNCTION fail_request');
      }
      await placeOrder(marketBuy(1), { key: 'rollback' }).expect(201);
    });
  });

  describe('Idempotency-Key', () => {
    test('concurrent retries with the same key create a single order', async () => {
      await givenCash(100);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => placeOrder(marketBuy(2), { key: 'same-key' })),
      );
      for (const response of responses) {
        assert.equal(response.status, 201);
        assert.deepEqual(response.body, responses[0].body);
      }
      assert.equal(await count(`SELECT count(*) FROM orders WHERE side='BUY'`), 1);
    });

    test('reusing a key with a different body is a conflict', async () => {
      await givenCash(100);
      await placeOrder(marketBuy(1), { key: 'k' }).expect(201);
      assert.equal(
        (await placeOrder(marketBuy(2), { key: 'k' }).expect(409)).body.code,
        'IDEMPOTENCY_CONFLICT',
      );
    });

    test('keys are scoped per user', async () => {
      await givenCash(100);
      await givenCash(100, OTHER_USER);
      const first = (await placeOrder(marketBuy(1), { key: 'k' }).expect(201)).body;
      const other = (await placeOrder(marketBuy(1), { key: 'k', user: OTHER_USER })).body;
      assert.notEqual(other.id, first.id);
    });
  });

  describe('PATCH /users/:userId/orders/:orderId/cancel', () => {
    test('only NEW orders can be cancelled; cancelling twice is harmless', async () => {
      await givenCash(100);
      const limit = { instrumentId: STOCK, side: 'BUY', type: 'LIMIT', size: 1, price: '10' };
      const pending = (await placeOrder(limit).expect(201)).body;
      const filled = (await placeOrder(marketBuy(1)).expect(201)).body;
      const rejected = (await placeOrder(marketBuy(100)).expect(201)).body;
      const cancel = (id: number, user = USER) =>
        http().patch(`/api/v1/users/${user}/orders/${id}/cancel`);

      assert.equal((await cancel(pending.id).expect(200)).body.status, 'CANCELLED');
      await cancel(pending.id).expect(200);
      await cancel(filled.id).expect(409);
      await cancel(rejected.id).expect(409);
      await cancel(pending.id, OTHER_USER).expect(404);

      const current = await http().get(`/api/v1/users/${USER}/orders/${pending.id}`).expect(200);
      assert.equal(current.body.status, 'CANCELLED');
    });
  });

  describe('GET /users/:userId/portfolio', () => {
    test('reports cash, reservations, positions and returns', async () => {
      await givenCash(1000);
      await givenOrder(STOCK, 'BUY', 10, '10');
      await givenOrder(STOCK, 'SELL', 4, '11');
      await givenOrder(STOCK, 'BUY', 1, '10', 'NEW');
      await givenOrder(NO_QUOTE, 'BUY', 5, '20');

      const body = await portfolio();
      assert.equal(body.cash, '844.00');
      assert.equal(body.reservedCash, '10.00');
      assert.equal(body.availableCash, '834.00');
      assert.equal(body.positionsValue, '72.00');
      assert.equal(body.totalValue, '916.00');

      type Position = { ticker: string; [field: string]: unknown };
      const byTicker = (ticker: string) =>
        (body.positions as Position[]).find((position) => position.ticker === ticker)!;
      const stock = byTicker('TEST');
      const noQuote = byTicker('NOQ');
      assert.deepEqual(
        {
          quantity: stock.quantity,
          marketValue: stock.marketValue,
          costBasis: stock.costBasis,
          returnPercent: stock.returnPercent,
          dailyReturnPercent: stock.dailyReturnPercent,
        },
        {
          quantity: 6,
          marketValue: '72.00',
          costBasis: '60.00',
          returnPercent: '20.0000',
          dailyReturnPercent: '20.0000',
        },
      );
      assert.equal(noQuote.quantity, 5);
      assert.equal(noQuote.marketValue, null);
    });

    test('reads do not wait for an in-flight order on the same account', async () => {
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(`SELECT id FROM users WHERE id=${USER} FOR UPDATE`);
        await http()
          .get(`/api/v1/users/${USER}/portfolio`)
          .timeout({ response: 1000, deadline: 2000 })
          .expect(200);
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
    });

    test('unknown users return 404', async () => {
      await http().get('/api/v1/users/999/portfolio').expect(404);
    });
  });

  describe('GET /instruments', () => {
    const search = async (query: Record<string, string | number>) =>
      (await http().get('/api/v1/instruments').query(query).expect(200)).body as {
        ticker: string;
      }[];

    test('matches ticker or name, case insensitive, and excludes cash', async () => {
      assert.deepEqual(
        (await search({ q: 'tes' })).map((i) => i.ticker),
        ['TEST'],
      );
      assert.deepEqual(
        (await search({ q: 'ASSET' })).map((i) => i.ticker),
        ['TEST'],
      );
      assert.deepEqual(await search({ q: 'pesos' }), []);
    });

    test('paginates ordered by ticker', async () => {
      assert.deepEqual(
        (await search({ q: 't', limit: 1 })).map((i) => i.ticker),
        ['NOQ'],
      );
      assert.deepEqual(
        (await search({ q: 't', limit: 1, offset: 1 })).map((i) => i.ticker),
        ['TEST'],
      );
    });

    test('treats SQL in the query as a literal value', async () => {
      assert.deepEqual(await search({ q: "' OR 1=1 --" }), []);
    });

    test('requires a query', async () => {
      await http().get('/api/v1/instruments').expect(400);
    });
  });
});
