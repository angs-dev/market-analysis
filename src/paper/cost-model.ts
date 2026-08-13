/**
 * Transaction cost model.
 *
 * Against Rs 10,000 of capital a round trip is a material fraction of a small
 * gross target, so every expectancy figure in this system is net of modelled
 * cost. Evaluating on gross P&L at this size would make a real edge look
 * profitable when it is not.
 *
 * Rates are configuration, not constants — they change with regulation and
 * with broker. Verify against a current contract note before trusting the
 * absolute numbers.
 */

export interface CostConfig {
  /** Flat per-order brokerage, whichever is lower with the percentage. */
  brokerageFlat: number;
  brokeragePct: number;
  /** Securities transaction tax, on the sell side for delivery. */
  sttPct: number;
  /** Exchange transaction charge, both sides. */
  exchangeTxnPct: number;
  sebiChargesPct: number;
  /** Stamp duty, buy side only. */
  stampDutyPct: number;
  /** GST on brokerage plus exchange charges. */
  gstPct: number;
  /** Depository participant charge, per sell scrip. */
  dpCharge: number;
  segment: 'DELIVERY' | 'INTRADAY';
}

/**
 * Discount-broker delivery defaults, as of the last verification.
 * ⚠️ Verify against a current contract note before relying on absolute values.
 */
export const DEFAULT_COSTS: CostConfig = {
  brokerageFlat: 20,
  brokeragePct: 0.05,
  sttPct: 0.1,
  exchangeTxnPct: 0.00297,
  sebiChargesPct: 0.0001,
  stampDutyPct: 0.015,
  gstPct: 18,
  dpCharge: 15.93,
  segment: 'DELIVERY',
};

export interface CostBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebiCharges: number;
  stampDuty: number;
  gst: number;
  dpCharge: number;
  total: number;
  /** Total as a percentage of the buy-side turnover. */
  totalPct: number;
  /** Percentage move needed just to break even. */
  breakevenPct: number;
}

function brokerageFor(turnover: number, config: CostConfig): number {
  // Delivery at many discount brokers is free; a flat fee applies to intraday.
  if (config.segment === 'DELIVERY') return 0;
  return Math.min(config.brokerageFlat, (turnover * config.brokeragePct) / 100);
}

/** Full round-trip cost for a position. */
export function roundTripCost(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  config: CostConfig = DEFAULT_COSTS,
): CostBreakdown {
  const buyTurnover = entryPrice * quantity;
  const sellTurnover = exitPrice * quantity;
  const totalTurnover = buyTurnover + sellTurnover;

  const brokerage = brokerageFor(buyTurnover, config) + brokerageFor(sellTurnover, config);
  // STT applies to both legs for intraday-style trades, sell side for delivery.
  const stt =
    config.segment === 'DELIVERY'
      ? (sellTurnover * config.sttPct) / 100
      : (totalTurnover * config.sttPct) / 100;
  const exchangeTxn = (totalTurnover * config.exchangeTxnPct) / 100;
  const sebiCharges = (totalTurnover * config.sebiChargesPct) / 100;
  const stampDuty = (buyTurnover * config.stampDutyPct) / 100;
  const gst = ((brokerage + exchangeTxn + sebiCharges) * config.gstPct) / 100;
  const dpCharge = config.segment === 'DELIVERY' ? config.dpCharge : 0;

  const total = brokerage + stt + exchangeTxn + sebiCharges + stampDuty + gst + dpCharge;

  return {
    brokerage, stt, exchangeTxn, sebiCharges, stampDuty, gst, dpCharge,
    total,
    totalPct: buyTurnover > 0 ? (total / buyTurnover) * 100 : 0,
    breakevenPct: buyTurnover > 0 ? (total / buyTurnover) * 100 : 0,
  };
}

/** Cost estimate before an exit price is known, assuming a flat exit. */
export function estimateCost(
  entryPrice: number,
  quantity: number,
  config: CostConfig = DEFAULT_COSTS,
): CostBreakdown {
  return roundTripCost(entryPrice, entryPrice, quantity, config);
}
