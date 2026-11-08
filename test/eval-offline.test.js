/**
 * Offline evaluation: everything that can be measured without a model.
 *
 *  1. The free triage gate, scored against the labelled extraction dataset.
 *     This runs in CI on every change: a regex edit that starts dropping real
 *     decisions fails the build before it ever reaches a deploy.
 *  2. The scoring functions themselves, against hand-computed expectations,
 *     so the live scorecard's numbers can be trusted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { triage } from '../src/engine/detect.js';
import { scoreTriage, scoreExtraction, scoreConflict, checkThresholds, THRESHOLDS } from '../eval/score.js';

const extraction = JSON.parse(readFileSync(new URL('../eval/datasets/extraction.json', import.meta.url)));
const conflict = JSON.parse(readFileSync(new URL('../eval/datasets/conflict.json', import.meta.url)));

// ---------------------------------------------------------------------------
// Triage gate against the dataset
// ---------------------------------------------------------------------------

test('triage gate keeps every labelled decision (recall threshold)', () => {
  const proceeded = Object.fromEntries(extraction.cases.map((c) => [c.id, triage(c.text).proceed]));
  const score = scoreTriage(extraction.cases, proceeded);

  assert.ok(
    score.recall >= THRESHOLDS.triage.recall,
    `triage recall ${(score.recall * 100).toFixed(1)}% is below ${THRESHOLDS.triage.recall * 100}%; dropped: ${score.missed.join(', ')}`
  );
});

test('triage gate saves model calls on obvious noise', () => {
  const proceeded = Object.fromEntries(extraction.cases.map((c) => [c.id, triage(c.text).proceed]));
  const score = scoreTriage(extraction.cases, proceeded);
  // The gate is tuned for recall, so it lets subtle non-decisions through on
  // purpose. It must still filter the cheap cases rather than pass everything.
  assert.ok(score.modelCallsAvoided >= 2, `gate filtered only ${score.modelCallsAvoided} non-decisions`);
  for (const id of ['acknowledgement', 'automation-noise']) {
    assert.equal(proceeded[id], false, `${id} should never reach the model`);
  }
});

// ---------------------------------------------------------------------------
// Dataset integrity
// ---------------------------------------------------------------------------

test('datasets are well formed', () => {
  const ids = new Set(extraction.cases.map((c) => c.id));
  assert.equal(ids.size, extraction.cases.length, 'duplicate extraction case ids');
  assert.ok(extraction.cases.some((c) => c.isDecision) && extraction.cases.some((c) => !c.isDecision));

  const registerIds = new Set(conflict.register.map((d) => d.id));
  for (const c of conflict.cases) {
    for (const [id, rel] of Object.entries(c.expect)) {
      assert.ok(registerIds.has(id), `${c.id} references unknown ${id}`);
      assert.ok(['contradicts', 'depends_on'].includes(rel), `${c.id} has bad relationship ${rel}`);
    }
  }
  assert.ok(conflict.cases.some((c) => Object.keys(c.expect).length === 0), 'need unrelated controls');
});

// ---------------------------------------------------------------------------
// Scorer correctness
// ---------------------------------------------------------------------------

test('extraction scorer computes precision, recall and field recall', () => {
  const cases = [
    { id: 'a', isDecision: true, rejectedAny: ['adobe'] },
    { id: 'b', isDecision: true, rejectedAny: ['dynamo'] },
    { id: 'c', isDecision: true },
    { id: 'd', isDecision: false },
    { id: 'e', isDecision: false },
  ];
  const results = {
    a: { predicted: true, rejected: ['Adobe Sign'] },
    b: { predicted: true, rejected: ['MySQL'] },
    c: { predicted: false, reason: 'the quoted decision text does not appear in the source' },
    d: { predicted: true, title: 'false decision' },
    e: { predicted: false },
  };
  const s = scoreExtraction(cases, results);
  assert.equal(s.counts.tp, 2);
  assert.equal(s.counts.fp, 1);
  assert.equal(s.counts.fn, 1);
  assert.equal(s.counts.tn, 1);
  assert.equal(s.precision, 2 / 3);
  assert.equal(s.recall, 2 / 3);
  assert.equal(s.rejectedRecall, 0.5);
  assert.equal(s.groundingRejections, 1);
  assert.deepEqual(s.falsePositives.map((f) => f.id), ['d']);
});

test('conflict scorer treats every unlisted pair as a false alarm', () => {
  const dataset = {
    register: [{ id: 'DR-1' }, { id: 'DR-2' }],
    cases: [
      { id: 'p1', expect: { 'DR-1': 'contradicts' } },
      { id: 'p2', expect: {} },
    ],
  };
  const results = {
    p1: { findings: [{ decisionId: 'DR-1', relationship: 'contradicts' }, { decisionId: 'DR-2', relationship: 'depends_on' }] },
    p2: { findings: [] },
  };
  const s = scoreConflict(dataset, results);
  assert.equal(s.contradictionRecall, 1);
  // Unrelated pairs: (p1, DR-2), (p2, DR-1), (p2, DR-2) = 3; one alarm.
  assert.equal(s.counts.unrelatedPairs, 3);
  assert.equal(s.falseAlarmRate, 1 / 3);
  assert.equal(s.silenceOnUnrelated, 1);
});

test('conflict scorer counts a wrong relationship as a miss, not a hit', () => {
  const dataset = { register: [{ id: 'DR-1' }], cases: [{ id: 'p', expect: { 'DR-1': 'contradicts' } }] };
  const s = scoreConflict(dataset, { p: { findings: [{ decisionId: 'DR-1', relationship: 'depends_on' }] } });
  assert.equal(s.contradictionRecall, 0);
  assert.equal(s.wrongRelationship, 1);
});

test('threshold check reports failures and passes a clean report', () => {
  const failing = checkThresholds({
    conflict: {
      contradictionRecall: 0.5, falseAlarmRate: 0.2, silenceOnUnrelated: 1, errors: [],
    },
  });
  assert.equal(failing.length, 2);
  assert.ok(failing.some((f) => f.includes('falseAlarmRate')));

  const passing = checkThresholds({
    triage: { recall: 1 },
    extraction: { precision: 1, recall: 1, rejectedRecall: 1, counts: { errors: 0 } },
    conflict: { contradictionRecall: 1, falseAlarmRate: 0, silenceOnUnrelated: 1, errors: [] },
  });
  assert.deepEqual(passing, []);
});
