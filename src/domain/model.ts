import Decimal from 'decimal.js';
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const money = (value: Decimal.Value) => new Decimal(value).toFixed(2);

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
  CASH_IN = 'CASH_IN',
  CASH_OUT = 'CASH_OUT',
}

export type OrderType = 'MARKET' | 'LIMIT';
export enum OrderStatus {
  NEW = 'NEW',
  FILLED = 'FILLED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export enum InstrumentType {
  ACCIONES = 'ACCIONES',
  MONEDA = 'MONEDA',
}

export interface Order {
  id: number;
  userId: number;
  instrumentId: number;
  size: number;
  price: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  datetime: string;
  rejectionReason?: string | null;
}


export interface Instrument {
  id: number;
  ticker: string;
  name: string;
  type: InstrumentType;
}
export interface Quote {
  instrumentId: number;
  close: string;
  previousClose: string | null;
  date: string;
}
export interface Snapshot {
  orders: Order[];
  instruments: Instrument[];
  quotes: Quote[];
}
export interface PlaceOrder {
  instrumentId: number;
  side: OrderSide.BUY | OrderSide.SELL;
  type: OrderType;
  size?: number;
  amount?: string;
  price?: string;
}
export class BusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 422,
  ) {
    super(message);
  }
}
export function availability(orders: Order[], instrumentId?: number) {
  let cash = new Decimal(0),
    reservedCash = new Decimal(0),
    shares = 0,
    reservedShares = 0;
  for (const o of orders) {
    const total = new Decimal(o.price).mul(o.size);
    if (o.status === OrderStatus.FILLED) {
      if (o.side === OrderSide.CASH_IN) cash = cash.plus(o.size);
      if (o.side === OrderSide.CASH_OUT) cash = cash.minus(o.size);
      if (o.side === OrderSide.BUY) cash = cash.minus(total);
      if (o.side === OrderSide.SELL) cash = cash.plus(total);
      if (o.instrumentId === instrumentId && o.side === OrderSide.BUY) shares += o.size;
      if (o.instrumentId === instrumentId && o.side === OrderSide.SELL) shares -= o.size;
    }
    if (o.status === OrderStatus.NEW) {
      if (o.side === OrderSide.BUY) reservedCash = reservedCash.plus(total);
      if (o.instrumentId === instrumentId && o.side === OrderSide.SELL) reservedShares += o.size;
    }
  }
  return {
    cash,
    reservedCash,
    availableCash: cash.minus(reservedCash),
    shares,
    availableShares: shares - reservedShares,
  };
}
export function evaluateOrder(
  input: PlaceOrder,
  snapshot: Snapshot,
): Omit<Order, 'id' | 'userId' | 'datetime'> {
  const instrument = snapshot.instruments.find((i) => i.id === input.instrumentId);
  if (!instrument) throw new BusinessError('INSTRUMENT_NOT_FOUND', 'Instrument not found', 404);
  if (instrument.type === InstrumentType.MONEDA)
    throw new BusinessError('INVALID_INSTRUMENT', 'Cash instruments cannot be traded');
  const quote = snapshot.quotes.find((q) => q.instrumentId === input.instrumentId);
  const rawPrice = input.type === 'LIMIT' ? input.price : quote?.close;
  if (!rawPrice || !new Decimal(rawPrice).isPositive())
    throw new BusinessError('PRICE_UNAVAILABLE', 'No valid price available');
  const price = money(rawPrice);
  const quantity = input.size ?? new Decimal(input.amount!).div(price).floor().toNumber();
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647)
    throw new BusinessError(
      'INVALID_SIZE',
      'Amount must buy at least one share; maximum size is 2147483647',
    );
  const balance = availability(snapshot.orders, input.instrumentId);
  const rejected =
    input.side === OrderSide.BUY
      ? balance.availableCash.lt(new Decimal(price).mul(quantity))
      : balance.availableShares < quantity;
  return {
    instrumentId: input.instrumentId,
    side: input.side,
    type: input.type,
    size: quantity,
    price,
    status: rejected
      ? OrderStatus.REJECTED
      : input.type === 'MARKET'
        ? OrderStatus.FILLED
        : OrderStatus.NEW,
    rejectionReason: rejected
      ? input.side === OrderSide.BUY
        ? 'INSUFFICIENT_FUNDS'
        : 'INSUFFICIENT_SHARES'
      : null,
  };
}
