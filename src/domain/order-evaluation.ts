import { cashBalance, shareBalance } from './balance';
import {
  BusinessError,
  Instrument,
  InstrumentType,
  NewOrder,
  Order,
  OrderSide,
  OrderStatus,
  PlaceOrder,
  Quote,
  RejectionReason,
  Snapshot,
} from './model';
import { Decimal, money } from './money';

/** orders.size is a PostgreSQL INT. */
const MAX_SIZE = 2147483647;

/**
 * Decides price, size and status of a new BUY or SELL order.
 * Malformed business input throws; lack of funds or shares produces a REJECTED order to persist.
 */
export function evaluateOrder(input: PlaceOrder, snapshot: Snapshot): NewOrder {
  const instrument = findTradableInstrument(input.instrumentId, snapshot.instruments);
  const price = resolvePrice(input, snapshot.quotes);
  const size = resolveSize(input, price);
  const rejectionReason = findRejectionReason(input, size, price, snapshot.orders);

  const order = { instrumentId: instrument.id, side: input.side, type: input.type, size, price };
  if (rejectionReason) return { ...order, status: OrderStatus.REJECTED, rejectionReason };

  const status = input.type === 'MARKET' ? OrderStatus.FILLED : OrderStatus.NEW;
  return { ...order, status, rejectionReason: null };
}

function findTradableInstrument(instrumentId: number, instruments: Instrument[]) {
  const instrument = instruments.find((i) => i.id === instrumentId);
  if (!instrument) throw new BusinessError('INSTRUMENT_NOT_FOUND', 'Instrument not found', 404);
  if (instrument.type === InstrumentType.MONEDA)
    throw new BusinessError('INVALID_INSTRUMENT', 'Cash instruments cannot be traded');
  return instrument;
}

/** MARKET executes at the latest close; LIMIT at the requested price. */
function resolvePrice(input: PlaceOrder, quotes: Quote[]): string {
  const rawPrice =
    input.type === 'LIMIT'
      ? input.price
      : quotes.find((q) => q.instrumentId === input.instrumentId)?.close;

  if (!rawPrice || !new Decimal(rawPrice).gt(0))
    throw new BusinessError('PRICE_UNAVAILABLE', 'No valid price available');
  return money(rawPrice);
}

/** Exact size, or the maximum whole number of shares the amount can pay for. */
function resolveSize(input: PlaceOrder, price: string): number {
  const size = input.size ?? new Decimal(input.amount!).div(price).floor().toNumber();

  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SIZE)
    throw new BusinessError(
      'INVALID_SIZE',
      `Amount must buy at least one share; maximum size is ${MAX_SIZE}`,
    );
  return size;
}

function findRejectionReason(
  input: PlaceOrder,
  size: number,
  price: string,
  orders: Order[],
): RejectionReason | null {
  if (input.side === OrderSide.BUY) {
    const { availableCash } = cashBalance(orders);
    return availableCash.lt(new Decimal(price).mul(size)) ? 'INSUFFICIENT_FUNDS' : null;
  }

  const { availableShares } = shareBalance(orders, input.instrumentId);
  return availableShares < size ? 'INSUFFICIENT_SHARES' : null;
}
