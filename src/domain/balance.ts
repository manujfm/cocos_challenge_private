import { Decimal } from './money';
import { Order, OrderSide, OrderStatus } from './model';

const orderTotal = (order: Order) => new Decimal(order.price).mul(order.size);

/** Cash comes from FILLED movements; NEW buys reserve cash until they are cancelled. */
export function cashBalance(orders: Order[]) {
  let cash = new Decimal(0);
  let reservedCash = new Decimal(0);

  for (const order of orders) {
    if (order.status === OrderStatus.FILLED) cash = cash.plus(cashEffect(order));
    if (order.status === OrderStatus.NEW && order.side === OrderSide.BUY)
      reservedCash = reservedCash.plus(orderTotal(order));
  }

  return { cash, reservedCash, availableCash: cash.minus(reservedCash) };
}

/** Transfers move `size` pesos; trades move `size * price`. */
function cashEffect(order: Order): Decimal {
  switch (order.side) {
    case OrderSide.CASH_IN:
      return new Decimal(order.size);
    case OrderSide.CASH_OUT:
      return new Decimal(order.size).neg();
    case OrderSide.BUY:
      return orderTotal(order).neg();
    case OrderSide.SELL:
      return orderTotal(order);
    default:
      return new Decimal(0);
  }
}

/** Shares come from FILLED trades; NEW sells reserve shares until they are cancelled. */
export function shareBalance(orders: Order[], instrumentId: number) {
  let shares = 0;
  let reservedShares = 0;

  for (const order of orders) {
    if (order.instrumentId !== instrumentId) continue;
    if (order.status === OrderStatus.FILLED && order.side === OrderSide.BUY) shares += order.size;
    if (order.status === OrderStatus.FILLED && order.side === OrderSide.SELL) shares -= order.size;
    if (order.status === OrderStatus.NEW && order.side === OrderSide.SELL)
      reservedShares += order.size;
  }

  return { shares, reservedShares, availableShares: shares - reservedShares };
}
