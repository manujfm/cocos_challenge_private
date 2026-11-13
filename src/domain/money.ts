import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

/** Formats an amount in pesos with two decimals, as returned by the API. */
export const money = (value: Decimal.Value) => new Decimal(value).toFixed(2);
