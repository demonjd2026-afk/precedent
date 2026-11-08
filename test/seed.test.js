/**
 * Sample data integrity. Seeded decisions must meet the same bar as captured
 * ones, so these checks run before any API call: a sample record that misquotes
 * its own comment would undermine the product's central claim on first click.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SAMPLE_ITEMS } from '../src/seed/data.js';
import { quoteIsGrounded } from '../src/lib/grounding.js';
import { assertSamplesPassGate } from './helpers.js';

test('every sample quote is verbatim in its comment', () => {
  for (const item of SAMPLE_ITEMS.filter((i) => i.decision)) {
    const { comment, decision } = item;
    assert.ok(quoteIsGrounded(decision.quote, comment), `${item.ref}: decision quote`);
    for (const r of decision.rejected ?? []) assert.ok(quoteIsGrounded(r.quote, comment), `${item.ref}: rejected "${r.option}"`);
    for (const a of decision.assumptions ?? []) assert.ok(quoteIsGrounded(a.quote, comment), `${item.ref}: assumption "${a.text}"`);
  }
});

test('sample refs are unique and summaries fit Jira limits', () => {
  const refs = SAMPLE_ITEMS.map((i) => i.ref);
  assert.equal(new Set(refs).size, refs.length);
  for (const i of SAMPLE_ITEMS) assert.ok(i.summary.length <= 255, i.ref);
});

test('every lifecycle state the UI shows is represented', () => {
  const decisions = SAMPLE_ITEMS.filter((i) => i.decision).map((i) => i.decision);
  assert.ok(decisions.filter((d) => d.status === 'binding').length >= 3);
  assert.ok(decisions.some((d) => d.status === 'proposed'), 'need a proposal to confirm');
  // Staleness must come from a real, already-passed expiry, not a forced status.
  const expired = decisions.flatMap((d) => d.assumptions ?? []).filter((a) => a.expiresAt && a.expiresAt < new Date().toISOString());
  assert.ok(expired.length >= 1, 'need an expired assumption for the stale state');
  assert.ok(SAMPLE_ITEMS.filter((i) => !i.decision).length >= 1, 'need conflict bait');
});

test('every sample comment reads as a decision to the live triage gate', async () => {
  // Seeded comments are written as the app and must not be re-captured, but
  // they should still be genuine decisions the live pipeline would recognise.
  await assertSamplesPassGate();
});
