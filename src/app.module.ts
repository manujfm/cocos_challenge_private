import { Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Pool } from 'pg';
import { TradingStore } from './application/ports';
import { TradingService } from './application/trading.service';
import { PostgresTradingStore } from './infrastructure/postgres/trading.store';
import { createPool } from './infrastructure/postgres/pool';
import { TradingController } from './infrastructure/http/trading.controller';
import { ErrorFilter } from './infrastructure/http/error.filter';
export const PG_POOL = Symbol('PG_POOL');
@Module({
  controllers: [TradingController],
  providers: [
    { provide: PG_POOL, useFactory: createPool },
    {
      provide: TradingStore,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => new PostgresTradingStore(pool),
    },
    {
      provide: TradingService,
      inject: [TradingStore],
      useFactory: (store: TradingStore) => new TradingService(store),
    },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
