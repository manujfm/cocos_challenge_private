import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cashBalance, shareBalance } from '../src/domain/balance';
import { InstrumentType, Order, OrderSide, OrderStatus, Snapshot } from '../src/domain/model';
import { evaluateOrder } from '../src/domain/order-evaluation';
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

const deposit = (size: number) =>
  order({ instrumentId: 2, side: OrderSide.CASH_IN, size, price: '1' });

const snapshot = (orders: Order[]): Snapshot => ({
  orders,
  instruments: [
    { id: 1, ticker: 'TEST', name: 'Test', type: InstrumentType.ACCIONES },
    { id: 2, ticker: 'ARS', name: 'Pesos', type: InstrumentType.MONEDA },
  ],
  quotes: [{ instrumentId: 1, close: '12.00', previousClose: '10.00', date: '2023-01-02' }],
});

describe('balance', () => {
  test('transfers use size, trades use size * price and NEW orders reserve', () => {
    const orders = [
      order({ side: OrderSide.CASH_IN, size: 1000, price: '42' }),
      order({}),
      order({ side: OrderSide.CASH_OUT, size: 50 }),
      order({ side: OrderSide.SELL, size: 2, price: '15' }),
      order({ status: OrderStatus.NEW, size: 5 }),
      order({ status: OrderStatus.NEW, side: OrderSide.SELL, size: 3 }),
      order({ status: OrderStatus.REJECTED, size: 999 }),
      order({ status: OrderStatus.CANCELLED, size: 999 }),
    ];

    const cash = cashBalance(orders);
    assert.equal(cash.cash.toFixed(2), '880.00');
    assert.equal(cash.availableCash.toFixed(2), '830.00');

    const shares = shareBalance(orders, 1);
    assert.equal(shares.shares, 8);
    assert.equal(shares.availableShares, 5);
  });
});

describe('evaluateOrder', () => {
  test('MARKET fills at the latest close, ignoring historical prices', () => {
    const result = evaluateOrder(
      { instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', size: 2 },
      snapshot([deposit(100), order({ price: '1.00', size: 1 })]),
    );
    assert.equal(result.price, '12.00');
    assert.equal(result.status, OrderStatus.FILLED);
    assert.equal(result.rejectionReason, null);
  });

  test('LIMIT uses the requested price and stays NEW', () => {
    const result = evaluateOrder(
      { instrumentId: 1, side: OrderSide.BUY, type: 'LIMIT', size: 1, price: '8.00' },
      snapshot([deposit(100)]),
    );
    assert.equal(result.price, '8.00');
    assert.equal(result.status, OrderStatus.NEW);
  });

  test('amount buys the maximum whole number of shares with exact decimals', () => {
    const s = snapshot([deposit(100)]);
    s.quotes[0].close = '0.10';
    const result = evaluateOrder(
      { instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', amount: '0.35' },
      s,
    );
    assert.equal(result.size, 3);
  });

  test('insufficient funds or shares produce a REJECTED order with its reason', () => {
    const buy = evaluateOrder(
      { instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', size: 1 },
      snapshot([]),
    );
    assert.equal(buy.status, OrderStatus.REJECTED);
    assert.equal(buy.rejectionReason, 'INSUFFICIENT_FUNDS');

    const sell = evaluateOrder(
      { instrumentId: 1, side: OrderSide.SELL, type: 'MARKET', size: 1 },
      snapshot([]),
    );
    assert.equal(sell.status, OrderStatus.REJECTED);
    assert.equal(sell.rejectionReason, 'INSUFFICIENT_SHARES');
  });

  test('invalid business input throws instead of creating an order', () => {
    const cases: [Parameters<typeof evaluateOrder>[0], RegExp][] = [
      [{ instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', amount: '1.00' }, /one share/],
      [{ instrumentId: 2, side: OrderSide.BUY, type: 'MARKET', size: 1 }, /Cash instruments/],
      [{ instrumentId: 99, side: OrderSide.BUY, type: 'MARKET', size: 1 }, /not found/],
    ];
    for (const [input, error] of cases)
      assert.throws(() => evaluateOrder(input, snapshot([deposit(100)])), error);

    const withoutQuote = snapshot([deposit(100)]);
    withoutQuote.quotes = [];
    assert.throws(
      () =>
        evaluateOrder(
          { instrumentId: 1, side: OrderSide.BUY, type: 'MARKET', size: 1 },
          withoutQuote,
        ),
      /No valid price/,
    );
  });
});

describe('buildPortfolio', () => {
  test('values positions at weighted average cost and keeps reservations apart', () => {
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
    assert.equal(portfolio.positionsValue, '180.00');
    assert.equal(portfolio.totalValue, '1030.00');

    const [position] = portfolio.positions;
    assert.equal(position.quantity, 15);
    assert.equal(position.availableQuantity, 12);
    assert.equal(position.costBasis, '225.00');
    assert.equal(position.returnPercent, '-20.0000');
    assert.equal(position.dailyReturnPercent, '20.0000');
  });

  test('omits closed positions and returns null cost and return for short positions', () => {
    assert.deepEqual(
      buildPortfolio(snapshot([order({}), order({ side: OrderSide.SELL, size: 10 })])).positions,
      [],
    );

    const legacy = snapshot([
      order({ size: 20 }),
      order({ id: 2, side: OrderSide.SELL, size: 30 }),
    ]);
    legacy.quotes[0].previousClose = null;
    const [position] = buildPortfolio(legacy).positions;
    assert.equal(position.quantity, -10);
    assert.equal(position.marketValue, '-120.00');
    assert.equal(position.costBasis, null);
    assert.equal(position.returnPercent, null);
    assert.equal(position.dailyReturnPercent, null);
  });

  test('a position without quote is listed without value and excluded from the total', () => {
    const s = snapshot([deposit(1000), order({ size: 5, price: '20.00' })]);
    s.quotes = [];
    const portfolio = buildPortfolio(s);
    assert.equal(portfolio.positionsValue, '0.00');
    assert.equal(portfolio.totalValue, '900.00');

    const [position] = portfolio.positions;
    assert.equal(position.quantity, 5);
    assert.equal(position.costBasis, '100.00');
    assert.equal(position.marketPrice, null);
    assert.equal(position.marketValue, null);
    assert.equal(position.returnPercent, null);
    assert.equal(position.quoteDate, null);
  });
});

describe('order request validation', () => {
  const base = { instrumentId: 1, side: OrderSide.BUY, type: 'MARKET' };

  test('rejects malformed shapes', () => {
    for (const body of [
      { size: 1, amount: 10 },
      {},
      { size: 0 },
      { size: 1.5 },
      { size: 1, price: 10 },
      { amount: 0.001 },
      { size: 1, unknown: 1 },
      { type: 'LIMIT', size: 1 },
    ])
      assert.equal(
        orderSchema.safeParse({ ...base, ...body }).success,
        false,
        JSON.stringify(body),
      );
  });

  test('normalizes decimal inputs to two decimals', () => {
    const parsed = orderSchema.parse({ ...base, type: 'LIMIT', size: 1, price: '10.0' });
    assert.equal(parsed.price, '10.00');
  });
});
