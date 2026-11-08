/**
 * Async workers — where the slow, expensive work happens.
 *
 * These functions declare generous timeouts in the manifest (300s for the
 * consumers, 900s for the sweep) because async event consumers are the only
 * Forge module class that gets more than a minute. Everything in the request
 * path stays short by pushing to here.
 */

import Resolver from '@forge/resolver';
import { allocateId, putDecision, getDecision, listCitingSource } from './lib/store.js';
import { extractDecision } from './engine/extract.js';
import { checkEvidenceDrift, markStale, runSweep } from './engine/staleness.js';
import { syncDecisionToGraph } from './connector.js';
import { log } from './lib/log.js';

// ---------------------------------------------------------------------------
// Capture worker
// ---------------------------------------------------------------------------
const captureResolver = new Resolver();

captureResolver.define('capture-event', async ({ payload }) => {
  const {
    text,
    sourceType,
    sourceId,
    url,
    scopeKey,
    authorId,
    occurredAt,
    triageScore,
  } = payload ?? {};

  if (!text || !sourceId) {
    log.warn('capture event missing required fields', { sourceId });
    return { ok: false };
  }

  // Guard against double-capture. The platform may redeliver an event, and a
  // register with the same decision recorded twice is immediately untrustworthy.
  const existing = await listCitingSource(sourceId);
  if (existing.length > 0) {
    log.info('source already captured, skipping', { sourceId, existing: existing[0].id });
    return { ok: true, skipped: 'already captured' };
  }

  const allocated = await allocateId();

  const { record, reason } = await extractDecision(
    {
      text,
      sourceType,
      sourceId,
      url: url ?? '',
      scopeKey: scopeKey ?? 'UNSCOPED',
      deciders: authorId ? [authorId] : [],
      decidedAt: occurredAt,
    },
    allocated
  );

  if (!record) {
    // The lexical gate let it through and the model disagreed. That is the
    // system working: the cheap filter is tuned for recall on purpose.
    log.info('no decision in source', { sourceId, reason, triageScore });
    return { ok: true, captured: false, reason };
  }

  await putDecision(record);
  log.info('decision captured', { id: record.id, sourceId, scope: record.scopeKey });

  return { ok: true, captured: true, id: record.id };
});

export const captureWorker = captureResolver.getDefinitions();

// ---------------------------------------------------------------------------
// Drift worker — runs when a cited source is edited
// ---------------------------------------------------------------------------
const driftResolver = new Resolver();

driftResolver.define('drift-event', async ({ payload }) => {
  const { decisionIds = [], sourceId } = payload ?? {};
  let flagged = 0;

  for (const id of decisionIds) {
    const decision = await getDecision(id);
    if (!decision) continue;

    const result = await checkEvidenceDrift(decision);
    if (result.stale) {
      await markStale(decision, result.reason, result.detail);
      flagged += 1;

      // Push the status change into the graph so Search and other agents see
      // the warning too, not just our own panel.
      await syncDecisionToGraph({ ...decision, status: 'stale', staleDetail: result.detail }).catch(
        (err) => log.warn('graph sync after drift failed', { id, error: err?.message })
      );
    }
  }

  log.info('drift check complete', { sourceId, examined: decisionIds.length, flagged });
  return { ok: true, flagged };
});

export const driftWorker = driftResolver.getDefinitions();

// ---------------------------------------------------------------------------
// Daily staleness sweep
// ---------------------------------------------------------------------------
export async function stalenessSweep() {
  log.reset();
  const started = Date.now();
  try {
    const result = await runSweep();
    log.info('sweep finished', { ...result, ms: Date.now() - started });
    return result;
  } catch (err) {
    log.error('sweep failed', { error: err?.message, ms: Date.now() - started });
    throw err;
  }
}
