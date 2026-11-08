/**
 * Teamwork Graph payload shape. The graph rejects whole batches over one bad
 * field, and the rejection only surfaces after an admin connects the
 * connector, so the shape is pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGraphObject, graphObjectProblems, OBJECT_TYPE } from '../src/lib/graph-object.js';
import { absolutise } from '../src/lib/url.js';
import { buildDecision, STATUS } from '../src/lib/model.js';

const decision = () => ({
  ...buildDecision({
    id: 'DR-9', sequence: 9, title: 'Use DocuSign for all contract e-signatures',
    statement: 'DocuSign is the e-signature tool.', scopeKey: 'SALES',
    rejected: ['Adobe Sign'], assumptions: [{ text: 'Pricing holds' }], tags: ['e-signature'],
    deciders: ['5b10ac8d82e05b22cc7d4ef5'],
    evidence: [{ sourceType: 'jira_comment', sourceId: 'SALES-2:10', url: 'https://x.atlassian.net/browse/SALES-2', quote: 'q', contentHash: 'h', capturedAt: new Date().toISOString() }],
  }),
  status: STATUS.BINDING,
});

test('graph documents use workspace permissions, never container permissions without a container', () => {
  const obj = toGraphObject(decision());
  const principals = obj.permissions.flatMap((p) => p.accessControls.flatMap((a) => a.principals));
  assert.deepEqual(principals, [{ type: 'ATLASSIAN_WORKSPACE' }]);
  assert.ok(!principals.some((p) => p.type === 'CONTAINER' && !obj.containerKey), 'container permissions need a containerKey');
});

test('graph documents carry the fields people search for', () => {
  const obj = toGraphObject(decision());
  assert.equal(obj.id, 'DR-9');
  assert.match(obj.displayName, /^DR-9: /);
  const text = obj[OBJECT_TYPE].content.text;
  assert.match(text, /Rejected alternatives: Adobe Sign/);
  assert.match(text, /Assumes: Pricing holds/);
  assert.match(text, /Status: Binding/);
  assert.ok(obj.url.startsWith('https://'), 'the result must open the source evidence');
  assert.ok(Number.isInteger(obj.updateSequenceNumber));
});

// ---------------------------------------------------------------------------
// Regression: relative evidence URLs rejected by the graph
// ---------------------------------------------------------------------------

test('relative evidence links are made absolute against the site URL', () => {
  const base = 'https://one-atlas-eccr.atlassian.net';
  assert.equal(absolutise('/browse/LEO-13?focusedCommentId=84904', base), `${base}/browse/LEO-13?focusedCommentId=84904`);
  assert.equal(absolutise('browse/LEO-13', `${base}/`), `${base}/browse/LEO-13`);
  assert.equal(absolutise('https://other.example/x', base), 'https://other.example/x', 'absolute links are untouched');
});

test('a record captured with a relative link syncs once the site is known', () => {
  const d = decision();
  d.evidence[0].url = '/browse/LEO-13?focusedCommentId=84904';
  assert.ok(graphObjectProblems(toGraphObject(d, '')).length > 0, 'without a base it must be caught locally');
  assert.deepEqual(graphObjectProblems(toGraphObject(d, 'https://one-atlas-eccr.atlassian.net')), []);
});
