import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAccounts, eraseAccount } from '../src/lib/privacy-core.js';

const rec = (over) => ({ id: 'DR-1', deciders: ['a'], updatedAt: '2026-11-01T00:00:00.000Z', ...over });

test('every stored account id is reported once, with its latest timestamp', () => {
  const accounts = collectAccounts([
    rec({ deciders: ['a', 'b'] }),
    rec({ id: 'DR-2', deciders: ['a'], confirmedBy: 'c', updatedAt: '2026-11-05T00:00:00.000Z' }),
  ]);
  const byId = Object.fromEntries(accounts.map((a) => [a.accountId, a.updatedAt]));
  assert.deepEqual(Object.keys(byId).sort(), ['a', 'b', 'c']);
  assert.equal(byId.a, '2026-11-05T00:00:00.000Z');
});

test('a closed account is removed from deciders and confirmedBy', () => {
  const cleaned = eraseAccount(rec({ deciders: ['a', 'b'], confirmedBy: 'a' }), 'a');
  assert.deepEqual(cleaned.deciders, ['b']);
  assert.equal('confirmedBy' in cleaned, false);
});

test('records without the account are left untouched', () => {
  assert.equal(eraseAccount(rec({ deciders: ['b'] }), 'a'), null);
});

// ---------------------------------------------------------------------------
// The developer must never receive customer content or account ids in logs.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

test('no log call carries account ids or quoted customer text', () => {
  const root = new URL('../src', import.meta.url).pathname;
  const files = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
  });
  const offenders = [];
  for (const file of files(root)) {
    const code = readFileSync(file, 'utf8');
    for (const call of code.matchAll(/log\.(?:info|warn|error)\([^;]*?\);/gs)) {
      if (/accountId|\bquote\s*:|\bsample\s*:|\btext\s*:|\bstatement\s*:|context\?\.accountId/.test(call[0])) {
        offenders.push(`${file.replace(root, 'src')}: ${call[0].slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
