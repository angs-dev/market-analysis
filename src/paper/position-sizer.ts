/**
 * Trade plan construction for the Rs 10,000 paper account.
 *
 * Stops and targets come from structure and ATR, never from a fixed percentage.
 * A stop placed at an arbitrary distance is not a risk limit — it is a random
 * exit, and at a 0.67% distance it sits inside the noise of most Nifty 500
 * names. Where structure cannot support a plan, none is produced and the trade
 * simply does not qualify.
 */

import { estimateCost, roundTripCost, type CostConfig, DEFAULT_COSTS } from './cost-model.ts';

export interface PlanInput {
  symbol: string;
  entryPrice: number;
  /** Nearest structural support below the entry. */
  support: number | null;
  /** Nearest resistance above, which caps a realistic target. */
  resistance: number | null;
  atr: number | null;
  /** Recent swing low, preferred stop anchor when available. */
  swingLow?: number | null;
  capital?: number;
  costs?: CostConfig;
  /** Minimum acceptable reward-to-risk. */
  minRiskReward?: number;
  /** Cap on stop distance as a percentage, to avoid absurd risk per share. */
  maxStopPct?: number;
}

export type StopBasis = 'SWING_LOW' | 'SUPPORT' | 'ATR' | 'NONE';
export type TargetBasis = 'RESISTANCE' | 'ATR_MULTIPLE' | 'NONE';

export interface TradePlan {
  symbol: string;
  entryPrice: number;
  quantity: number;
  capitalUsed: number;
  stopLoss: number;
  target: number;
  riskPerShare: number;
  maxLoss: number;
  expectedProfit: number;
  riskReward: number;
  estimatedCosts: number;
  expectedProfitNet: number;
  stopBasis: StopBasis;
  targetBasis: TargetBasis;
  /** Percentage move required simply to cover costs. */
  breakevenPct: number;
}

export interface PlanFailure {
  ok: false;
  reason: string;
}

export type PlanResult = ({ ok: true } & TradePlan) | PlanFailure;

export const DEFAULT_CAPITAL = 10_000;

/**
 * Chooses a stop.
 *
 * Preference order is swing low, then support, then an ATR-derived level.
 * Structure is preferred because a stop below a level the market has actually
 * defended has a reason to be there; an ATR stop is only a fallback.
 */
export function chooseStop(input: PlanInput): { price: number; basis: StopBasis } | null {
  const { entryPrice, atr } = input;
  const buffer = atr !== null ? atr * 0.25 : entryPrice * 0.002;
  const maxStopPct = input.maxStopPct ?? 8;
  const floor = entryPrice * (1 - maxStopPct / 100);

  // Ordered by preference, not by distance. A tighter ATR stop is not a better
  // stop: it sits at a price nobody defended, so it gets hit by noise. A stop
  // below a level the market has actually turned at has a reason to be there.
  const candidates: { price: number; basis: StopBasis }[] = [];
  if (input.swingLow != null && input.swingLow < entryPrice) {
    candidates.push({ price: input.swingLow - buffer, basis: 'SWING_LOW' });
  }
  if (input.support != null && input.support < entryPrice) {
    candidates.push({ price: input.support - buffer, basis: 'SUPPORT' });
  }
  if (atr != null && atr > 0) {
    candidates.push({ price: entryPrice - atr * 1.5, basis: 'ATR' });
  }

  const valid = candidates.filter((c) => c.price > 0 && c.price < entryPrice && c.price >= floor);
  return valid[0] ?? null;
}

/**
 * Chooses a target.
 *
 * Capped just below resistance — expecting price to sail through a level it has
 * previously turned at is how a 2:1 plan becomes a 0.5:1 outcome.
 */
export function chooseTarget(
  input: PlanInput,
  riskPerShare: number,
): { price: number; basis: TargetBasis } | null {
  const { entryPrice, resistance, atr } = input;

  if (resistance != null && resistance > entryPrice) {
    const buffer = atr !== null ? atr * 0.2 : entryPrice * 0.002;
    const capped = resistance - buffer;
    if (capped > entryPrice) return { price: capped, basis: 'RESISTANCE' };
  }
  if (atr != null && atr > 0) {
    return { price: entryPrice + Math.max(atr * 2, riskPerShare * 2), basis: 'ATR_MULTIPLE' };
  }
  return null;
}

export function buildPlan(input: PlanInput): PlanResult {
  const capital = input.capital ?? DEFAULT_CAPITAL;
  const costs = input.costs ?? DEFAULT_COSTS;
  const minRR = input.minRiskReward ?? 1.5;
  const { entryPrice } = input;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { ok: false, reason: 'entry price is not a positive number' };
  }
  if (entryPrice > capital) {
    return {
      ok: false,
      reason: `one share costs ${entryPrice.toFixed(2)}, above the ${capital} capital — not sizeable`,
    };
  }

  const stop = chooseStop(input);
  if (stop === null) {
    return {
      ok: false,
      reason: 'no structural stop available — neither swing low, support nor ATR could place one',
    };
  }

  const riskPerShare = entryPrice - stop.price;
  if (riskPerShare <= 0) return { ok: false, reason: 'stop is not below the entry' };

  const target = chooseTarget(input, riskPerShare);
  if (target === null) {
    return { ok: false, reason: 'no target could be derived from resistance or ATR' };
  }

  const rewardPerShare = target.price - entryPrice;
  if (rewardPerShare <= 0) {
    return { ok: false, reason: 'the nearest resistance sits at or below the entry' };
  }

  const quantity = Math.floor(capital / entryPrice);
  if (quantity < 1) return { ok: false, reason: 'capital does not cover a single share' };

  const capitalUsed = quantity * entryPrice;
  const maxLoss = riskPerShare * quantity;
  const grossProfit = rewardPerShare * quantity;

  const costAtTarget = roundTripCost(entryPrice, target.price, quantity, costs);
  const expectedProfitNet = grossProfit - costAtTarget.total;

  // Risk/reward is computed gross so it stays comparable across position sizes;
  // the net figure is reported alongside so cost drag stays visible.
  const riskReward = rewardPerShare / riskPerShare;

  const plan: TradePlan = {
    symbol: input.symbol,
    entryPrice,
    quantity,
    capitalUsed,
    stopLoss: stop.price,
    target: target.price,
    riskPerShare,
    maxLoss,
    expectedProfit: grossProfit,
    riskReward,
    estimatedCosts: costAtTarget.total,
    expectedProfitNet,
    stopBasis: stop.basis,
    targetBasis: target.basis,
    breakevenPct: estimateCost(entryPrice, quantity, costs).breakevenPct,
  };

  if (riskReward < minRR) {
    return {
      ok: false,
      reason:
        `risk/reward ${riskReward.toFixed(2)} is below the ${minRR} minimum ` +
        `(stop ${stop.basis}, target ${target.basis})`,
    };
  }

  return { ok: true, ...plan };
}
