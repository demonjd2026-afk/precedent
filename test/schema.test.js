/**
 * Storage schema conformance.
 *
 * The Forge Custom Entity Store rejects a whole write (HTTP 422) if a record
 * carries a field the manifest does not declare, or an empty string. That
 * failure only shows up after a deploy, on a real comment, so these tests pull
 * it forward into `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { DECISION_ATTRIBUTES, toEntity } from '../src/lib/schema.js';
import { buildDecision } from '../src/lib/model.js';

const root = new URL('..', import.meta.url).pathname;

function manifestAttributes() {
  const text = readFileSync(join(root, 'manifest.yml'), 'utf8');
  const block = text.slice(text.indexOf('- name: decision'));
  const attrs = block.slice(block.indexOf('attributes:'), block.indexOf('indexes:'));
  const out = {};
  for (const m of attrs.matchAll(/^\s+(\w+):\s*\n\s+type:\s*(\w+)/gm)) out[m[1]] = m[2];
  return out;
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('manifest and schema module declare identical attributes and types', () => {
  assert.deepEqual(manifestAttributes(), { ...DECISION_ATTRIBUTES });
});

test('every field buildDecision produces is declared', () => {
  const record = buildDecision({
    id: 'DR-1', sequence: 1, title: 't', statement: 's', scopeKey: 'LEO',
    rejected: ['x'], assumptions: [{ text: 'a' }], deciders: ['u'], tags: ['t'],
    evidence: [], reviewAt: new Date().toISOString(), extractionScore: 0.9,
  });
  const undeclared = Object.keys(record).filter((k) => !(k in DECISION_ATTRIBUTES));
  assert.deepEqual(undeclared, []);
});

test('every field written through patchDecision is declared', () => {
  const offenders = [];
  for (const file of sourceFiles(join(root, 'src'))) {
    const code = readFileSync(file, 'utf8');
    for (const call of code.matchAll(/patchDecision\([^,]+,\s*\{([\s\S]*?)\}\s*\)/g)) {
      for (const key of call[1].matchAll(/(?:^|[,{\s])(\w+)\s*:/g)) {
        if (!(key[1] in DECISION_ATTRIBUTES)) offenders.push(`${file.replace(root, '')}: ${key[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('toEntity drops empty strings, nulls and undeclared fields', () => {
  const { value, undeclared } = toEntity({
    id: 'DR-1', title: 'ok', staleDetail: '', supersededBy: null, reviewAt: undefined,
    extractionScore: 0.95, sequence: 3, surprise: 'x', manualEntry: true, rejected: [],
  });
  assert.deepEqual(value, { id: 'DR-1', title: 'ok', extractionScore: 0.95, sequence: 3, manualEntry: true, rejected: [] });
  assert.deepEqual(undeclared, ['surprise']);
});

test('toEntity rejects wrong primitive types rather than sending them', () => {
  const { value } = toEntity({ sequence: '3', extractionScore: Number.NaN, manualEntry: 'yes' });
  assert.deepEqual(value, {});
});
