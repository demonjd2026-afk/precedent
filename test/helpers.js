import assert from 'node:assert/strict';
import { triage } from '../src/engine/detect.js';
import { SAMPLE_ITEMS } from '../src/seed/data.js';

/** Every sample comment must read as a decision to the live gate. */
export async function assertSamplesPassGate() {
  for (const item of SAMPLE_ITEMS.filter((i) => i.comment)) {
    assert.equal(triage(item.comment).proceed, true, `${item.ref} would not pass the gate`);
  }
}
