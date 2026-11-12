import Decimal from 'decimal.js';
import {
  availability,
  BusinessError,
  Instrument,
  InstrumentType,
  money,
  Order,
  OrderStatus,
  OrderSide,
  Snapshot,
} from './model';

export function buildPortfolio(snapshot: Snapshot) {
  const balance = availability(snapshot.orders);
  const positions = [];
  for (const instrument of snapshot.instruments) {
    if (instrument.type === InstrumentType.MONEDA) continue;

    const position = buildPosition(instrument, snapshot);
    if (position) positions.push(position);
  }

  const positionsValue = positions.reduce(
    (total, position) => total.plus(position.marketValue),
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

function buildPosition(instrument: Instrument, snapshot: Snapshot) {
  const { quantity, costBasis } = calculateHolding(instrument.id, snapshot.orders);
  if (quantity === 0) return null;

  const quote = snapshot.quotes.find((quote) => quote.instrumentId === instrument.id);
  if (!quote) throw new BusinessError('PRICE_UNAVAILABLE', `No quote for ${instrument.ticker}`);

  const marketValue = new Decimal(quote.close).mul(quantity);
  const availableQuantity = availability(snapshot.orders, instrument.id).availableShares;

  return {
    instrumentId: instrument.id,
    ticker: instrument.ticker,
    name: instrument.name,
    quantity,
    availableQuantity,
    marketPrice: money(quote.close),
    marketValue: money(marketValue),
    costBasis: quantity > 0 ? money(costBasis) : null,
    returnPercent: quantity > 0 ? calculateReturnPercent(marketValue, costBasis) : null,
    dailyReturnPercent: calculateReturnPercent(quote.close, quote.previousClose),
    quoteDate: quote.date,
  };
}

function calculateHolding(instrumentId: number, orders: Order[]) {
  const filledOrders = orders
    .filter(
      (order) =>
        order.instrumentId === instrumentId &&
        order.status === OrderStatus.FILLED &&
        (order.side === OrderSide.BUY || order.side === OrderSide.SELL),
    )
    .sort((first, second) => first.datetime.localeCompare(second.datetime) || first.id - second.id);

  let quantity = 0;
  let costBasis = new Decimal(0);

  for (const order of filledOrders) {
    if (order.side === OrderSide.BUY) {
      quantity += order.size;
      costBasis = costBasis.plus(new Decimal(order.price).mul(order.size));
    } else {
      const averageCost = quantity > 0 ? costBasis.div(quantity) : new Decimal(0);
      quantity -= order.size;
      costBasis = costBasis.minus(averageCost.mul(order.size));
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
