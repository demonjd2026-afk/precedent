/**
 * The decision register: all persistence for decision records.
 *
 * Backed by the Forge custom entity store so that "every stale decision in
 * project X" is an indexed query rather than a scan. Two rules hold everywhere
 * in this file:
 *
 *   1. Every list read paginates. KVS caps page size, and a register that
 *      silently truncates at 100 rows is a register nobody can trust.
 *   2. Id allocation goes through a conditional write, so two events arriving
 *      in the same second cannot both mint DR-14.
 */

import { kvs, WhereConditions, FilterConditions, Filter } from '@forge/kvs';
import { STATUS, validateDecision } from './model.js';
import { log } from './log.js';

const ENTITY = 'decision';
const SEQUENCE_KEY = 'precedent:sequence';
const MAX_PAGE = 100;

/** @returns {import('@forge/kvs').KvsEntity<import('./model.js').DecisionRecord>} */
function decisions() {
  return kvs.entity(ENTITY);
}

/**
 * Allocate the next decision id.
 *
 * Uses a read-modify-write with an optimistic retry. Forge's KVS does not give
 * us an atomic counter, so we retry on contention rather than pretend the race
 * does not exist. Ten attempts is far beyond what realistic event volume needs.
 *
 * @returns {Promise<{id: string, sequence: number}>}
 */
export async function allocateId() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = (await kvs.get(SEQUENCE_KEY)) ?? 0;
    const next = Number(current) + 1;
    try {
      await kvs.set(SEQUENCE_KEY, next);
      // Re-read to confirm we won the race. If someone else also wrote `next`,
      // the loser sees a higher value on the next pass and tries again.
      const confirmed = await kvs.get(SEQUENCE_KEY);
      if (Number(confirmed) === next) {
        return { id: `DR-${next}`, sequence: next };
      }
    } catch (err) {
      log.warn('sequence allocation retry', { attempt, error: err?.message });
    }
  }
  throw new Error('could not allocate a decision id after 10 attempts');
}

/**
 * @param {string} id
 * @returns {Promise<import('./model.js').DecisionRecord | undefined>}
 */
export async function getDecision(id) {
  return decisions().get(id);
}

/**
 * Write a record, validating first.
 * @param {import('./model.js').DecisionRecord} record
 */
export async function putDecision(record) {
  const problems = validateDecision(record);
  if (problems.length > 0) {
    throw new Error(`invalid decision record ${record.id}: ${problems.join('; ')}`);
  }
  const toWrite = { ...record, updatedAt: new Date().toISOString() };
  await decisions().set(record.id, toWrite);
  return toWrite;
}

/**
 * Apply a partial update to an existing record.
 * @param {string} id
 * @param {Partial<import('./model.js').DecisionRecord>} patch
 */
export async function patchDecision(id, patch) {
  const existing = await getDecision(id);
  if (!existing) throw new Error(`decision ${id} not found`);
  return putDecision({ ...existing, ...patch });
}

/**
 * Drain a query across every page.
 *
 * Takes a factory rather than a built query, because a query builder cannot be
 * reused once a cursor is applied.
 *
 * @param {() => import('@forge/kvs').EntityQueryBuilder<any>} buildQuery
 * @param {number} [hardLimit] Stop after this many rows.
 */
async function drain(buildQuery, hardLimit = 1000) {
  const out = [];
  let cursor;
  do {
    let q = buildQuery().limit(Math.min(MAX_PAGE, hardLimit - out.length));
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    out.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor && out.length < hardLimit);
  return out;
}

/**
 * All decisions with a given status, newest first.
 * @param {string} status
 */
export async function listByStatus(status, hardLimit = 500) {
  return drain(
    () =>
      decisions()
        .query()
        .index('by-status', { partition: [status] })
        .sort('DESC'),
    hardLimit
  );
}

/**
 * All decisions binding a given scope, newest first.
 * @param {string} scopeKey
 */
export async function listByScope(scopeKey, hardLimit = 500) {
  return drain(
    () =>
      decisions()
        .query()
        .index('by-scope', { partition: [scopeKey] })
        .sort('DESC'),
    hardLimit
  );
}

/**
 * Binding decisions whose review date has already passed.
 *
 * This is a range query on the index rather than a scan plus filter, so the
 * daily sweep stays cheap however large the register grows.
 *
 * @param {string} isoNow
 */
export async function listDueForReview(isoNow, hardLimit = 500) {
  return drain(
    () =>
      decisions()
        .query()
        .index('by-review-date', { partition: [STATUS.BINDING] })
        .where(WhereConditions.lessThanEqualTo(isoNow))
        .sort('ASC'),
    hardLimit
  );
}

/**
 * Everything the staleness sweep must inspect: all binding decisions.
 * Separate from listDueForReview because evidence drift has no date to key on.
 */
export async function listBinding(hardLimit = 1000) {
  return listByStatus(STATUS.BINDING, hardLimit);
}

/**
 * Candidate set for retrieval.
 *
 * Deliberately simple: pull the citable records for a scope (plus global ones),
 * and let the ranking layer in search.js do the semantic work. Forge KVS has no
 * vector search, so the honest design is a cheap recall step followed by a
 * model-scored precision step over a bounded candidate list — not a pretence
 * of embedding search we cannot actually run here.
 *
 * @param {string} [scopeKey]
 */
export async function listCandidates(scopeKey) {
  const binding = await listByStatus(STATUS.BINDING);
  const stale = await listByStatus(STATUS.STALE);
  const superseded = await listByStatus(STATUS.SUPERSEDED);
  const all = [...binding, ...stale, ...superseded];

  if (!scopeKey) return all;

  // Scope-matched first, then global, then everything else. The ranker sees
  // all of them but order is a useful prior when we truncate.
  const scoped = all.filter((d) => d.scopeKey === scopeKey);
  const global = all.filter((d) => d.scopeKey === 'GLOBAL' || d.scopeKey === 'UNSCOPED');
  const rest = all.filter((d) => !scoped.includes(d) && !global.includes(d));
  return [...scoped, ...global, ...rest];
}

/**
 * Pending proposals awaiting a human, for the issue panel and register.
 * @param {string} [sourceId] Limit to proposals captured from one issue or page.
 */
export async function listProposals(sourceId) {
  const proposals = await listByStatus(STATUS.PROPOSED);
  if (!sourceId) return proposals;
  return proposals.filter((d) => (d.evidence ?? []).some((e) => e.sourceId === sourceId));
}

/**
 * Find records citing a given source, so the drift checker knows what to
 * re-verify when a page or comment is edited.
 * @param {string} sourceId
 */
export async function listCitingSource(sourceId) {
  const candidates = await listBinding();
  return candidates.filter((d) => (d.evidence ?? []).some((e) => e.sourceId === sourceId));
}

/**
 * Connector bookkeeping: the active Teamwork Graph connection, if any.
 * Stored outside the entity store because it is a single small config blob.
 */
const CONNECTION_KEY = 'precedent:twg-connection';

export async function setConnection(connection) {
  await kvs.set(CONNECTION_KEY, connection);
}

export async function getConnection() {
  return kvs.get(CONNECTION_KEY);
}

export async function clearConnection() {
  await kvs.delete(CONNECTION_KEY);
}

export { FilterConditions, Filter };
