/**
 * Explainability primitives.
 *
 * Every point added or deducted anywhere in the system is emitted as an
 * Explanation carrying the raw observed value, the threshold it was compared
 * against, and a human sentence. Scores are never produced by arithmetic that
 * leaves no trace — if a number cannot explain itself, it does not ship.
 */

export type Dimension = 'EVENT' | 'TRADE' | 'GATE' | 'PRICED_IN';
export type Direction = 'ADD' | 'DEDUCT' | 'NEUTRAL' | 'VETO';
export type Comparator = '>' | '<' | '>=' | '<=' | '==' | 'in' | 'range' | 'n/a';

export interface Explanation {
  dimension: Dimension;
  bucket: string;
  feature: string;
  rawValue: number | string | boolean | null;
  comparator: Comparator;
  threshold: number | string;
  pointsAwarded: number;
  pointsMax: number;
  direction: Direction;
  rationale: string;
  sourceRef: string;
  confidence: number;
}

export interface ExplainInput {
  bucket: string;
  feature: string;
  rawValue: number | string | boolean | null;
  comparator?: Comparator;
  threshold?: number | string;
  points: number;
  pointsMax?: number;
  rationale: string;
  sourceRef: string;
  confidence?: number;
}

/**
 * Accumulates explanations for one dimension and totals the points, so the
 * total and its justification cannot drift apart.
 */
export class Explainer {
  readonly #dimension: Dimension;
  readonly #entries: Explanation[] = [];

  constructor(dimension: Dimension) {
    this.#dimension = dimension;
  }

  add(input: ExplainInput): number {
    const direction: Direction =
      input.points > 0 ? 'ADD' : input.points < 0 ? 'DEDUCT' : 'NEUTRAL';
    this.#entries.push({
      dimension: this.#dimension,
      bucket: input.bucket,
      feature: input.feature,
      rawValue: input.rawValue,
      comparator: input.comparator ?? 'n/a',
      threshold: input.threshold ?? '',
      pointsAwarded: input.points,
      pointsMax: input.pointsMax ?? 0,
      direction,
      rationale: input.rationale,
      sourceRef: input.sourceRef,
      confidence: input.confidence ?? 1,
    });
    return input.points;
  }

  /** Records a veto. Vetoes carry no points; they end the decision. */
  veto(input: Omit<ExplainInput, 'points' | 'pointsMax'>): void {
    this.#entries.push({
      dimension: this.#dimension,
      bucket: input.bucket,
      feature: input.feature,
      rawValue: input.rawValue,
      comparator: input.comparator ?? 'n/a',
      threshold: input.threshold ?? '',
      pointsAwarded: 0,
      pointsMax: 0,
      direction: 'VETO',
      rationale: input.rationale,
      sourceRef: input.sourceRef,
      confidence: input.confidence ?? 1,
    });
  }

  /**
   * Records that a feature was unavailable. Missing data is explicit, so a
   * bucket scoring low because it had nothing to work with is distinguishable
   * from one scoring low on the evidence.
   */
  missing(bucket: string, feature: string, rationale: string, sourceRef: string): void {
    this.#entries.push({
      dimension: this.#dimension,
      bucket,
      feature,
      rawValue: null,
      comparator: 'n/a',
      threshold: '',
      pointsAwarded: 0,
      pointsMax: 0,
      direction: 'NEUTRAL',
      rationale,
      sourceRef,
      confidence: 0,
    });
  }

  entries(): Explanation[] {
    return [...this.#entries];
  }

  bucketTotal(bucket: string): number {
    return this.#entries
      .filter((e) => e.bucket === bucket)
      .reduce((sum, e) => sum + e.pointsAwarded, 0);
  }

  total(): number {
    return this.#entries.reduce((sum, e) => sum + e.pointsAwarded, 0);
  }

  /** Fraction of scored features that had data. Drives the confidence figure. */
  confidence(): number {
    const scored = this.#entries.filter((e) => e.direction !== 'VETO');
    if (scored.length === 0) return 0;
    return scored.reduce((sum, e) => sum + e.confidence, 0) / scored.length;
  }

  hasVeto(): boolean {
    return this.#entries.some((e) => e.direction === 'VETO');
  }
}

/**
 * Renders explanations as aligned text for the CLI and alerts.
 *
 * The dimension is shown because the same feature legitimately appears in more
 * than one dimension — the priced-in engine records its own verdict, and the
 * trade-quality scorer records applying that verdict as a penalty. Without the
 * label those read as one deduction counted twice.
 */
export function renderExplanations(entries: readonly Explanation[]): string[] {
  return entries.map((e) => {
    const sign = e.direction === 'VETO' ? 'VETO' : e.pointsAwarded >= 0 ? '+' : '';
    const points =
      e.direction === 'VETO'
        ? 'VETO '
        : `${sign}${e.pointsAwarded.toFixed(0)}${e.pointsMax > 0 ? `/${e.pointsMax}` : ''}`;
    const value = e.rawValue === null ? 'n/a' : String(e.rawValue);
    const test = e.comparator === 'n/a' ? '' : ` ${e.comparator} ${e.threshold}`;
    return `  [${e.dimension.padEnd(10)}] ${points.padEnd(8)} ${e.feature} = ${value}${test}  ${e.rationale}`;
  });
}
