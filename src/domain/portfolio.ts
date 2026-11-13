import { cashBalance, shareBalance } from './balance';
import {
  Instrument,
  InstrumentType,
  Order,
  OrderSide,
  OrderStatus,
  Quote,
  Snapshot,
} from './model';
import { Decimal, money } from './money';

export function buildPortfolio(snapshot: Snapshot) {
  const balance = cashBalance(snapshot.orders);
  const ordersByInstrument = groupByInstrument(snapshot.orders);
  const quotes = new Map(snapshot.quotes.map((quote) => [quote.instrumentId, quote]));

  const positions = snapshot.instruments
    .filter((instrument) => instrument.type !== InstrumentType.MONEDA)
    .map((instrument) =>
      buildPosition(
        instrument,
        ordersByInstrument.get(instrument.id) ?? [],
        quotes.get(instrument.id),
      ),
    )
    .filter((position) => position !== null);

  const positionsValue = positions.reduce(
    (total, position) => (position.marketValue === null ? total : total.plus(position.marketValue)),
    new Decimal(0),
  );

  return {
    currency: 'ARS',
    cash: money(balance.cash),
    reservedCash: money(balance.reservedCash),
    availableCash: money(balance.availableCash),
    positionsValue: money(positionsValue),
    totalValue: money(balance.cash.plus(positionsValue)),
    positions,
  };
}

function groupByInstrument(orders: Order[]) {
  const groups = new Map<number, Order[]>();
  for (const order of orders) {
    const group = groups.get(order.instrumentId) ?? [];
    group.push(order);
    groups.set(order.instrumentId, group);
  }
  return groups;
}

/** `orders` must belong to `instrument`. Returns null for closed positions. */
function buildPosition(instrument: Instrument, orders: Order[], quote: Quote | undefined) {
  const { quantity, costBasis } = calculateHolding(orders);
  if (quantity === 0) return null;

  const marketValue = quote ? new Decimal(quote.close).mul(quantity) : null;
  // Short positions (only present in legacy seed data) have no meaningful cost or return.
  const isLong = quantity > 0;

  return {
    instrumentId: instrument.id,
    ticker: instrument.ticker,
    name: instrument.name,
    quantity,
    availableQuantity: shareBalance(orders, instrument.id).availableShares,
    marketPrice: quote ? money(quote.close) : null,
    marketValue: marketValue ? money(marketValue) : null,
    costBasis: isLong ? money(costBasis) : null,
    returnPercent: isLong && marketValue ? calculateReturnPercent(marketValue, costBasis) : null,
    dailyReturnPercent: quote ? calculateReturnPercent(quote.close, quote.previousClose) : null,
    quoteDate: quote?.date ?? null,
  };
}

function calculateHolding(instrumentId: number, orders: Order[]) {
  const filledOrders = orders
    .filter(
      (order) =>
        order.status === OrderStatus.FILLED &&
        (order.side === OrderSide.BUY || order.side === OrderSide.SELL),
    )
    .sort((first, second) => first.datetime.localeCompare(second.datetime) || first.id - second.id);

  let quantity = 0;
  let costBasis = new Decimal(0);

  for (const trade of trades) {
    if (trade.side === OrderSide.BUY) {
      quantity += trade.size;
      costBasis = costBasis.plus(new Decimal(trade.price).mul(trade.size));
    } else {
      const averageCost = quantity > 0 ? costBasis.div(quantity) : new Decimal(0);
      quantity -= trade.size;
      costBasis = costBasis.minus(averageCost.mul(trade.size));
    }
  }

  return { quantity, costBasis };
}

function calculateReturnPercent(currentValue: Decimal.Value, initialValue: Decimal.Value | null) {
  if (initialValue === null) return null;

  const initial = new Decimal(initialValue);
  if (initial.lte(0)) return null;

  return new Decimal(currentValue).minus(initial).div(initial).mul(100).toFixed(4);
}
