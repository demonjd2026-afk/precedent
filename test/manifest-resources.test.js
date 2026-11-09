/**
 * Manifest resource references. A broken icon reference does not fail deploy:
 * Jira silently shows a generic icon instead. These checks catch it locally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const manifest = readFileSync(join(root, 'manifest.yml'), 'utf8');

function resources() {
  const block = manifest.slice(manifest.lastIndexOf('\nresources:'));
  const out = {};
  for (const m of block.matchAll(/- key:\s*([\w-]+)\s*\n\s*path:\s*(\S+)/g)) out[m[1]] = m[2];
  return out;
}

test('every resource: icon reference points at a real file in a declared resource', () => {
  const declared = resources();
  const refs = [...manifest.matchAll(/resource:([\w-]+);([^\s'"]+)/g)];
  assert.ok(refs.length > 0, 'expected at least one resource icon');
  for (const [, key, file] of refs) {
    assert.ok(declared[key], `resource "${key}" is not declared`);
    const p = join(root, declared[key], file);
    assert.ok(existsSync(p), `${key};${file} → ${p} does not exist`);
  }
});

test('static (non-UI Kit) resource folders have an index.html entry point', () => {
  for (const [key, path] of Object.entries(resources())) {
    const p = join(root, path);
    if (!existsSync(p) || !statSync(p).isDirectory() || path.startsWith('resources/')) continue;
    assert.ok(existsSync(join(p, 'index.html')), `static resource "${key}" (${path}) has no index.html`);
  }
});
