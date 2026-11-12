import { z } from 'zod';
import Decimal from 'decimal.js';
import { OrderSide } from '../../domain/model';
const monetary = z
  .union([
    z.string().regex(/^\d{1,16}(\.\d{1,2})?$/),
    z
      .number()
      .finite()
      .positive()
      .max(99999999.99)
      .refine((n) => new Decimal(n).decimalPlaces() <= 2),
  ])
  .transform((v) => new Decimal(v).toFixed(2))
  .refine(
    (v) => new Decimal(v).gt(0) && new Decimal(v).lte('99999999.99'),
    'Must be positive, at most 99999999.99, and have at most two decimals',
  );
export const orderSchema = z
  .object({
    instrumentId: z.number().int().positive().max(2147483647),
    side: z.enum([OrderSide.BUY, OrderSide.SELL]),
    type: z.enum(['MARKET', 'LIMIT']),
    size: z.number().int().positive().max(2147483647).optional(),
    amount: monetary.optional(),
    price: monetary.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.size === undefined) === (value.amount === undefined))
      ctx.addIssue({ code: 'custom', message: 'Provide exactly one of size or amount' });
    if (value.type === 'LIMIT' && value.price === undefined)
      ctx.addIssue({ code: 'custom', message: 'LIMIT requires price' });
    if (value.type === 'MARKET' && value.price !== undefined)
      ctx.addIssue({ code: 'custom', message: 'MARKET does not accept price' });
  });
export const searchSchema = z
  .object({
    q: z.string().trim().min(1).max(100),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
  })
  .strict();
