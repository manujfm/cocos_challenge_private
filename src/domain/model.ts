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

/** An order ready to be persisted; the database assigns id, owner and timestamp. */
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

export class BusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 422,
  ) {
    super(message);
  }
}
