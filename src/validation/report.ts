/**
 * Validation report rendering: console and a self-contained HTML file.
 *
 * The report leads with the exit criterion and its caveats rather than burying
 * them under a table of impressive-looking numbers. A win rate without its
 * sample size and interval is decoration, not evidence.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BucketMetrics, ValidationReport } from './metrics.ts';

function pct(value: number | null, digits = 2): string {
  return value === null ? '—' : `${value >= 0 ? '' : ''}${value.toFixed(digits)}%`;
}

function ratio(value: number | null): string {
  if (value === null) return '—';
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

export function printReport(report: ValidationReport, primaryHorizon = '5d'): void {
  console.log('═══ VALIDATION REPORT ═══');
  console.log(`Generated ${report.generatedAt}`);
  console.log(`Candidates stored: ${report.totalCandidates}\n`);

  if (report.mixedFidelityWarning) {
    console.log(`⚠ ${report.mixedFidelityWarning}\n`);
  }

  console.log('─── EXIT CRITERION ───');
  if (report.separation === null) {
    console.log('  Not assessable — no labelled outcomes.\n');
  } else {
    const s = report.separation;
    console.log(`  Verdict: ${s.verdict}`);
    console.log(`  ${s.rationale}`);
    console.log(
      `  At ${s.horizon}: PAPER_BUY ${pct(s.buyAvgReturnPct)}  ` +
        `WATCH ${pct(s.watchAvgReturnPct)}  IGNORE ${pct(s.ignoreAvgReturnPct)}` +
        (s.buyMinusIgnorePct !== null ? `  (gap ${pct(s.buyMinusIgnorePct)})` : ''),
    );
    console.log('');
  }

  console.log('─── BY ACTION ───');
  for (const bucket of report.buckets) {
    console.log(`\n  ${bucket.action}  (${bucket.candidates} candidates)`);
    if (bucket.byHorizon.length === 0) {
      console.log('    no labelled outcomes yet');
    }
    for (const h of bucket.byHorizon) {
      console.log(
        `    ${h.horizon.padEnd(4)} n=${String(h.n).padStart(4)}  ` +
          `avg ${pct(h.avgReturnPct).padStart(8)}  med ${pct(h.medianReturnPct).padStart(8)}  ` +
          `vs nifty ${pct(h.avgReturnVsNiftyPct).padStart(8)}  ` +
          `positive ${(h.positiveRate * 100).toFixed(0)}% ` +
          `[${(h.positiveRateInterval.low * 100).toFixed(0)}–${(h.positiveRateInterval.high * 100).toFixed(0)}%]`,
      );
    }

    const t = bucket.trades;
    if (t) {
      console.log(
        `    trades ${t.trades}  win ${(t.winRate * 100).toFixed(0)}% ` +
          `[${(t.winRateInterval.low * 100).toFixed(0)}–${(t.winRateInterval.high * 100).toFixed(0)}%]  ` +
          `expectancy ${pct(t.expectancyPct)}  PF ${ratio(t.profitFactor)}  ` +
          `maxDD ${pct(t.maxDrawdownPct)}`,
      );
      console.log(`    exits: ${JSON.stringify(t.exitBreakdown)}`);
      if (t.underpowered) {
        console.log(`    ⚠ only ${t.trades} trades — below the threshold for any conclusion`);
      }
    }
  }

  if (report.gateEffectiveness.length > 0) {
    console.log('\n─── GATE EFFECTIVENESS ───');
    console.log(`  (did what each gate rejected actually underperform, at ${primaryHorizon}?)`);
    for (const g of report.gateEffectiveness) {
      console.log(
        `  ${g.gate.padEnd(24)} rejected ${String(g.rejected).padStart(4)}  ` +
          `avg ${pct(g.avgReturnPct).padStart(8)}  ${g.verdict}`,
      );
    }
  }

  console.log('\n─── NOTES ───');
  for (const note of report.notes) console.log(`  • ${note}`);
  console.log('');
}

function bucketRows(buckets: readonly BucketMetrics[]): string {
  return buckets
    .flatMap((b) =>
      b.byHorizon.map(
        (h) => `<tr>
      <td>${b.action}</td><td>${h.horizon}</td><td class="n">${h.n}</td>
      <td class="n ${h.avgReturnPct >= 0 ? 'pos' : 'neg'}">${h.avgReturnPct.toFixed(2)}%</td>
      <td class="n">${h.medianReturnPct.toFixed(2)}%</td>
      <td class="n">${h.avgReturnVsNiftyPct === null ? '—' : `${h.avgReturnVsNiftyPct.toFixed(2)}%`}</td>
      <td class="n">${(h.positiveRate * 100).toFixed(0)}%
        <span class="ci">[${(h.positiveRateInterval.low * 100).toFixed(0)}–${(h.positiveRateInterval.high * 100).toFixed(0)}]</span></td>
      <td class="n">${h.avgMfePct.toFixed(2)}%</td><td class="n">${h.avgMaePct.toFixed(2)}%</td>
    </tr>`,
      ),
    )
    .join('\n');
}

const VERDICT_CLASS: Record<string, string> = {
  SEPARATION_PRESENT: 'ok',
  WEAK_SEPARATION: 'warn',
  NO_SEPARATION: 'bad',
  INSUFFICIENT_DATA: 'muted',
};

export function renderHtml(report: ValidationReport): string {
  const s = report.separation;
  const verdictClass = s ? (VERDICT_CLASS[s.verdict] ?? 'muted') : 'muted';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SWING-10 Validation</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fff; --muted:#666;
          --line:#e2e2e2; --ok:#0a7d3f; --warn:#a86400; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --bg:#151515; --muted:#9a9a9a; --line:#333;
            --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; }
  }
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; color: var(--fg);
         background: var(--bg); margin: 0; padding: 2rem 1.25rem; }
  main { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .6rem; text-transform: uppercase;
       letter-spacing: .06em; color: var(--muted); }
  .sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .9rem; }
  .verdict { border-left: 3px solid currentColor; padding: .75rem 1rem; margin: 0 0 1rem;
             border-radius: 0 4px 4px 0; }
  .verdict.ok { color: var(--ok); } .verdict.warn { color: var(--warn); }
  .verdict.bad { color: var(--bad); } .verdict.muted { color: var(--muted); }
  .verdict strong { display: block; font-size: 1.05rem; margin-bottom: .25rem; }
  .verdict p { color: var(--fg); margin: .35rem 0 0; }
  .warning { background: color-mix(in srgb, var(--warn) 12%, transparent);
             border-left: 3px solid var(--warn); padding: .75rem 1rem; margin: 1rem 0;
             border-radius: 0 4px 4px 0; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .88rem; }
  th, td { padding: .45rem .6rem; border-bottom: 1px solid var(--line); text-align: left;
           white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; font-size: .78rem; text-transform: uppercase;
       letter-spacing: .04em; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: var(--ok); } .neg { color: var(--bad); }
  .ci { color: var(--muted); font-size: .8em; }
  ul { padding-left: 1.1rem; color: var(--muted); }
</style></head>
<body><main>
  <h1>SWING-10 Validation</h1>
  <p class="sub">Generated ${report.generatedAt} · ${report.totalCandidates} candidates ·
     fidelity: ${report.fidelities.join(', ') || 'none'}</p>

  ${report.mixedFidelityWarning ? `<div class="warning">${report.mixedFidelityWarning}</div>` : ''}

  <h2>Exit criterion</h2>
  ${
    s
      ? `<div class="verdict ${verdictClass}">
      <strong>${s.verdict.replace(/_/g, ' ')}</strong>
      <p>${s.rationale}</p>
      <p>At ${s.horizon} — PAPER_BUY ${pct(s.buyAvgReturnPct)},
         WATCH ${pct(s.watchAvgReturnPct)}, IGNORE ${pct(s.ignoreAvgReturnPct)}.</p>
    </div>`
      : '<div class="verdict muted"><strong>Not assessable</strong><p>No labelled outcomes yet.</p></div>'
  }

  <h2>Forward returns by action</h2>
  <div class="scroll"><table>
    <thead><tr><th>Action</th><th>Horizon</th><th>n</th><th>Avg</th><th>Median</th>
      <th>vs Nifty</th><th>Positive</th><th>Avg MFE</th><th>Avg MAE</th></tr></thead>
    <tbody>${bucketRows(report.buckets) || '<tr><td colspan="9">No labelled outcomes.</td></tr>'}</tbody>
  </table></div>

  <h2>Simulated trades</h2>
  <div class="scroll"><table>
    <thead><tr><th>Action</th><th>Trades</th><th>Win rate</th><th>Avg win</th><th>Avg loss</th>
      <th>Expectancy</th><th>Profit factor</th><th>Max DD</th></tr></thead>
    <tbody>${
      report.buckets
        .filter((b) => b.trades !== null)
        .map((b) => {
          const t = b.trades!;
          return `<tr><td>${b.action}${t.underpowered ? ' ⚠' : ''}</td>
            <td class="n">${t.trades}</td>
            <td class="n">${(t.winRate * 100).toFixed(0)}%
              <span class="ci">[${(t.winRateInterval.low * 100).toFixed(0)}–${(t.winRateInterval.high * 100).toFixed(0)}]</span></td>
            <td class="n">${pct(t.avgWinPct)}</td><td class="n">${pct(t.avgLossPct)}</td>
            <td class="n ${(t.expectancyPct ?? 0) >= 0 ? 'pos' : 'neg'}">${pct(t.expectancyPct)}</td>
            <td class="n">${ratio(t.profitFactor)}</td><td class="n">${pct(t.maxDrawdownPct)}</td></tr>`;
        })
        .join('\n') || '<tr><td colspan="8">No simulated trades.</td></tr>'
    }</tbody>
  </table></div>

  <h2>Gate effectiveness</h2>
  <div class="scroll"><table>
    <thead><tr><th>Gate</th><th>Rejected</th><th>Avg return of rejects</th><th>Verdict</th></tr></thead>
    <tbody>${
      report.gateEffectiveness
        .map(
          (g) => `<tr><td>${g.gate}</td><td class="n">${g.rejected}</td>
        <td class="n ${(g.avgReturnPct ?? 0) < 0 ? 'pos' : 'neg'}">${pct(g.avgReturnPct)}</td>
        <td>${g.verdict}</td></tr>`,
        )
        .join('\n') || '<tr><td colspan="4">No gate rejections recorded.</td></tr>'
    }</tbody>
  </table></div>

  <h2>Notes</h2>
  <ul>${report.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
</main></body></html>`;
}

export function writeHtmlReport(report: ValidationReport, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderHtml(report), 'utf8');
}
