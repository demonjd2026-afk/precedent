/**
 * Teamwork Graph connector.
 *
 * This is what makes Precedent an addition to the graph rather than another
 * silo beside it. Decision records are pushed in as `atlassian:document`
 * objects, so they appear in Atlassian Search, in Rovo Chat, and to other
 * agents — including ones nobody at this company has written yet.
 *
 * Two deliberate choices:
 *
 *  - Only confirmed records are synced. A proposal that no human has approved
 *    does not belong in org-wide search; it would read as fact the moment it
 *    appeared in a search result, which is precisely the failure mode this
 *    product exists to prevent.
 *
 *  - Permissions are replicated from the scope. A decision about a private
 *    project should not surface to the whole workspace, so access controls
 *    mirror the container rather than defaulting to ATLASSIAN_WORKSPACE.
 *
 * Compliance note: the connector module's terms forbid ingesting emails,
 * calendar entries, meeting recordings, HRIS data, and regulated financial or
 * health data. Precedent ingests only decision records derived from the
 * customer's own Jira and Confluence content, which falls outside all of those
 * categories. The extraction prompt does not request personal data, and
 * deciders are stored as Atlassian account ids rather than names or emails.
 */

import { graph, types } from '@forge/teamwork-graph';
import { STATUS, describeStatus } from './lib/model.js';
import { getConnection, setConnection, clearConnection, listByStatus } from './lib/store.js';
import { log } from './lib/log.js';

const SCHEMA_VERSION = '1.0';
const OBJECT_TYPE = 'atlassian:document';

/**
 * Connection lifecycle. Atlassian calls this when an admin connects, edits or
 * disconnects the connector in Atlassian Administration.
 *
 * Atlassian deletes ingested data itself on disconnect, so there is no cleanup
 * of graph objects to do here — only our own bookkeeping.
 */
export async function onConnectionChange(request) {
  const body = request?.body ?? request ?? {};
  const { action, connectionId, name } = body;

  log.info('connector lifecycle event', { action, connectionId });

  switch (action) {
    case 'CREATED':
    case 'UPDATED': {
      await setConnection({ connectionId, name, connectedAt: new Date().toISOString() });
      // Seed the graph with whatever is already confirmed, so a newly connected
      // site is immediately useful rather than empty until the next decision.
      await backfill(connectionId);
      return { statusCode: 200 };
    }
    case 'DELETED': {
      await clearConnection();
      return { statusCode: 200 };
    }
    default:
      log.warn('unknown connector action', { action });
      return { statusCode: 200 };
  }
}

/**
 * Push every confirmed decision into the graph.
 * Batched, because setObjects accepts an array and one call per record would
 * be both slow and needlessly expensive against the ingestion rate limits.
 */
export async function backfill(connectionId) {
  const binding = await listByStatus(STATUS.BINDING);
  const stale = await listByStatus(STATUS.STALE);
  const superseded = await listByStatus(STATUS.SUPERSEDED);
  const all = [...binding, ...stale, ...superseded];

  if (all.length === 0) {
    log.info('backfill: nothing confirmed yet');
    return { ingested: 0 };
  }

  const BATCH = 50;
  let ingested = 0;
  let rejected = 0;

  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH);
    const response = await graph.setObjects({
      connectionId,
      objects: slice.map(toGraphObject),
      operationType: types.OperationType?.BACKFILL,
    });

    // Do not ignore ingestion errors. A silently rejected object is a decision
    // that will never show up in search, and nobody will notice for months.
    if (!response.success) {
      log.error('graph ingestion failed', { error: response.error, batch: i / BATCH });
      continue;
    }
    ingested += response.results?.accepted?.length ?? 0;
    const bad = response.results?.rejected ?? [];
    rejected += bad.length;
    for (const r of bad.slice(0, 3)) {
      log.warn('graph rejected object', {
        id: JSON.stringify(r.key?.entityId),
        errors: r.errors?.map((e) => e.message).join('; '),
      });
    }
  }

  log.info('backfill complete', { ingested, rejected, total: all.length });
  return { ingested, rejected };
}

/**
 * Sync one decision into the graph. Called whenever a record is confirmed,
 * superseded or flagged stale, so the graph reflects status rather than just
 * existence.
 *
 * @param {import('./lib/model.js').DecisionRecord} decision
 */
export async function syncDecisionToGraph(decision) {
  const connection = await getConnection();
  if (!connection?.connectionId) {
    // Not an error: the connector is optional and an admin may not have set it
    // up. The app works without it; the graph is an amplifier, not a dependency.
    log.info('no graph connection; skipping sync', { id: decision.id });
    return { synced: false, reason: 'no connection configured' };
  }

  if (decision.status === STATUS.PROPOSED || decision.status === STATUS.REJECTED) {
    // Unconfirmed records never reach org-wide search.
    return { synced: false, reason: 'not confirmed' };
  }

  const response = await graph.setObjects({
    connectionId: connection.connectionId,
    objects: [toGraphObject(decision)],
  });

  if (!response.success) {
    log.error('graph sync failed', { id: decision.id, error: response.error });
    return { synced: false, reason: response.error };
  }

  const rejected = response.results?.rejected ?? [];
  if (rejected.length > 0) {
    log.warn('graph rejected decision', {
      id: decision.id,
      errors: rejected[0]?.errors?.map((e) => e.message).join('; '),
    });
    return { synced: false, reason: 'rejected by graph' };
  }

  return { synced: true };
}

/**
 * Remove a decision from the graph — used when a human marks a proposal as
 * "not a decision" after it had already been confirmed and synced.
 */
export async function removeDecisionFromGraph(decisionId) {
  const connection = await getConnection();
  if (!connection?.connectionId) return { removed: false };

  const response = await graph.deleteObjectsByExternalId({
    connectionId: connection.connectionId,
    objectType: OBJECT_TYPE,
    externalIds: [decisionId],
  });

  if (!response.success) {
    log.warn('graph delete failed', { decisionId, error: response.error });
  }
  return { removed: response.success };
}

/**
 * Map a decision record onto the graph's document shape.
 *
 * The searchable text is assembled so that the things people actually search
 * for — the rejected option, the assumption, the status — are all present in
 * the indexed body, not just the title.
 *
 * @param {import('./lib/model.js').DecisionRecord} d
 * @returns {import('@forge/teamwork-graph').types.DocumentObject}
 */
export function toGraphObject(d) {
  const body = [
    d.statement,
    (d.rejected ?? []).length ? `Rejected alternatives: ${d.rejected.join('; ')}.` : '',
    (d.assumptions ?? []).length
      ? `Assumes: ${d.assumptions.map((a) => a.text).join('; ')}.`
      : '',
    `Status: ${describeStatus(d)}.`,
    d.staleDetail ? `Needs review: ${d.staleDetail}` : '',
    d.supersededBy ? `Superseded by ${d.supersededBy}.` : '',
    `Scope: ${d.scopeKey}.`,
  ]
    .filter(Boolean)
    .join('\n');

  const sourceUrl = d.evidence?.[0]?.url ?? '';

  return {
    schemaVersion: SCHEMA_VERSION,
    id: d.id,
    // The graph uses this to detect out-of-order updates. Decision records are
    // low-churn, so a second-resolution timestamp is a safe monotonic source.
    updateSequenceNumber: Math.floor(new Date(d.updatedAt).getTime() / 1000),
    displayName: `${d.id}: ${d.title}`,
    description: d.statement?.slice(0, 500),
    url: sourceUrl,
    createdAt: d.createdAt,
    lastUpdatedAt: d.updatedAt,
    createdBy: d.deciders?.[0] ? { accountId: d.deciders[0], externalId: d.deciders[0] } : undefined,
    permissions: [
      {
        accessControls: [
          {
            principals: [
              // Mirror the container rather than exposing every decision to the
              // whole workspace. CONTAINER resolves to the project or space the
              // decision is scoped to.
              d.scopeKey && d.scopeKey !== 'UNSCOPED' && d.scopeKey !== 'GLOBAL'
                ? { type: 'CONTAINER', id: d.scopeKey }
                : { type: 'ATLASSIAN_WORKSPACE' },
            ],
          },
        ],
      },
    ],
    [OBJECT_TYPE]: {
      type: {
        category: 'DOCUMENT',
        mimeType: 'text/plain',
      },
      content: {
        mimeType: 'text/plain',
        text: body,
      },
      extractedText: body,
      labels: ['decision', d.status, ...(d.tags ?? [])],
    },
  };
}
