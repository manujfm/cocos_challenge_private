import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { TradingService } from '../../application/trading.service';
import { orderSchema, searchSchema } from './validation';
@Controller()
export class TradingController {
  constructor(@Inject(TradingService) private readonly trading: TradingService) {}

  @Get('users/:userId/portfolio')
  portfolio(@Param('userId', ParseIntPipe) userId: number) {
    return this.trading.portfolio(userId);
  }

  @Get('instruments')
  search(@Query() query: unknown) {
    const { q, limit, offset } = searchSchema.parse(query);
    return this.trading.search(q, limit, offset);
  }

  @Post('users/:userId/orders')
  place(
    @Param('userId', ParseIntPipe) userId: number,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || key.length > 128) {
      throw new BadRequestException(
        'Idempotency-Key is required and must not exceed 128 characters',
      );
    }
    return this.trading.place(userId, key, orderSchema.parse(body));
  }

  @Get('users/:userId/orders/:orderId')
  order(
    @Param('userId', ParseIntPipe) userId: number,
    @Param('orderId', ParseIntPipe) orderId: number,
  ) {
    return this.trading.getOrder(userId, orderId);
  }

  @Patch('users/:userId/orders/:orderId/cancel')
  cancel(
    @Param('userId', ParseIntPipe) userId: number,
    @Param('orderId', ParseIntPipe) orderId: number,
  ) {
    return this.trading.cancel(userId, orderId);
  }
}
