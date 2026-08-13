/**
 * Walk-forward splitting.
 *
 * Optimising weights and then reporting performance on the same data is the
 * single easiest way to convince yourself of an edge that does not exist. This
 * module makes the split explicit and chronological: train on the earlier
 * portion, evaluate on the later, never the reverse and never at random.
 *
 * Random splits leak: a candidate from March and one from April share market
 * conditions, so scattering them across train and test lets the fitted weights
 * see the regime they will be tested in.
 */

export interface SplitOptions {
  /** Fraction of the timeline used for training. */
  trainFraction?: number;
  /** Minimum rows required on each side for the split to be usable. */
  minPerSide?: number;
}

export interface Split<T> {
  train: T[];
  test: T[];
  /** Timestamp at which the split was made. */
  boundary: string | null;
  usable: boolean;
  reason: string | null;
}

/**
 * Chronological split. Rows must carry a timestamp; they are sorted before
 * splitting so caller ordering cannot silently corrupt the boundary.
 */
export function chronologicalSplit<T extends { ts: string }>(
  rows: readonly T[],
  opts: SplitOptions = {},
): Split<T> {
  const trainFraction = opts.trainFraction ?? 0.6;
  const minPerSide = opts.minPerSide ?? 30;

  const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  const cut = Math.floor(sorted.length * trainFraction);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);

  if (train.length < minPerSide || test.length < minPerSide) {
    return {
      train, test,
      boundary: sorted[cut]?.ts ?? null,
      usable: false,
      reason:
        `split gives ${train.length} train and ${test.length} test rows; ` +
        `at least ${minPerSide} on each side is required before an out-of-sample ` +
        'result means anything',
    };
  }

  return {
    train, test,
    boundary: sorted[cut]?.ts ?? null,
    usable: true,
    reason: null,
  };
}

export interface FoldOptions {
  folds?: number;
  minTrain?: number;
  minTest?: number;
}

export interface Fold<T> {
  index: number;
  train: T[];
  test: T[];
  boundary: string;
}

/**
 * Expanding-window folds: each fold trains on everything before its test
 * window. This mirrors how the system would actually have been used — you can
 * only ever fit on the past.
 */
export function expandingFolds<T extends { ts: string }>(
  rows: readonly T[],
  opts: FoldOptions = {},
): Fold<T>[] {
  const folds = opts.folds ?? 3;
  const minTrain = opts.minTrain ?? 30;
  const minTest = opts.minTest ?? 10;

  const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  if (sorted.length < minTrain + minTest) return [];

  const out: Fold<T>[] = [];
  const testSize = Math.floor((sorted.length - minTrain) / folds);
  if (testSize < minTest) return [];

  for (let i = 0; i < folds; i++) {
    const trainEnd = minTrain + i * testSize;
    const testEnd = Math.min(sorted.length, trainEnd + testSize);
    if (testEnd - trainEnd < minTest) break;

    out.push({
      index: i,
      train: sorted.slice(0, trainEnd),
      test: sorted.slice(trainEnd, testEnd),
      boundary: sorted[trainEnd]!.ts,
    });
  }
  return out;
}

export interface OverfittingWarning {
  parametersTuned: number;
  observations: number;
  observationsPerParameter: number;
  severity: 'OK' | 'MARGINAL' | 'SEVERE';
  message: string;
}

/**
 * Flags the ratio of tuned parameters to observations.
 *
 * Every weight adjusted is a degree of freedom. With more knobs than data the
 * fit describes the noise, and it will look excellent right up until it is used.
 */
export function assessOverfittingRisk(
  parametersTuned: number,
  observations: number,
): OverfittingWarning {
  const ratio = parametersTuned > 0 ? observations / parametersTuned : Infinity;

  let severity: OverfittingWarning['severity'];
  let message: string;

  if (ratio >= 50) {
    severity = 'OK';
    message = `${ratio.toFixed(0)} observations per tuned parameter — a reasonable ratio.`;
  } else if (ratio >= 20) {
    severity = 'MARGINAL';
    message =
      `${ratio.toFixed(0)} observations per tuned parameter. Thin. Treat any ` +
      'improvement as provisional until the sample grows.';
  } else {
    severity = 'SEVERE';
    message =
      `Only ${ratio.toFixed(1)} observations per tuned parameter. At this ratio the ` +
      'weights are fitting noise, and in-sample performance carries no information ' +
      'about future performance.';
  }

  return {
    parametersTuned,
    observations,
    observationsPerParameter: ratio,
    severity,
    message,
  };
}
