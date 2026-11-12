import { BusinessError, evaluateOrder, PlaceOrder, OrderStatus } from '../domain/model';
import { buildPortfolio } from '../domain/portfolio';
import { createOrderFingerprint } from './order-fingerprint';
import { TradingStore } from './ports';
export class TradingService {
  constructor(private readonly store: TradingStore) {}

  place(userId: number, key: string, input: PlaceOrder) {
    const fingerprint = createOrderFingerprint(input);
    return this.store.withUserTransaction(userId, async (session) => {
      const existing = await session.findRequest(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new BusinessError(
            'IDEMPOTENCY_CONFLICT',
            'Key already used with a different request',
            409,
          );
        return existing.response;
      }
      const order = await session.insertOrder(evaluateOrder(input, await session.snapshot()));
      await session.saveRequest(key, fingerprint, order);
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
}
