/**
 * Teamwork Graph payload shape. The graph rejects whole batches over one bad
 * field, and the rejection only surfaces after an admin connects the
 * connector, so the shape is pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGraphObject, OBJECT_TYPE } from '../src/lib/graph-object.js';
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
