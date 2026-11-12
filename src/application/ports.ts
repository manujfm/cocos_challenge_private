import { Instrument, Order, Snapshot } from '../domain/model';
export interface IdempotencyRecord {
  fingerprint: string;
  response: Order;
}
export interface TradingSession {
  snapshot(): Promise<Snapshot>;
  findRequest(key: string): Promise<IdempotencyRecord | undefined>;
  saveRequest(key: string, fingerprint: string, response: Order): Promise<void>;
  insertOrder(order: Omit<Order, 'id' | 'userId' | 'datetime'>): Promise<Order>;
  getOrder(id: number): Promise<Order | undefined>;
  cancelOrder(id: number): Promise<Order>;
}
export abstract class TradingStore {
  abstract readUser<T>(userId: number, work: (session: TradingSession) => Promise<T>): Promise<T>;
  abstract withUserTransaction<T>(
    userId: number,
    work: (session: TradingSession) => Promise<T>,
  ): Promise<T>;
  abstract search(query: string, limit: number, offset: number): Promise<Instrument[]>;
}
