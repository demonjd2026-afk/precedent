#!/usr/bin/env node
/**
 * Run the live evaluation suite against the deployed development app.
 *
 *   PRECEDENT_EVAL_URL=<web trigger url> PRECEDENT_EVAL_TOKEN=<token> npm run eval:live
 *   ... npm run eval:live -- --suite extraction
 *
 * Exits 0 when every threshold passes, 1 when any fails, 2 on setup errors.
 */

const url = process.env.PRECEDENT_EVAL_URL;
const token = process.env.PRECEDENT_EVAL_TOKEN;
const suiteArg = process.argv.indexOf('--suite');
const suite = suiteArg > -1 ? process.argv[suiteArg + 1] : 'all';
const POLL_MS = 5000;
const TIMEOUT_MS = 16 * 60 * 1000;

if (!url || !token) {
  console.error('Set PRECEDENT_EVAL_URL (from `forge webtrigger create`) and PRECEDENT_EVAL_TOKEN.');
  process.exit(2);
}

const headers = { Authorization: `Bearer ${token}` };
const withParams = (params) => {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

const pct = (x) => (x === null || x === undefined ? '  n/a ' : `${(x * 100).toFixed(1).padStart(5)}%`);
const row = (label, value, target) => console.log(`  ${label.padEnd(34)} ${value}${target ? `   target ${target}` : ''}`);

async function main() {
  const start = await fetch(withParams({ suite }), { method: 'POST', headers });
  if (start.status === 404) {
    console.error('404: wrong URL or token, the app is in production, or EVAL_TOKEN is not set on this environment.');
    process.exit(2);
  }
  if (!start.ok) {
    console.error(`Could not start run: HTTP ${start.status} ${await start.text()}`);
    process.exit(2);
  }
  const { runId } = await start.json();
  console.log(`Run ${runId} queued (suite: ${suite}). Polling…`);

  const deadline = Date.now() + TIMEOUT_MS;
  let report;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await fetch(withParams({ run: runId }), { headers });
    if (!res.ok) continue;
    report = await res.json();
    process.stdout.write(`\r  status: ${report.status}      `);
    if (report.status === 'complete' || report.status === 'failed') break;
  }
  console.log('\n');

  if (!report || (report.status !== 'complete' && report.status !== 'failed')) {
    console.error('Timed out waiting for the run. Check `forge logs -e development`.');
    process.exit(2);
  }
  if (report.status === 'failed') {
    console.error(`Run failed: ${report.error}`);
    process.exit(1);
  }

  const T = report.thresholds;
  console.log(`PRECEDENT EVALUATION  ·  ${report.finishedAt}  ·  ${report.durationSeconds}s\n`);

  if (report.triage) {
    console.log('Triage gate (free, runs before any model call)');
    row('Decisions kept (recall)', pct(report.triage.recall), `≥ ${pct(T.triage.recall).trim()}`);
    row('Model calls avoided', String(report.triage.modelCallsAvoided));
    console.log();
  }
  if (report.extraction) {
    const e = report.extraction;
    console.log(`Decision extraction (${e.counts.scored} labelled comments)`);
    row('Precision', pct(e.precision), `≥ ${pct(T.extraction.precision).trim()}`);
    row('Recall', pct(e.recall), `≥ ${pct(T.extraction.recall).trim()}`);
    row('F1', pct(e.f1));
    row('Rejected alternatives recovered', pct(e.rejectedRecall), `≥ ${pct(T.extraction.rejectedRecall).trim()}`);
    row('Assumptions recovered', pct(e.assumptionRecall));
    row('Quotes rejected by grounding check', String(e.groundingRejections));
    for (const f of e.falsePositives) console.log(`    ✗ false decision: ${f.id} — "${f.title}"`);
    for (const f of e.falseNegatives) console.log(`    ✗ missed: ${f.id} — ${f.reason}`);
    for (const f of e.fieldMisses) console.log(`    · ${f.field} not recovered: ${f.id} → ${JSON.stringify(f.got)}`);
    console.log();
  }
  if (report.conflict) {
    const c = report.conflict;
    console.log(`Conflict check (${c.counts.unrelatedPairs + c.counts.contradictionsExpected + c.counts.dependsExpected} proposal × decision pairs)`);
    row('Contradictions caught', pct(c.contradictionRecall), `≥ ${pct(T.conflict.contradictionRecall).trim()}`);
    row('Dependencies caught', pct(c.dependencyRecall));
    row('False alarm rate', pct(c.falseAlarmRate), `≤ ${pct(T.conflict.falseAlarmRate).trim()}`);
    row('Silent on unrelated proposals', pct(c.silenceOnUnrelated), `≥ ${pct(T.conflict.silenceOnUnrelated).trim()}`);
    for (const a of c.alarms) console.log(`    ✗ false alarm: ${a.case} → ${a.decision} (${a.got})`);
    for (const m of c.misses) console.log(`    ✗ missed: ${m.case} → ${m.decision} (wanted ${m.want}, got ${m.got})`);
    console.log();
  }

  if (report.passed) {
    console.log('PASS — all thresholds met.');
    process.exit(0);
  }
  console.log('FAIL');
  for (const f of report.failures) console.log(`  - ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
