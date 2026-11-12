import 'reflect-metadata';
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { NestFactory, APP_FILTER } from '@nestjs/core';
import { Module } from '@nestjs/common';
import request from 'supertest';
import { TradingController } from '../src/infrastructure/http/trading.controller';
import { ErrorFilter } from '../src/infrastructure/http/error.filter';
import { TradingService } from '../src/application/trading.service';
import { PostgresTradingStore } from '../src/infrastructure/postgres/trading.store';
import { requireLocalDatabase } from '../scripts/local-database';
import { Order, InstrumentType, OrderSide } from '../src/domain/model';
// Never fall back to the application database for tests.
const url = process.env.TEST_DATABASE_URL
  ? requireLocalDatabase(process.env.TEST_DATABASE_URL)
  : undefined;
test(
  'HTTP order workflow against PostgreSQL in an isolated, temporary schema',
  { skip: !url },
  async (t) => {
    const schema = 'test_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: url, enableChannelBinding: true });
    let pool: Pool | undefined, app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
      await pool.query(await readFile('sql/001_schema.sql', 'utf8'));
      await pool.query(`INSERT INTO users(id,email) VALUES(1,'test@test'),(2,'empty@test');
   INSERT INTO instruments(id,ticker,name,type) VALUES(1,'TEST','Test Asset','ACCIONES'),(2,'ARS','Pesos','MONEDA');
   INSERT INTO marketdata(instrumentid,close,previousclose,date) VALUES(1,10,9,'2023-07-13'),(1,12,10,'2023-07-14');
   INSERT INTO orders(userid,instrumentid,size,price,side,type,status,datetime) VALUES(1,2,100,'1','CASH_IN','MARKET','FILLED','2023-01-01')`);
      const service = new TradingService(new PostgresTradingStore(pool));
      @Module({
        controllers: [TradingController],
        providers: [
          { provide: TradingService, useValue: service },
          { provide: APP_FILTER, useClass: ErrorFilter },
        ],
      })
      class TestModule {}
      app = await NestFactory.create(TestModule, { logger: false });
      app.setGlobalPrefix('api/v1');
      await app.init();
      const http = request(app.getHttpServer());
      const body = { instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', size: 2 };
      const post = (key: string, data: object = body, user = 1) =>
        http.post(`/api/v1/users/${user}/orders`).set('Idempotency-Key', key).send(data);
      await t.test('Validation and missing idempotency key', async () => {
        await http.post('/api/v1/users/1/orders').send(body).expect(400);
        await http
          .post('/api/v1/users/not-a-number/orders')
          .set('Idempotency-Key', 'invalid-id')
          .send(body)
          .expect(400);
        await post('x'.repeat(129)).expect(400);
        await post('invalid', { ...body, size: 1.5 }).expect(400);
        await post('invalid', { ...body, size: 1, amount: 10 }).expect(400);
        await post('invalid', { ...body, type: 'LIMIT' }).expect(400);
        await post('unknown-user', body, 999).expect(404);
      });
      let first: Order;
      await t.test(
        'Concurrent retries create exactly one order and return the same response',
        async () => {
          const responses = await Promise.all(Array.from({ length: 8 }, () => post('same-key')));
          first = responses[0].body;
          assert.equal(first.price, '12.00');
          assert.equal(first.status, 'FILLED');
          for (const r of responses) {
            assert.equal(r.status, 201);
            assert.deepEqual(r.body, first);
          }
          assert.equal(
            (await pool!.query("SELECT count(*) FROM orders WHERE side='BUY'")).rows[0].count,
            '1',
          );
          await post('same-key', { ...body, size: 1 }).expect(409);
        },
      );
      await t.test(
        'Concurrent distinct keys cannot overspend; rejected orders are stored',
        async () => {
          const rs = await Promise.all([
            post('spend-a', { ...body, size: 5 }),
            post('spend-b', { ...body, size: 5 }),
          ]);
          assert.deepEqual(rs.map((r) => r.body.status).sort(), ['FILLED', 'REJECTED']);
          const rejected = rs.find((r) => r.body.status === 'REJECTED')!;
          assert.equal(rejected.body.rejectionReason, 'INSUFFICIENT_FUNDS');
          assert.equal(
            (await pool!.query("SELECT count(*) FROM orders WHERE status='REJECTED'")).rows[0]
              .count,
            '1',
          );
        },
      );
      await t.test(
        'Sell reservations, cancellation, replay of original response and portfolio',
        async () => {
          const sell = {
            instrumentId: 1,
            side: OrderSide.SELL,
            type: 'LIMIT',
            size: 7,
            price: '20.00',
          };
          const created = (await post('sell-limit', sell).expect(201)).body;
          assert.equal(created.status, 'NEW');
          const rejected = (
            await post('oversell', { ...body, side: OrderSide.SELL, size: 1 }).expect(201)
          ).body;
          assert.equal(rejected.status, 'REJECTED');
          const before = (await http.get('/api/v1/users/1/portfolio').expect(200)).body;
          assert.equal(before.cash, '16.00');
          assert.equal(before.positions[0].availableQuantity, 0);
          await http.patch(`/api/v1/users/1/orders/${created.id}/cancel`).expect(200);
          await http.patch(`/api/v1/users/1/orders/${created.id}/cancel`).expect(200);
          assert.deepEqual((await post('sell-limit', sell).expect(201)).body, created);
          assert.equal(
            (await http.get(`/api/v1/users/1/orders/${created.id}`).expect(200)).body.status,
            'CANCELLED',
          );
          await http.patch(`/api/v1/users/1/orders/${first.id}/cancel`).expect(409);
          await http.get(`/api/v1/users/2/orders/${first.id}`).expect(404);
          assert.equal(
            (await post('sell-market', { ...body, side: OrderSide.SELL, size: 7 }).expect(201)).body
              .status,
            'FILLED',
          );
          assert.equal(
            (await http.get('/api/v1/users/1/portfolio').expect(200)).body.cash,
            '100.00',
          );
        },
      );
      await t.test(
        'LIMIT cash reservation, amount sizing and cancellation releases funds',
        async () => {
          const pending = (
            await post('reserve', {
              instrumentId: 1,
              side: OrderSide.BUY,
              type: 'LIMIT',
              amount: '95.00',
              price: '10.00',
            }).expect(201)
          ).body;
          assert.equal(pending.size, 9);
          assert.equal(pending.status, 'NEW');
          assert.equal(
            (await post('reserved-buy', { ...body, size: 1 }).expect(201)).body.status,
            'REJECTED',
          );
          await http.patch(`/api/v1/users/1/orders/${pending.id}/cancel`).expect(200);
          assert.equal(
            (
              await post('budget', {
                instrumentId: 1,
                side: OrderSide.BUY,
                type: 'MARKET',
                amount: '25.00',
              }).expect(201)
            ).body.size,
            2,
          );
        },
      );
      await t.test(
        'Order insert failures roll back without saving the idempotency key',
        async () => {
          await pool!
            .query(`CREATE FUNCTION fail_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test insert failure'; END $$;
          CREATE TRIGGER fail_order BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION fail_order()`);
          const countBefore = (await pool!.query('SELECT count(*) FROM orders')).rows[0].count;
          const failed = await post('failed-order-insert', { ...body, size: 1 }).expect(500);
          assert.deepEqual(failed.body, {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error',
          });
          assert.equal(
            (await pool!.query('SELECT count(*) FROM orders')).rows[0].count,
            countBefore,
          );
          assert.equal(
            (
              await pool!.query('SELECT count(*) FROM order_requests WHERE key=$1', [
                'failed-order-insert',
              ])
            ).rows[0].count,
            '0',
          );
          await pool!.query('DROP TRIGGER fail_order ON orders');
          const retried = (await post('failed-order-insert', { ...body, size: 1 }).expect(201))
            .body;
          assert.deepEqual(
            (await post('failed-order-insert', { ...body, size: 1 }).expect(201)).body,
            retried,
          );
        },
      );
      await t.test('Atomic rollback when idempotency persistence fails', async () => {
        await pool!
          .query(`CREATE FUNCTION fail_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test fault'; END $$;
    CREATE TRIGGER fail_request BEFORE INSERT ON order_requests FOR EACH ROW EXECUTE FUNCTION fail_request()`);
        const count = (await pool!.query('SELECT count(*) FROM orders')).rows[0].count;
        await post('rollback', { ...body, size: 1 }).expect(500);
        assert.equal((await pool!.query('SELECT count(*) FROM orders')).rows[0].count, count);
        await pool!.query('DROP TRIGGER fail_request ON order_requests');
        await post('rollback', { ...body, size: 1 }).expect(201);
      });
      await t.test('Portfolio and order reads do not wait for the account write lock', async () => {
        const writer = await pool!.connect();
        try {
          await writer.query('BEGIN');
          await writer.query('SELECT id FROM users WHERE id=1 FOR UPDATE');
          await http
            .get('/api/v1/users/1/portfolio')
            .timeout({ response: 1000, deadline: 2000 })
            .expect(200);
          await http
            .get(`/api/v1/users/1/orders/${first.id}`)
            .timeout({ response: 1000, deadline: 2000 })
            .expect(200);
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
      });
      await t.test('Search by ticker and name is case insensitive and parameterized', async () => {
        assert.equal(
          (await http.get('/api/v1/instruments?q=tes').expect(200)).body[0].ticker,
          'TEST',
        );
        assert.equal(
          (await http.get('/api/v1/instruments?q=asset').expect(200)).body[0].ticker,
          'TEST',
        );
        assert.deepEqual(
          (await http.get('/api/v1/instruments').query({ q: "' OR 1=1 --" }).expect(200)).body,
          [],
        );
      });
      await t.test('SQL injection payloads are treated as literal search values', async () => {
        const payloads = [
          "' OR 1=1 --",
          "%' OR 1=1 --",
          "' UNION SELECT id,email,email,email FROM users --",
          "'; UPDATE users SET email='injected'; --",
        ];
        const before = (await pool!.query('SELECT id,email FROM users ORDER BY id')).rows;
        for (const payload of payloads) {
          const response = await http.get('/api/v1/instruments').query({ q: payload }).expect(200);
          assert.deepEqual(response.body, []);
        }
        assert.deepEqual(
          (await pool!.query('SELECT id,email FROM users ORDER BY id')).rows,
          before,
        );

        // Legitimate apostrophes and SQL words remain searchable.
        await pool!.query('INSERT INTO instruments(id,ticker,name,type) VALUES($1,$2,$3,$4)', [
          3,
          'DROP',
          "O'Reilly SELECT",
          InstrumentType.ACCIONES,
        ]);
        for (const q of ["O'Reilly", 'SELECT', 'DROP']) {
          const response = await http.get('/api/v1/instruments').query({ q }).expect(200);
          assert.equal(response.body.length, 1);
          assert.equal(response.body[0].name, "O'Reilly SELECT");
        }
      });
      await t.test('SQL injection payloads in route and order fields are rejected', async () => {
        const payload = '1 OR 1=1';
        const encoded = encodeURIComponent(payload);
        await http.get(`/api/v1/users/${encoded}/portfolio`).expect(400);
        await http.get(`/api/v1/users/1/orders/${encoded}`).expect(400);
        await http.patch(`/api/v1/users/1/orders/${encoded}/cancel`).expect(400);
        const before = (await pool!.query('SELECT count(*) FROM orders')).rows[0].count;
        for (const field of ['instrumentId', 'size', 'amount', 'price', 'side', 'type']) {
          await post('sql-invalid-body', { ...body, [field]: payload }).expect(400);
        }
        assert.equal((await pool!.query('SELECT count(*) FROM orders')).rows[0].count, before);
      });
      await t.test(
        'Idempotency keys containing SQL remain data and retain replay behavior',
        async () => {
          const key = "key'); UPDATE users SET email='injected'; --";
          const before = (await pool!.query('SELECT id,email FROM users ORDER BY id')).rows;
          const created = (await post(key, body, 2).expect(201)).body;
          assert.equal(created.status, 'REJECTED');
          assert.deepEqual((await post(key, body, 2).expect(201)).body, created);
          const saved = await pool!.query(
            'SELECT key FROM order_requests WHERE userid=$1 AND key=$2',
            [2, key],
          );
          assert.equal(saved.rowCount, 1);
          assert.equal(saved.rows[0].key, key);
          assert.deepEqual(
            (await pool!.query('SELECT id,email FROM users ORDER BY id')).rows,
            before,
          );
        },
      );
    } finally {
      if (app) await app.close();
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
