/**
 * XBRL element names for Indian quarterly results filings.
 *
 * ⚠️ UNVERIFIED AGAINST A REAL FILING. The development sandbox cannot reach
 * BSE or NSE, so these element names come from the Ind-AS taxonomy as
 * documented, not from a filing observed in the wild. Taxonomies also change
 * between versions and companies tag inconsistently.
 *
 * Every name is centralised here, and the parser matches on the *local* name
 * case-insensitively across all aliases, so reconciling against a real filing
 * is a single-file edit rather than a hunt through the parser.
 *
 * Aliases are ordered by preference — the first one found wins.
 */

export interface ElementAliases {
  revenue: string[];
  otherIncome: string[];
  totalIncome: string[];
  costOfMaterials: string[];
  employeeCost: string[];
  financeCosts: string[];
  depreciation: string[];
  otherExpenses: string[];
  totalExpenses: string[];
  profitBeforeExceptionalAndTax: string[];
  exceptionalItems: string[];
  profitBeforeTax: string[];
  currentTax: string[];
  deferredTax: string[];
  totalTax: string[];
  profitAfterTax: string[];
  eps: string[];
  /** Context metadata. */
  periodEnd: string[];
}

export const IND_AS_ALIASES: ElementAliases = {
  revenue: [
    'RevenueFromOperations',
    'GrossRevenueFromOperations',
    'RevenueFromSaleOfProducts',
    'Revenue',
  ],
  otherIncome: ['OtherIncome', 'OtherOperatingRevenue'],
  totalIncome: ['TotalIncome', 'Income'],
  costOfMaterials: [
    'CostOfMaterialsConsumed',
    'PurchasesOfStockInTrade',
    'CostOfRawMaterialsConsumed',
  ],
  employeeCost: ['EmployeeBenefitExpense', 'EmployeeBenefitsExpense'],
  financeCosts: ['FinanceCosts', 'InterestExpense'],
  depreciation: [
    'DepreciationDepletionAndAmortisationExpense',
    'DepreciationAndAmortisationExpense',
    'DepreciationAmortisationAndDepletionExpense',
  ],
  otherExpenses: ['OtherExpenses'],
  totalExpenses: ['TotalExpenses', 'Expenses'],
  profitBeforeExceptionalAndTax: [
    'ProfitBeforeExceptionalItemsAndTax',
    'ProfitLossBeforeExceptionalItemsAndTax',
  ],
  exceptionalItems: [
    'ExceptionalItemsBeforeTax',
    'ExceptionalItems',
    'ProfitLossFromExceptionalItems',
  ],
  profitBeforeTax: ['ProfitBeforeTax', 'ProfitLossBeforeTax'],
  currentTax: ['CurrentTax', 'CurrentTaxExpense'],
  deferredTax: ['DeferredTax', 'DeferredTaxExpense'],
  totalTax: ['TotalTaxExpense', 'TaxExpense', 'IncomeTaxExpense'],
  profitAfterTax: [
    'ProfitLossForPeriod',
    'ProfitLossFromContinuingOperations',
    'NetProfitLossForThePeriod',
    'ProfitAfterTax',
  ],
  eps: ['BasicEarningsLossPerShare', 'BasicEarningsPerShare', 'EarningsPerShareBasic'],
  periodEnd: ['DateOfEndOfReportingPeriod', 'PeriodEndDate'],
};

/** Lower-cased alias to canonical field, built once. */
export function buildLookup(aliases: ElementAliases = IND_AS_ALIASES): Map<string, keyof ElementAliases> {
  const lookup = new Map<string, keyof ElementAliases>();
  for (const [field, names] of Object.entries(aliases) as [keyof ElementAliases, string[]][]) {
    for (const name of names) {
      const key = name.toLowerCase();
      // First alias listed wins; later duplicates do not override.
      if (!lookup.has(key)) lookup.set(key, field);
    }
  }
  return lookup;
}
