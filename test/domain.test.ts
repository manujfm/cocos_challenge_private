import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availability,
  evaluateOrder,
  Order,
  Snapshot,
  OrderStatus,
  InstrumentType,
  OrderSide,
} from '../src/domain/model';
import { buildPortfolio } from '../src/domain/portfolio';
import { orderSchema } from '../src/infrastructure/http/validation';
const order = (overrides: Partial<Order>): Order => ({
  id: 1,
  userId: 1,
  instrumentId: 1,
  size: 10,
  price: '10.00',
  side: OrderSide.BUY,
  type: 'MARKET',
  status: OrderStatus.FILLED,
  datetime: '2023-01-01',
  ...overrides,
});
const snapshot = (orders: Order[]): Snapshot => ({
  orders,
  instruments: [{ id: 1, ticker: 'TEST', name: 'Test', type: InstrumentType.ACCIONES }],
  quotes: [{ instrumentId: 1, close: '12.00', previousClose: '10.00', date: '2023-01-02' }],
});
test('Cash movements use size, trades use size * price and NEW reserves funds', () => {
  const b = availability(
    [
      order({ side: OrderSide.CASH_IN, size: 1000, price: '42' }),
      order({}),
      order({ side: OrderSide.CASH_OUT, size: 50 }),
      order({ side: OrderSide.SELL, size: 2, price: '15' }),
      order({ status: OrderStatus.NEW, size: 5 }),
      order({ status: OrderStatus.REJECTED, size: 999 }),
    ],
    1,
  );
  assert.equal(b.cash.toFixed(2), '880.00');
  assert.equal(b.availableCash.toFixed(2), '830.00');
  assert.equal(b.shares, 8);
});
test('Budget floors shares using exact decimal arithmetic and MARKET ignores historical order prices', () => {
  const s = snapshot([order({ side: OrderSide.CASH_IN, size: 100 })]);
  s.quotes[0].close = '0.10';
  const result = evaluateOrder(
    { instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', amount: '0.30' },
    s,
  );
  assert.equal(result.size, 3);
  assert.equal(result.price, '0.10');
  assert.equal(result.status, OrderStatus.FILLED);
});
test('Insufficient funds and shares produce persisted rejection candidates', () => {
  assert.equal(
    evaluateOrder({ instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', size: 1 }, snapshot([]))
      .status,
    OrderStatus.REJECTED,
  );
  assert.equal(
    evaluateOrder({ instrumentId: 1, side: OrderSide.SELL, type: 'MARKET', size: 1 }, snapshot([]))
      .rejectionReason,
    'INSUFFICIENT_SHARES',
  );
});
test('Weighted average remaining cost after partial sales, daily return and account valuation', () => {
  const p = buildPortfolio(
    snapshot([
      order({ side: OrderSide.CASH_IN, size: 1000 }),
      order({}),
      order({ id: 2, side: OrderSide.SELL, size: 4, price: '11', datetime: '2023-01-02' }),
    ]),
  );
  assert.equal(p.cash, '944.00');
  assert.equal(p.positions[0].quantity, 6);
  assert.equal(p.positions[0].costBasis, '60.00');
  assert.equal(p.positions[0].returnPercent, '20.0000');
  assert.equal(p.positions[0].dailyReturnPercent, '20.0000');
  assert.equal(p.totalValue, '1016.00');
});
test('Invalid order shapes are rejected and decimal inputs canonicalized', () => {
  for (const body of [
    { size: 1, amount: 10 },
    {},
    { size: 0 },
    { size: 1, price: 10 },
    { amount: 0.001 },
    { size: 1, unknown: 1 },
  ])
    assert.equal(
      orderSchema.safeParse({ instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', ...body })
        .success,
      false,
    );
  assert.equal(
    orderSchema.safeParse({ instrumentId: 1, side: OrderSide.BUY, type: 'LIMIT', size: 1 }).success,
    false,
  );
  assert.equal(
    orderSchema.parse({
      instrumentId: 1,
      side: OrderSide.BUY,
      type: 'LIMIT',
      size: 1,
      price: '10.0',
    }).price,
    '10.00',
  );
});
test('Amount below one share is invalid; LIMIT uses its requested price', () => {
  assert.throws(
    () =>
      evaluateOrder(
        { instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', amount: '1.00' },
        snapshot([]),
      ),
    /at least one share/,
  );
  assert.equal(
    evaluateOrder(
      { instrumentId: 1, side: OrderSide.BUY, type: 'LIMIT', size: 1, price: '8.00' },
      snapshot([order({ side: OrderSide.CASH_IN, size: 100 })]),
    ).status,
    OrderStatus.NEW,
  );
});

test('Portfolio keeps weighted costs, reservations and rejected movements separate', () => {
  const portfolio = buildPortfolio(
    snapshot([
      order({ id: 4, side: OrderSide.SELL, size: 5, price: '30.00', datetime: '2023-01-04' }),
      order({ id: 1, side: OrderSide.CASH_IN, size: 1000 }),
      order({ id: 3, size: 10, price: '20.00', datetime: '2023-01-03' }),
      order({ id: 2, size: 10, price: '10.00', datetime: '2023-01-02' }),
      order({ status: OrderStatus.NEW, size: 1, price: '10.00' }),
      order({ status: OrderStatus.NEW, side: OrderSide.SELL, size: 3 }),
      order({ status: OrderStatus.REJECTED, side: OrderSide.SELL, size: 999 }),
      order({ status: OrderStatus.CANCELLED, size: 999 }),
    ]),
  );
  assert.equal(portfolio.cash, '850.00');
  assert.equal(portfolio.reservedCash, '10.00');
  assert.equal(portfolio.availableCash, '840.00');
  assert.equal(portfolio.positions[0].quantity, 15);
  assert.equal(portfolio.positions[0].availableQuantity, 12);
  assert.equal(portfolio.positions[0].costBasis, '225.00');
  assert.equal(portfolio.positions[0].returnPercent, '-20.0000');
  assert.equal(portfolio.totalValue, '1030.00');
});

test('Portfolio omits closed positions and preserves legacy short positions with undefined returns', () => {
  const closed = snapshot([order({}), order({ side: OrderSide.SELL, size: 10 })]);
  closed.quotes = [];
  assert.deepEqual(buildPortfolio(closed).positions, []);

  const legacy = snapshot([order({ size: 20 }), order({ side: OrderSide.SELL, size: 30, id: 2 })]);
  legacy.quotes[0].previousClose = null;
  const portfolio = buildPortfolio(legacy);
  assert.equal(portfolio.positions[0].quantity, -10);
  assert.equal(portfolio.positions[0].marketValue, '-120.00');
  assert.equal(portfolio.positions[0].costBasis, null);
  assert.equal(portfolio.positions[0].returnPercent, null);
  assert.equal(portfolio.positions[0].dailyReturnPercent, null);
});
