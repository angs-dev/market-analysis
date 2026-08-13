/**
 * Event classification from announcement headlines.
 *
 * Rule-based and deliberately conservative. A headline that does not clearly
 * match a category becomes OTHER with low confidence rather than being forced
 * into the nearest bucket — misclassifying a routine disclosure as a results
 * announcement would feed the scoring engine a catalyst that does not exist.
 *
 * Sentiment is separate from type. "Results" is a type; whether those results
 * were good is a different question answered by the fundamentals, not by
 * adjectives in a headline.
 */

export type EventType =
  | 'RESULTS'
  | 'GUIDANCE_UPGRADE'
  | 'GUIDANCE_DOWNGRADE'
  | 'ORDER_WIN'
  | 'ACQUISITION'
  | 'DIVESTMENT'
  | 'PARTNERSHIP'
  | 'REGULATORY_APPROVAL'
  | 'REGULATORY_ACTION'
  | 'CAPACITY_EXPANSION'
  | 'DEBT_REDUCTION'
  | 'FUND_RAISE'
  | 'BUYBACK'
  | 'DIVIDEND'
  | 'BONUS_SPLIT'
  | 'PROMOTER_ACTIVITY'
  | 'CREDIT_RATING_UPGRADE'
  | 'CREDIT_RATING_DOWNGRADE'
  | 'MANAGEMENT_CHANGE'
  | 'LITIGATION'
  | 'ROUTINE_DISCLOSURE'
  | 'OTHER';

export type Sentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'AMBIGUOUS';

export interface Classification {
  eventType: EventType;
  /** 0..1. Below 0.5 means the match was weak and should be treated as such. */
  confidence: number;
  sentiment: Sentiment;
  /** The phrases that drove the decision, for the audit trail. */
  evidence: string[];
  /** True for filings that are administrative rather than valuation-relevant. */
  routine: boolean;
}

interface Rule {
  type: EventType;
  /** Higher wins when several rules match. */
  priority: number;
  sentiment: Sentiment;
  patterns: RegExp[];
  /** Any match here disqualifies the rule. */
  exclude?: RegExp[];
}

/**
 * Ordered by specificity. Routine disclosures are matched first and hard —
 * exchanges emit far more housekeeping than news, and letting a "newspaper
 * publication" filing through as an event would swamp everything real.
 */
const RULES: Rule[] = [
  {
    type: 'ROUTINE_DISCLOSURE', priority: 100, sentiment: 'NEUTRAL',
    patterns: [
      /\bnewspaper (publication|advertisement)/i,
      /\bpublication of (the )?(un)?audited/i,
      /\bintimation of (board meeting|record date)/i,
      /\bnotice of (board meeting|postal ballot|annual general meeting|agm)/i,
      /\bcompliance certificate\b/i,
      /\breg(ulation)?\.? ?(7|13|23|24|30|31|39|40|46|76)\b.*\bcompliance/i,
      /\bshareholding pattern\b/i,
      /\bcorporate governance report\b/i,
      /\breconciliation of share capital\b/i,
      /\bloss of share certificate/i,
      /\bduplicate share certificate/i,
      /\btrading window (closure|clos)/i,
      /\bdisclosure under regulation \d+/i,
      /\bappointment of (registrar|scrutinizer)/i,
      /\bsubmission of (the )?annual report\b/i,
    ],
  },
  {
    type: 'RESULTS', priority: 90, sentiment: 'AMBIGUOUS',
    patterns: [
      /\b(un)?audited financial results\b/i,
      /\bfinancial results for the (quarter|half year|year)/i,
      /\b(q[1-4]|quarterly) results\b/i,
      /\bstandalone and consolidated results\b/i,
      /\boutcome of board meeting.*\bresults\b/i,
      /\bresults for the (quarter|period) ended\b/i,
    ],
    // A notice of a future results meeting is not the results themselves.
    exclude: [/\bintimation\b/i, /\bnotice of\b/i, /\bprior intimation\b/i],
  },
  {
    type: 'ORDER_WIN', priority: 80, sentiment: 'POSITIVE',
    patterns: [
      /\b(receipt|received|secure[sd]?|win[s]?|won|bag[s]?|award(ed)?) (of )?(an? )?(new )?(order|contract|work order|loa|letter of award)/i,
      /\border (win|inflow|book)/i,
      /\bletter of (award|intent)\b/i,
      /\bcontract worth\b/i,
      /\bemerged as (the )?(lowest bidder|l1)\b/i,
    ],
  },
  {
    type: 'ACQUISITION', priority: 78, sentiment: 'POSITIVE',
    patterns: [
      /\bacquisition of\b/i, /\bacquire[sd]?\b/i,
      /\bamalgamation\b/i, /\bscheme of arrangement\b/i,
      /\bmerger\b/i, /\bsubsidiar(y|ies) (incorporation|acquisition)/i,
    ],
    exclude: [/\bacquisition of (shares by|equity shares by) (a )?promoter/i],
  },
  {
    type: 'DIVESTMENT', priority: 77, sentiment: 'AMBIGUOUS',
    patterns: [
      /\bdivestment\b/i, /\bsale of (stake|business|undertaking|subsidiary|assets?)/i,
      /\bslump sale\b/i, /\bhive[- ]off\b/i, /\bdisinvest/i,
    ],
  },
  {
    type: 'CAPACITY_EXPANSION', priority: 75, sentiment: 'POSITIVE',
    patterns: [
      /\bcapacity (expansion|addition|enhancement)/i,
      /\b(new|greenfield|brownfield) (plant|facility|unit|line)\b/i,
      /\bcommissioning of\b/i, /\bcommercial production\b/i,
      /\bcapex (plan|programme|program)\b/i,
      /\bexpansion (plan|project)\b/i,
    ],
  },
  {
    type: 'REGULATORY_APPROVAL', priority: 74, sentiment: 'POSITIVE',
    patterns: [
      /\b(approval|clearance|licence|license|certification) (from|by|received|granted)/i,
      /\b(usfda|us fda|cdsco|dcgi|ema|who[- ]gmp)\b.*\b(approval|clearance|nod)/i,
      /\bproduct approval\b/i, /\bpatent (granted|approval)/i,
      /\benvironmental clearance\b/i,
    ],
  },
  {
    type: 'REGULATORY_ACTION', priority: 74, sentiment: 'NEGATIVE',
    patterns: [
      /\b(show cause|scn)\b/i, /\bpenalt(y|ies) (imposed|levied)/i,
      /\b(warning letter|import alert|form 483)\b/i,
      /\b(sebi|rbi|nclt|cci) (order|action|direction)/i,
      /\bsuspension of (licence|license|operations)/i,
    ],
  },
  {
    type: 'DEBT_REDUCTION', priority: 70, sentiment: 'POSITIVE',
    patterns: [
      /\b(debt|borrowing) (reduction|repayment|prepayment)/i,
      /\brepayment of (loan|debt|ncd|debenture)/i,
      /\bbecome[s]? (a )?(net )?debt[- ]free\b/i,
      /\bdeleverag/i,
    ],
  },
  {
    type: 'CREDIT_RATING_UPGRADE', priority: 70, sentiment: 'POSITIVE',
    // Order-agnostic: filings say both "rating upgraded" and "upgrade of rating".
    patterns: [
      /\brating\b[\s\S]{0,40}\b(upgrade|revised upward|improved)/i,
      /\b(upgrade[sd]?|revision upward)\b[\s\S]{0,40}\brating\b/i,
    ],
  },
  {
    type: 'CREDIT_RATING_DOWNGRADE', priority: 70, sentiment: 'NEGATIVE',
    patterns: [
      /\brating\b[\s\S]{0,40}\b(downgrade|revised downward)/i,
      /\b(downgrade[sd]?|revision downward)\b[\s\S]{0,40}\brating\b/i,
    ],
  },
  {
    type: 'BUYBACK', priority: 68, sentiment: 'POSITIVE',
    patterns: [/\bbuy[- ]?back\b/i, /\brepurchase of (equity )?shares/i],
  },
  {
    type: 'FUND_RAISE', priority: 66, sentiment: 'AMBIGUOUS',
    patterns: [
      /\b(qip|qualified institutional placement)\b/i,
      /\bpreferential (issue|allotment)\b/i,
      /\brights issue\b/i, /\bfund rais/i,
      /\bissue of (ncd|debenture|bond|commercial paper)/i,
    ],
  },
  {
    type: 'PARTNERSHIP', priority: 64, sentiment: 'POSITIVE',
    patterns: [
      /\b(strategic )?(partnership|alliance|collaboration|tie[- ]up)\b/i,
      /\bjoint venture\b/i, /\bmou\b/i, /\bmemorandum of understanding\b/i,
      /\bdistribution agreement\b/i,
    ],
  },
  {
    type: 'GUIDANCE_UPGRADE', priority: 62, sentiment: 'POSITIVE',
    patterns: [
      /\bguidance.*\b(raise[sd]?|rais(ing|ed)|upgrade[sd]?|increase[sd]?|revised upward)/i,
      /\b(raise[sd]?|upgrade[sd]?) (its |the |full[- ]year )?(fy\d+ )?(guidance|outlook|target)/i,
    ],
  },
  {
    type: 'GUIDANCE_DOWNGRADE', priority: 62, sentiment: 'NEGATIVE',
    patterns: [
      /\bguidance.*\b(cut|lower(ed|s)?|reduce[sd]?|downgrade[sd]?|revised downward)/i,
      /\b(cut|lower(ed|s)?|downgrade[sd]?) (its |the |full[- ]year )?(fy\d+ )?(guidance|outlook)/i,
    ],
  },
  {
    type: 'DIVIDEND', priority: 55, sentiment: 'POSITIVE',
    patterns: [/\bdividend\b/i],
    exclude: [/\bunclaimed dividend\b/i, /\biepf\b/i, /\btransfer of.*dividend/i],
  },
  {
    type: 'BONUS_SPLIT', priority: 55, sentiment: 'POSITIVE',
    patterns: [/\bbonus (issue|shares)\b/i, /\bstock split\b/i, /\bsub[- ]division of (equity )?shares/i],
  },
  {
    type: 'PROMOTER_ACTIVITY', priority: 52, sentiment: 'AMBIGUOUS',
    patterns: [
      /\bpromoter.*\b(acquisition|purchase|sale|pledge|release of pledge|encumbrance)/i,
      /\b(pledge|encumbrance) of shares\b/i,
      /\bsast\b/i, /\bopen offer\b/i,
    ],
  },
  {
    type: 'MANAGEMENT_CHANGE', priority: 50, sentiment: 'AMBIGUOUS',
    patterns: [
      /\b(resignation|appointment|cessation) of\b.*\b(director|ceo|cfo|managing director|chairman|company secretary|auditor)/i,
      /\bchange in (key managerial personnel|kmp|management)/i,
    ],
  },
  {
    type: 'LITIGATION', priority: 50, sentiment: 'NEGATIVE',
    patterns: [
      /\b(litigation|lawsuit|arbitration|insolvency|nclt petition)\b/i,
      /\bcourt (order|ruling|judgment)/i, /\bwrit petition\b/i,
    ],
  },
];

/** Words that shift sentiment for an otherwise ambiguous type. */
const POSITIVE_HINTS = [
  /\brecord (revenue|profit|pat|ebitda)\b/i,
  /\bhighest ever\b/i,
  /\bstrong (growth|performance|quarter)\b/i,
  /\bmargin expansion\b/i,
];
const NEGATIVE_HINTS = [
  /\bloss\b/i, /\bdecline[sd]?\b/i, /\bfall[s]? \d+%/i,
  /\bimpairment\b/i, /\bwrite[- ]off\b/i, /\bdefault\b/i,
];

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Classifies an announcement.
 *
 * `body` is optional and only used to break ties or refine sentiment; the
 * headline is authoritative for the type.
 */
export function classifyEvent(headline: string, body?: string): Classification {
  const text = normalise(headline);
  const haystack = normalise(`${headline} ${body ?? ''}`);

  if (text === '') {
    return {
      eventType: 'OTHER', confidence: 0, sentiment: 'NEUTRAL',
      evidence: ['empty headline'], routine: false,
    };
  }

  const matches: { rule: Rule; hits: string[] }[] = [];

  for (const rule of RULES) {
    if (rule.exclude?.some((re) => re.test(text))) continue;
    const hits = rule.patterns
      .map((re) => re.exec(text)?.[0])
      .filter((m): m is string => m !== undefined);
    if (hits.length > 0) matches.push({ rule, hits });
  }

  if (matches.length === 0) {
    return {
      eventType: 'OTHER', confidence: 0.2, sentiment: 'NEUTRAL',
      evidence: ['no category pattern matched'], routine: false,
    };
  }

  matches.sort((a, b) => b.rule.priority - a.rule.priority || b.hits.length - a.hits.length);
  const best = matches[0]!;

  // Confidence rises with the number of distinct phrases matched, and falls
  // when a competing category of similar priority also matched.
  const contested = matches.filter(
    (m) => m !== best && Math.abs(m.rule.priority - best.rule.priority) <= 5,
  ).length;
  const confidence = Math.max(
    0.25,
    Math.min(0.95, 0.55 + best.hits.length * 0.15 - contested * 0.2),
  );

  let sentiment = best.rule.sentiment;
  if (sentiment === 'AMBIGUOUS') {
    const positive = POSITIVE_HINTS.some((re) => re.test(haystack));
    const negative = NEGATIVE_HINTS.some((re) => re.test(haystack));
    if (positive && !negative) sentiment = 'POSITIVE';
    else if (negative && !positive) sentiment = 'NEGATIVE';
  }

  return {
    eventType: best.rule.type,
    confidence,
    sentiment,
    evidence: best.hits.map((h) => `matched "${h}"`).concat(
      contested > 0 ? [`${contested} competing categor${contested === 1 ? 'y' : 'ies'} also matched`] : [],
    ),
    routine: best.rule.type === 'ROUTINE_DISCLOSURE',
  };
}

/** Event types that can plausibly move a valuation. */
export const MATERIAL_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'RESULTS', 'GUIDANCE_UPGRADE', 'GUIDANCE_DOWNGRADE', 'ORDER_WIN',
  'ACQUISITION', 'DIVESTMENT', 'REGULATORY_APPROVAL', 'REGULATORY_ACTION',
  'CAPACITY_EXPANSION', 'DEBT_REDUCTION', 'BUYBACK', 'PARTNERSHIP',
  'CREDIT_RATING_UPGRADE', 'CREDIT_RATING_DOWNGRADE', 'FUND_RAISE',
]);

/**
 * Materiality: how likely this event is to change earnings expectations.
 * Distinct from sentiment — a regulatory action is highly material and bad.
 */
export function assessMateriality(c: Classification): number {
  if (c.routine) return 0;
  if (!MATERIAL_TYPES.has(c.eventType)) return 0.2 * c.confidence;

  const weight: Partial<Record<EventType, number>> = {
    RESULTS: 1.0,
    GUIDANCE_UPGRADE: 0.95,
    GUIDANCE_DOWNGRADE: 0.95,
    REGULATORY_ACTION: 0.9,
    ACQUISITION: 0.85,
    ORDER_WIN: 0.8,
    REGULATORY_APPROVAL: 0.8,
    DIVESTMENT: 0.75,
    CREDIT_RATING_DOWNGRADE: 0.7,
    CAPACITY_EXPANSION: 0.65,
    DEBT_REDUCTION: 0.6,
    CREDIT_RATING_UPGRADE: 0.6,
    FUND_RAISE: 0.5,
    BUYBACK: 0.5,
    PARTNERSHIP: 0.4,
  };

  return (weight[c.eventType] ?? 0.3) * c.confidence;
}
