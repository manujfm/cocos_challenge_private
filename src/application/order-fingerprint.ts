import { createHash } from 'node:crypto';
import { PlaceOrder } from '../domain/model';

// Compare order contents when an Idempotency-Key is reused.
export function createOrderFingerprint(input: PlaceOrder): string {
  const orderData = {
    instrumentId: input.instrumentId,
    side: input.side,
    type: input.type,
    size: input.size ?? null,
    amount: input.amount ?? null,
    price: input.price ?? null,
  };

  return createHash('sha256').update(JSON.stringify(orderData)).digest('hex');
}
