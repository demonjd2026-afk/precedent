/**
 * Evaluation scoring — pure functions, no Forge imports.
 *
 * Shared by the live runner (inside Forge) and the offline tests, so the
 * numbers a judge sees are produced by code that is itself unit-tested.
 *
 * The thresholds encode the product's priorities, not generic ML targets:
 *
 *  - Precision matters more than recall for extraction. A fabricated decision
 *    in the register is worse than a missed one, because people act on it.
 *  - False alarms matter more than anything for conflict checking. A tool that
 *    cries wolf gets muted, and a muted guard protects nothing.
 *  - The free triage gate is the opposite: it must almost never drop a real
 *    decision, because anything it drops never reaches the model at all.
 */

export const THRESHOLDS = Object.freeze({
  triage: { recall: 0.95 },
  extraction: { precision: 0.9, recall: 0.8, rejectedRecall: 0.8 },
  conflict: { contradictionRecall: 0.8, falseAlarmRate: 0.05, silenceOnUnrelated: 0.75 },
});

const ratio = (num, den) => (den === 0 ? null : num / den);
const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

function fieldHit(values, keywords) {
  const hay = (values ?? []).join(' ').toLowerCase();
  return (keywords ?? []).some((k) => hay.includes(String(k).toLowerCase()));
}

/**
 * Score the free lexical gate. Only recall is thresholded: the gate exists to
 * save money, and it is allowed to pass through plenty of non-decisions.
 *
 * @param {{id: string, isDecision: boolean}[]} cases
 * @param {Record<string, boolean>} proceeded  case id -> did the gate pass it
 */
export function scoreTriage(cases, proceeded) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  const missed = [];
  for (const c of cases) {
    const passed = Boolean(proceeded[c.id]);
    if (c.isDecision && passed) tp += 1;
    else if (c.isDecision && !passed) { fn += 1; missed.push(c.id); }
    else if (!c.isDecision && passed) fp += 1;
    else tn += 1;
  }
  return {
    recall: ratio(tp, tp + fn),
    passThroughRate: ratio(fp, fp + tn),
    modelCallsAvoided: tn,
    missed,
    counts: { tp, fn, fp, tn },
  };
}

/**
 * @param {Object[]} cases       extraction dataset cases
 * @param {Record<string, {predicted: boolean, reason?: string, rejected?: string[], assumptions?: string[]}>} results
 */
export function scoreExtraction(cases, results) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let rejectedHits = 0, rejectedTotal = 0;
  let assumptionHits = 0, assumptionTotal = 0;
  let groundingRejections = 0;
  const falsePositives = [];
  const falseNegatives = [];
  const fieldMisses = [];
  const errors = [];

  for (const c of cases) {
    const r = results[c.id];
    if (!r || r.error) {
      errors.push({ id: c.id, error: r?.error ?? 'no result' });
      continue;
    }
    if (/does not appear in the source/.test(r.reason ?? '')) groundingRejections += 1;

    if (c.isDecision && r.predicted) tp += 1;
    else if (c.isDecision && !r.predicted) falseNegatives.push({ id: c.id, reason: r.reason }), (fn += 1);
    else if (!c.isDecision && r.predicted) falsePositives.push({ id: c.id, title: r.title }), (fp += 1);
    else tn += 1;

    // Field recall is only meaningful when the decision was found.
    if (c.isDecision && r.predicted && c.rejectedAny) {
      rejectedTotal += 1;
      if (fieldHit(r.rejected, c.rejectedAny)) rejectedHits += 1;
      else fieldMisses.push({ id: c.id, field: 'rejected', got: r.rejected ?? [] });
    }
    if (c.isDecision && r.predicted && c.assumptionAny) {
      assumptionTotal += 1;
      if (fieldHit(r.assumptions, c.assumptionAny)) assumptionHits += 1;
      else fieldMisses.push({ id: c.id, field: 'assumptions', got: r.assumptions ?? [] });
    }
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;

  return {
    precision,
    recall,
    f1,
    rejectedRecall: ratio(rejectedHits, rejectedTotal),
    assumptionRecall: ratio(assumptionHits, assumptionTotal),
    groundingRejections,
    counts: { tp, fp, fn, tn, scored: tp + fp + fn + tn, errors: errors.length },
    falsePositives,
    falseNegatives,
    fieldMisses,
    errors,
  };
}

/**
 * Every (proposal, decision) pair is judged. Pairs absent from `expect` are
 * ground-truth unrelated, so any finding on them is a false alarm.
 *
 * @param {{cases: Object[], register: Object[]}} dataset
 * @param {Record<string, {findings: {decisionId: string, relationship: string}[], error?: string}>} results
 */
export function scoreConflict(dataset, results) {
  const ids = dataset.register.map((d) => d.id);
  let contradictionsExpected = 0, contradictionsFound = 0;
  let dependsExpected = 0, dependsFound = 0;
  let unrelatedPairs = 0, falseAlarms = 0, wrongRelationship = 0;
  let quietCases = 0, quietCorrect = 0;
  const alarms = [];
  const misses = [];
  const errors = [];

  for (const c of dataset.cases) {
    const r = results[c.id];
    if (!r || r.error) {
      errors.push({ id: c.id, error: r?.error ?? 'no result' });
      continue;
    }
    const reported = new Map((r.findings ?? []).map((f) => [f.decisionId, f.relationship]));

    if (Object.keys(c.expect).length === 0) {
      quietCases += 1;
      if (reported.size === 0) quietCorrect += 1;
    }

    for (const id of ids) {
      const want = c.expect[id];
      const got = reported.get(id);
      if (want === 'contradicts') {
        contradictionsExpected += 1;
        if (got === 'contradicts') contradictionsFound += 1;
        else if (got) { wrongRelationship += 1; misses.push({ case: c.id, decision: id, want, got }); }
        else misses.push({ case: c.id, decision: id, want, got: 'nothing' });
      } else if (want === 'depends_on') {
        dependsExpected += 1;
        if (got === 'depends_on') dependsFound += 1;
        else if (got) { wrongRelationship += 1; misses.push({ case: c.id, decision: id, want, got }); }
        else misses.push({ case: c.id, decision: id, want, got: 'nothing' });
      } else {
        unrelatedPairs += 1;
        if (got) { falseAlarms += 1; alarms.push({ case: c.id, decision: id, got }); }
      }
    }
  }

  return {
    contradictionRecall: ratio(contradictionsFound, contradictionsExpected),
    dependencyRecall: ratio(dependsFound, dependsExpected),
    falseAlarmRate: ratio(falseAlarms, unrelatedPairs),
    silenceOnUnrelated: ratio(quietCorrect, quietCases),
    wrongRelationship,
    counts: { contradictionsExpected, contradictionsFound, dependsExpected, dependsFound, unrelatedPairs, falseAlarms },
    alarms,
    misses,
    errors,
  };
}

/** Compare a report to THRESHOLDS. Returns a list of failures; empty means pass. */
export function checkThresholds(report) {
  const failures = [];
  const below = (suite, metric, value, min) => {
    if (value === null || value === undefined) failures.push(`${suite}.${metric}: no data`);
    else if (value < min) failures.push(`${suite}.${metric} ${pct(value)} < ${pct(min)}`);
  };
  const above = (suite, metric, value, max) => {
    if (value === null || value === undefined) failures.push(`${suite}.${metric}: no data`);
    else if (value > max) failures.push(`${suite}.${metric} ${pct(value)} > ${pct(max)}`);
  };

  if (report.triage) below('triage', 'recall', report.triage.recall, THRESHOLDS.triage.recall);
  if (report.extraction) {
    const e = report.extraction, t = THRESHOLDS.extraction;
    below('extraction', 'precision', e.precision, t.precision);
    below('extraction', 'recall', e.recall, t.recall);
    below('extraction', 'rejectedRecall', e.rejectedRecall, t.rejectedRecall);
    if (e.counts.errors > 0) failures.push(`extraction: ${e.counts.errors} case(s) errored`);
  }
  if (report.conflict) {
    const c = report.conflict, t = THRESHOLDS.conflict;
    below('conflict', 'contradictionRecall', c.contradictionRecall, t.contradictionRecall);
    above('conflict', 'falseAlarmRate', c.falseAlarmRate, t.falseAlarmRate);
    below('conflict', 'silenceOnUnrelated', c.silenceOnUnrelated, t.silenceOnUnrelated);
    if (c.errors.length > 0) failures.push(`conflict: ${c.errors.length} case(s) errored`);
  }
  return failures;
}

export { pct };
