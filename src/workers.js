/**
 * Async workers — where the slow, expensive work happens.
 *
 * These functions declare generous timeouts in the manifest (300s for the
 * consumers, 900s for the sweep) because async event consumers are the only
 * Forge module class that gets more than a minute. Everything in the request
 * path stays short by pushing to here.
 */

import { allocateId, putDecision, getDecision, listCitingSource } from './lib/store.js';
import { extractDecision } from './engine/extract.js';
import { checkEvidenceDrift, markStale, runSweep } from './engine/staleness.js';
import { syncDecisionToGraph } from './connector.js';
import { log } from './lib/log.js';

/**
 * Async event consumers (@forge/events 2.x+) are plain functions invoked with
 * an AsyncEvent; the pushed data lives on `event.body`. Resolvers are no
 * longer used for consumers — declaring one is what makes the queue service
 * reject pushes with a 400.
 */
function eventBody(event) {
  if (event && typeof event.body === 'object' && event.body !== null) return event.body;
  return {};
}

// ---------------------------------------------------------------------------
// Capture worker
// ---------------------------------------------------------------------------
export async function captureWorker(event) {
  const payload = event;
  const {
    text,
    sourceType,
    sourceId,
    url,
    scopeKey,
    authorId,
    occurredAt,
    triageScore,
  } = eventBody(payload);

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

  // Extract first, allocate second: non-decisions must not burn an id, or the
  // register shows gaps that look like deleted records.
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
    { id: 'PENDING', sequence: 0 }
  );

  if (!record) {
    // The lexical gate let it through and the model disagreed. That is the
    // system working: the cheap filter is tuned for recall on purpose.
    log.info('no decision in source', { sourceId, reason, triageScore });
    return { ok: true, captured: false, reason };
  }

  const allocated = await allocateId();
  record.id = allocated.id;
  record.sequence = allocated.sequence;

  await putDecision(record);
  log.info('decision captured', { id: record.id, sourceId, scope: record.scopeKey });

  return { ok: true, captured: true, id: record.id };
}

// ---------------------------------------------------------------------------
// Drift worker — runs when a cited source is edited
// ---------------------------------------------------------------------------
export async function driftWorker(event) {
  const payload = event;
  const { decisionIds = [], sourceId } = eventBody(payload);
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
}

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
