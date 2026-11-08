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
 *  - Synced decisions are visible to everyone in the workspace. The graph only
 *    accepts container-scoped permissions on objects that point at a container
 *    the connector has itself ingested, with that container's own permission
 *    list. Precedent does not mirror Jira project permissions into the graph,
 *    so it does not pretend to: the manifest declares
 *    `replicatesPermissions: false`, which Atlassian shows to admins before
 *    they enable the connector. The in-app register and panels still read
 *    through Jira's own permissions.
 *
 * Compliance note: the connector module's terms forbid ingesting emails,
 * calendar entries, meeting recordings, HRIS data, and regulated financial or
 * health data. Precedent ingests only decision records derived from the
 * customer's own Jira and Confluence content, which falls outside all of those
 * categories. The extraction prompt does not request personal data, and
 * deciders are stored as Atlassian account ids rather than names or emails.
 */

import { graph } from '@forge/teamwork-graph';
import { toGraphObject, graphObjectProblems, OBJECT_TYPE } from './lib/graph-object.js';
import { siteUrl } from './lib/site.js';
import { STATUS } from './lib/model.js';
import { getConnection, setConnection, clearConnection, listByStatus } from './lib/store.js';
import { log } from './lib/log.js';


/**
 * Connection lifecycle. Atlassian calls this when an admin connects, edits or
 * disconnects the connector in Atlassian Administration.
 *
 * Atlassian deletes ingested data itself on disconnect, so there is no cleanup
 * of graph objects to do here — only our own bookkeeping.
 */
export async function onConnectionChange(request) {
  log.reset();
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

  const base = await siteUrl();
  const { ingested, rejected } = await ingest(connectionId, all, base);
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

  const { ingested } = await ingest(connection.connectionId, [decision], await siteUrl());
  return ingested === 1 ? { synced: true } : { synced: false, reason: 'rejected by graph' };
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

export { toGraphObject };

/**
 * Send decisions to the graph in batches. Each object is checked locally
 * first; a batch the graph still rejects is retried object by object, so one
 * bad record can never block the others.
 *
 * @returns {Promise<{ingested: number, rejected: number}>}
 */
async function ingest(connectionId, decisions, base) {
  let ingested = 0;
  let rejected = 0;

  const ready = [];
  for (const d of decisions) {
    const obj = toGraphObject(d, base);
    const problems = graphObjectProblems(obj);
    if (problems.length > 0) {
      rejected += 1;
      log.warn('skipping decision the graph would reject', { id: d.id, problems: problems.join('; ') });
    } else {
      ready.push(obj);
    }
  }

  const send = async (objects) => {
    const response = await graph.setObjects({ connectionId, objects });
    return {
      ok: response.success,
      accepted: response.results?.accepted?.length ?? 0,
      bad: response.results?.rejected ?? [],
      error: response.error,
    };
  };

  const BATCH = 50;
  for (let i = 0; i < ready.length; i += BATCH) {
    const slice = ready.slice(i, i + BATCH);
    const result = await send(slice);
    if (result.ok && result.bad.length === 0) {
      ingested += result.accepted;
      continue;
    }

    // Isolate: retry one at a time and log exactly which record fails and why.
    for (const obj of slice) {
      const single = await send([obj]);
      if (single.ok && single.bad.length === 0) {
        ingested += 1;
      } else {
        rejected += 1;
        log.warn('graph rejected decision', {
          id: obj.id,
          errors: single.bad[0]?.errors?.map((e) => e.message).join('; ') ?? single.error,
        });
      }
    }
  }
  return { ingested, rejected };
}
