import { BusinessError, OrderStatus, PlaceOrder } from '../domain/model';
import { evaluateOrder } from '../domain/order-evaluation';
import { buildPortfolio } from '../domain/portfolio';
import { createOrderFingerprint } from './order-fingerprint';
import { TradingSession, TradingStore } from './ports';

export class TradingService {
  constructor(private readonly store: TradingStore) {}

  /**
   * Creates an order. With an idempotency key, a retried request returns the original order
   * instead of creating a duplicate; reusing the key with a different body is a conflict.
   */
  place(userId: number, input: PlaceOrder, idempotencyKey?: string) {
    return this.store.withUserTransaction(userId, async (session) => {
      if (!idempotencyKey) return this.createOrder(session, input);

      const fingerprint = createOrderFingerprint(input);
      const existing = await session.findRequest(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new BusinessError(
            'IDEMPOTENCY_CONFLICT',
            'Key already used with a different request',
            409,
          );
        return existing.response;
      }

      const order = await this.createOrder(session, input);
      await session.saveRequest(idempotencyKey, fingerprint, order);
      return order;
    });
  }

  portfolio(userId: number) {
    return this.store.readUser(userId, async (s) => buildPortfolio(await s.snapshot()));
  }

  getOrder(userId: number, orderId: number) {
    return this.store.readUser(userId, async (s) => {
      const order = await s.getOrder(orderId);
      if (!order) throw new BusinessError('ORDER_NOT_FOUND', 'Order not found', 404);
      return order;
    });
  }

  cancel(userId: number, orderId: number) {
    return this.store.withUserTransaction(userId, async (s) => {
      const order = await s.getOrder(orderId);
      if (!order) throw new BusinessError('ORDER_NOT_FOUND', 'Order not found', 404);
      if (order.status === OrderStatus.CANCELLED) return order;
      if (order.status !== OrderStatus.NEW)
        throw new BusinessError('ORDER_NOT_CANCELLABLE', 'Only NEW orders can be cancelled', 409);
      return s.cancelOrder(orderId);
    });
  }

  search(query: string, limit: number, offset: number) {
    return this.store.search(query, limit, offset);
  }

  private async createOrder(session: TradingSession, input: PlaceOrder) {
    return session.insertOrder(evaluateOrder(input, await session.snapshot()));
  }
}
