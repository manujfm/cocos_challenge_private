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

export type RejectionReason = 'INSUFFICIENT_FUNDS' | 'INSUFFICIENT_SHARES';

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

export type NewOrder = Omit<Order, 'id' | 'userId' | 'datetime'>;

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

export enum ErrorCode {
  INSTRUMENT_NOT_FOUND = 'INSTRUMENT_NOT_FOUND',
  INVALID_INSTRUMENT = 'INVALID_INSTRUMENT',
  PRICE_UNAVAILABLE = 'PRICE_UNAVAILABLE',
  INVALID_SIZE = 'INVALID_SIZE',
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  ORDER_NOT_CANCELLABLE = 'ORDER_NOT_CANCELLABLE',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_REQUEST = 'INVALID_REQUEST',
  TEMPORARILY_UNAVAILABLE = 'TEMPORARILY_UNAVAILABLE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export class BusinessError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = 422,
  ) {
    super(message);
  }
}
