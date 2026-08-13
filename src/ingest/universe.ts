/**
 * Universe loader.
 *
 * Builds the tradeable universe and applies the liquidity filter. Instruments
 * that fail the filter are kept in the table with an explicit exclusion_reason
 * rather than dropped — a symbol vanishing without explanation is the kind of
 * thing that costs an hour to debug six months from now.
 */

import type { Db } from '../db/driver.ts';
import type { Candle, InstrumentRef } from '../market/types.ts';

export interface LiquidityConfig {
  /** Minimum 20-day average daily turnover in rupees. */
  minAvgTurnover20d: number;
  /** Minimum number of daily bars required to judge liquidity at all. */
  minHistoryBars: number;
  /** Minimum close price; sub-rupee scrips have unusable tick dynamics. */
  minPrice: number;
}

export const DEFAULT_LIQUIDITY: LiquidityConfig = {
  minAvgTurnover20d: 50_000_000, // Rs 5 crore/day
  minHistoryBars: 20,
  minPrice: 20,
};

export interface UniverseStats {
  total: number;
  tradeable: number;
  excluded: number;
  byReason: Record<string, number>;
}

/**
 * 20-day average turnover, using close x volume as the proxy for traded value.
 * Returns null when there is not enough history to judge.
 */
export function avgTurnover20d(candles: readonly Candle[], bars = 20): number | null {
  if (candles.length < bars) return null;
  const recent = candles.slice(-bars);
  let sum = 0;
  let counted = 0;
  for (const c of recent) {
    if (c.volume === null) continue;
    sum += c.close * c.volume;
    counted++;
  }
  return counted === 0 ? null : sum / counted;
}

export interface LiquidityVerdict {
  tradeable: boolean;
  reason?: string;
  avgTurnover: number | null;
}

export function assessLiquidity(
  candles: readonly Candle[],
  config: LiquidityConfig = DEFAULT_LIQUIDITY,
): LiquidityVerdict {
  if (candles.length < config.minHistoryBars) {
    return {
      tradeable: false,
      reason: `insufficient history: ${candles.length} bars, need ${config.minHistoryBars}`,
      avgTurnover: null,
    };
  }

  const lastClose = candles[candles.length - 1]!.close;
  if (lastClose < config.minPrice) {
    return {
      tradeable: false,
      reason: `price ${lastClose.toFixed(2)} below minimum ${config.minPrice}`,
      avgTurnover: avgTurnover20d(candles),
    };
  }

  const turnover = avgTurnover20d(candles);
  if (turnover === null) {
    return { tradeable: false, reason: 'no volume data available', avgTurnover: null };
  }
  if (turnover < config.minAvgTurnover20d) {
    return {
      tradeable: false,
      reason:
        `avg turnover ${(turnover / 1e7).toFixed(2)} cr below minimum ` +
        `${(config.minAvgTurnover20d / 1e7).toFixed(2)} cr`,
      avgTurnover: turnover,
    };
  }

  return { tradeable: true, avgTurnover: turnover };
}

export interface LoadUniverseInput {
  instruments: readonly InstrumentRef[];
  /** Daily candles per symbol, used for the liquidity assessment. */
  candlesBySymbol: ReadonlyMap<string, Candle[]>;
  config?: LiquidityConfig;
  /** Marks membership of the core universe. */
  inNifty500?: boolean;
}

export function loadUniverse(db: Db, input: LoadUniverseInput): UniverseStats {
  const config = input.config ?? DEFAULT_LIQUIDITY;
  const stats: UniverseStats = { total: 0, tradeable: 0, excluded: 0, byReason: {} };
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const ref of input.instruments) {
      const symbol = ref.symbol.toUpperCase();
      const candles = input.candlesBySymbol.get(symbol) ?? [];
      const verdict = assessLiquidity(candles, config);

      stats.total++;
      if (verdict.tradeable) {
        stats.tradeable++;
      } else {
        stats.excluded++;
        const key = verdict.reason?.split(':')[0]?.split(' below')[0] ?? 'unknown';
        stats.byReason[key] = (stats.byReason[key] ?? 0) + 1;
      }

      db.run(
        `INSERT INTO instruments
           (symbol, isin, bse_code, name, sector, sector_index, in_nifty500,
            avg_turnover_20d, is_tradeable, exclusion_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           isin = COALESCE(excluded.isin, instruments.isin),
           bse_code = COALESCE(excluded.bse_code, instruments.bse_code),
           name = COALESCE(excluded.name, instruments.name),
           sector = COALESCE(excluded.sector, instruments.sector),
           sector_index = COALESCE(excluded.sector_index, instruments.sector_index),
           in_nifty500 = excluded.in_nifty500,
           avg_turnover_20d = excluded.avg_turnover_20d,
           is_tradeable = excluded.is_tradeable,
           exclusion_reason = excluded.exclusion_reason,
           updated_at = excluded.updated_at`,
        symbol,
        ref.isin ?? null,
        ref.bseCode ?? null,
        ref.name ?? null,
        ref.sector ?? null,
        ref.sectorIndex ?? null,
        input.inNifty500 ? 1 : 0,
        verdict.avgTurnover,
        verdict.tradeable ? 1 : 0,
        verdict.reason ?? null,
        now,
      );
    }
  });

  return stats;
}

export function tradeableSymbols(db: Db): string[] {
  return db
    .all<{ symbol: string }>(
      'SELECT symbol FROM instruments WHERE is_tradeable = 1 ORDER BY symbol',
    )
    .map((r) => r.symbol);
}
