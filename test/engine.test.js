/**
 * Tests for the pure logic — the parts that decide what reaches the register.
 *
 * These modules deliberately have no Forge imports so they can be tested
 * without a deployed app. The triage gate and the drift classifier are where
 * the product's accuracy lives, so they are the parts worth pinning down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { triage, adfToText } from '../src/engine/detect.js';
import { normalise, similarity, classifyDrift } from '../src/lib/hash.js';
import { inScope } from '../src/lib/store.js';
import { quoteIsGrounded } from '../src/lib/grounding.js';
import { validateDecision, buildDecision, describeStatus, evidenceMatches, partitionBySource, projectKeysOf, visibleTo, STATUS, STALE_REASON } from '../src/lib/model.js';

// ---------------------------------------------------------------------------
// Triage: the free gate in front of the paid model call
// ---------------------------------------------------------------------------

test('triage accepts a settled decision', () => {
  const r = triage("After comparing both, we're going with Postgres instead of DynamoDB for the ledger store.");
  assert.equal(r.proceed, true);
  assert.ok(r.score > 0.3);
});

test('triage accepts a decision even when hedged', () => {
  // Real decisions often arrive with a caveat attached. Hedges lower the score
  // but must never veto, or we lose exactly the subtle cases that matter.
  const r = triage("We've decided to go ahead with the Stripe migration, though I'm not sure about the timeline.");
  assert.equal(r.proceed, true);
});

test('triage rejects an open proposal', () => {
  const r = triage('Should we move the ledger to Postgres? Keen to hear thoughts before we commit to anything.');
  assert.equal(r.proceed, false);
  assert.match(r.reason, /no decision language/);
});

test('triage rejects acknowledgements', () => {
  for (const noise of ['LGTM', '+1', 'thanks!', 'done']) {
    assert.equal(triage(noise).proceed, false, `should reject: ${noise}`);
  }
});

test('triage rejects text that is too short to carry a decision', () => {
  assert.equal(triage('we decided').proceed, false);
});

test('triage rejects automation noise that contains decision words', () => {
  const r = triage('[automated] The approval automation rule was executed and the request was approved successfully.');
  assert.equal(r.proceed, false);
});

// ---------------------------------------------------------------------------
// ADF extraction: comments arrive as a node tree, not a string
// ---------------------------------------------------------------------------

test('adfToText pulls prose out of an ADF document and ignores structure', () => {
  const adf = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'We are going with Postgres.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'DynamoDB was ruled out on cost.' }] },
    ],
  };
  const text = adfToText(adf);
  assert.match(text, /We are going with Postgres\./);
  assert.match(text, /ruled out on cost/);
  // Field names from the JSON must not leak into the text we hash and triage.
  assert.doesNotMatch(text, /paragraph|version|content/);
});

test('adfToText keeps block boundaries so sentences do not merge', () => {
  const adf = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
    ],
  };
  assert.notEqual(adfToText(adf), 'FirstSecond');
});

// ---------------------------------------------------------------------------
// Evidence drift: the mechanism behind "the ground moved"
// ---------------------------------------------------------------------------

test('normalise ignores markup and whitespace churn', () => {
  const a = '<p>We&nbsp;are   going with <strong>Postgres</strong>.</p>';
  const b = 'We are going with Postgres.';
  assert.equal(normalise(a), normalise(b));
});

test('reformatting alone is not drift', () => {
  const original = 'We are going with Postgres for the ledger store because of transactional guarantees.';
  const reformatted = '<p>We are going with Postgres for the ledger store\n  because of transactional guarantees.</p>';
  const result = classifyDrift(original, reformatted);
  assert.equal(result.changed, false, 'an editor reflowing a page must not flag every decision');
});

test('a substantive rewrite is drift', () => {
  const original = 'We are going with Postgres for the ledger store because of transactional guarantees.';
  const rewritten = 'The team has moved the ledger onto DynamoDB after the cost review in October.';
  const result = classifyDrift(original, rewritten);
  assert.equal(result.changed, true);
  assert.equal(result.severity, 'rewritten');
});

test('a small edit is noted but not escalated', () => {
  const original =
    'We are going with Postgres for the ledger store because of its transactional guarantees and mature tooling.';
  const edited =
    'We are going with Postgres for the ledger store because of its transactional guarantees and mature tooling and support.';
  const result = classifyDrift(original, edited);
  assert.equal(result.severity, 'edited');
});

test('similarity is symmetric and bounded', () => {
  const a = 'the quick brown fox jumps over the lazy dog';
  const b = 'the quick brown fox leaps over the lazy dog';
  const ab = similarity(a, b);
  assert.equal(ab, similarity(b, a));
  assert.ok(ab > 0 && ab < 1);
  assert.equal(similarity(a, a), 1);
});

// ---------------------------------------------------------------------------
// Record validation: nothing malformed reaches the graph
// ---------------------------------------------------------------------------

function validRecord() {
  return {
    ...buildDecision({
      id: 'DR-1',
      sequence: 1,
      title: 'Use Postgres for the ledger store',
      statement: 'Postgres was chosen over DynamoDB for transactional guarantees.',
      scopeKey: 'LEDGER',
      evidence: [
        {
          sourceType: 'jira_comment',
          sourceId: 'LEDGER-12:1001',
          url: 'https://example.atlassian.net/browse/LEDGER-12',
          quote: 'we are going with Postgres',
          contentHash: 'abc123',
          capturedAt: new Date().toISOString(),
        },
      ],
    }),
  };
}

test('a well-formed record validates', () => {
  assert.deepEqual(validateDecision(validRecord()), []);
});

test('a captured record with no evidence is rejected', () => {
  const r = { ...validRecord(), evidence: [] };
  assert.ok(validateDecision(r).some((p) => /evidence/.test(p)));
});

test('evidence without a hash is rejected', () => {
  const r = validRecord();
  r.evidence[0].contentHash = '';
  assert.ok(validateDecision(r).some((p) => /contentHash/.test(p)));
});

test('a stale record must explain why it is stale', () => {
  const r = { ...validRecord(), status: STATUS.STALE };
  assert.ok(validateDecision(r).some((p) => /staleReason/.test(p)));
});

test('a superseded record must name its replacement', () => {
  const r = { ...validRecord(), status: STATUS.SUPERSEDED };
  assert.ok(validateDecision(r).some((p) => /superseded/i.test(p)));
});

test('extraction always lands as a proposal, never as binding', () => {
  // The human-in-the-loop guarantee, asserted rather than assumed.
  assert.equal(buildDecision({ id: 'DR-2', title: 't', statement: 's' }).status, STATUS.PROPOSED);
});

test('status descriptions explain the cause, not just the state', () => {
  const stale = {
    ...validRecord(),
    status: STATUS.STALE,
    staleReason: STALE_REASON.EVIDENCE_DRIFT,
  };
  assert.match(describeStatus(stale), /source/i);
  assert.match(describeStatus({ ...validRecord(), status: STATUS.PROPOSED }), /confirmation/i);
});

// ---------------------------------------------------------------------------
// Grounding: regression for the first live capture
// ---------------------------------------------------------------------------

test('grounding accepts a quote whose apostrophes differ only typographically', () => {
  // Jira stored the comment with a curly apostrophe; the model quoted it back
  // with a straight one. The quote is verbatim and must be accepted.
  const source = 'Update after today\u2019s call: we\u2019ve decided to use the standard mutual NDA template.';
  const quote = "we've decided to use the standard mutual NDA template";
  assert.equal(quoteIsGrounded(quote, source), true);
});

test('grounding folds curly double quotes and dashes', () => {
  const source = 'We chose the \u201cstandard\u201d template \u2014 not custom terms.';
  assert.equal(quoteIsGrounded('We chose the "standard" template - not custom terms', source), true);
});

test('grounding still rejects a fabricated quote', () => {
  const source = 'We\u2019ve decided to use the standard mutual NDA template.';
  assert.equal(quoteIsGrounded("We've decided to negotiate custom terms for every vendor", source), false);
});

// ---------------------------------------------------------------------------
// Source matching: regression for the empty issue panel
// ---------------------------------------------------------------------------

test('a decision captured from a comment matches its issue', () => {
  assert.equal(evidenceMatches({ sourceId: 'LEO-13:84904' }, 'LEO-13'), true);
  assert.equal(evidenceMatches({ sourceId: 'LEO-13' }, 'LEO-13'), true);
  assert.equal(evidenceMatches({ sourceId: 'LEO-13:84904' }, 'LEO-13:84904'), true);
});

test('source matching does not leak across similar issue keys', () => {
  assert.equal(evidenceMatches({ sourceId: 'LEO-130:1' }, 'LEO-13'), false);
  assert.equal(evidenceMatches({ sourceId: 'LEO-1:5' }, 'LEO-13'), false);
  assert.equal(evidenceMatches({}, 'LEO-13'), false);
});

// ---------------------------------------------------------------------------
// Logging budget: regression for silenced logs in warm containers
// ---------------------------------------------------------------------------

test('log budget resets between invocations', async () => {
  const { log } = await import('../src/lib/log.js');
  const original = console.log;
  const originalWarn = console.warn;
  let printed = 0;
  console.log = () => { printed += 1; };
  console.warn = () => {};
  try {
    log.reset();
    for (let i = 0; i < 200; i += 1) log.info('noise');
    const firstRun = printed;
    log.reset(); // next invocation in the same warm container
    printed = 0;
    log.info('must not be suppressed');
    assert.ok(firstRun < 200, 'budget should cap a noisy invocation');
    assert.equal(printed, 1, 'a new invocation must log again');
  } finally {
    console.log = original;
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// Scope: regression for cross-project conflict warnings
// ---------------------------------------------------------------------------

test('a decision binds its own scope and org-wide decisions bind everywhere', () => {
  assert.equal(inScope({ scopeKey: 'SALES' }, 'SALES'), true);
  assert.equal(inScope({ scopeKey: 'GLOBAL' }, 'SALES'), true);
  assert.equal(inScope({ scopeKey: 'LEO' }, 'SALES'), false, "Legal's decisions must not bind Sales' work");
});

// ---------------------------------------------------------------------------
// Self-conflict: regression for an issue flagged against its own decision
// ---------------------------------------------------------------------------

test('an issue is never checked against a decision made on it', () => {
  const own = { id: 'DR-6', evidence: [{ sourceId: 'KAN-9:10021' }] };
  const other = { id: 'DR-2', evidence: [{ sourceId: 'KAN-3:10004' }] };
  const lookalike = { id: 'DR-7', evidence: [{ sourceId: 'KAN-90:10050' }] };
  const { kept, excluded } = partitionBySource([own, other, lookalike], 'KAN-9');
  assert.deepEqual(excluded.map((d) => d.id), ['DR-6']);
  assert.deepEqual(kept.map((d) => d.id), ['DR-2', 'DR-7'], 'KAN-90 is a different issue from KAN-9');
});

test('without a source key nothing is excluded', () => {
  const ds = [{ id: 'DR-1', evidence: [{ sourceId: 'KAN-1' }] }];
  assert.deepEqual(partitionBySource(ds, undefined), { kept: ds, excluded: [] });
});

// ---------------------------------------------------------------------------
// Access: decisions are shown only to people who can browse every project they
// draw on
// ---------------------------------------------------------------------------

test('a decision draws on its scope project and the projects of every quoted issue', () => {
  const d = { scopeKey: 'SALES', evidence: [{ sourceId: 'SALES-4:100' }, { sourceId: 'LEGAL-9:200' }] };
  assert.deepEqual(projectKeysOf(d).sort(), ['LEGAL', 'SALES']);
});

test('non-project scopes and manual evidence add no project', () => {
  assert.deepEqual(projectKeysOf({ scopeKey: 'GLOBAL', evidence: [{ sourceId: 'manual:1731400000' }] }), []);
  assert.deepEqual(projectKeysOf({ scopeKey: 'UNSCOPED' }), []);
});

test('a user sees a decision only if they can browse every project it draws on', () => {
  const crossProject = { scopeKey: 'SALES', evidence: [{ sourceId: 'LEGAL-9:200' }] };
  assert.equal(visibleTo(crossProject, new Set(['SALES'])), false, 'quotes a Legal issue the user cannot see');
  assert.equal(visibleTo(crossProject, new Set(['SALES', 'LEGAL'])), true);
  assert.equal(visibleTo({ scopeKey: 'LEGAL', evidence: [] }, new Set()), false, 'fails closed with no browsable projects');
});
