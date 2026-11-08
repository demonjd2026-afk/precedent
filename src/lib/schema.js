/**
 * The decision entity's storage schema, mirrored from manifest.yml.
 *
 * The Forge Custom Entity Store strictly enforces declared attributes and
 * types, and rejects empty strings. A record carrying one undeclared field, or
 * one empty optional string, fails the whole write with a 422. So writes go
 * through `toEntity`, and test/schema.test.js fails the build if this list and
 * the manifest ever disagree.
 */

export const DECISION_ATTRIBUTES = Object.freeze({
  id: 'string',
  sequence: 'integer',
  status: 'string',
  title: 'string',
  statement: 'string',
  rejected: 'any',
  assumptions: 'any',
  deciders: 'any',
  decidedAt: 'string',
  scopeKey: 'string',
  tags: 'any',
  evidence: 'any',
  reviewAt: 'string',
  staleReason: 'string',
  staleDetail: 'string',
  supersededBy: 'string',
  supersedeReason: 'string',
  createdAt: 'string',
  updatedAt: 'string',
  confirmedBy: 'string',
  extractionScore: 'float',
  lastVerifiedAt: 'string',
  lastSweepAt: 'string',
  manualEntry: 'boolean',
});

/**
 * Shape a record for the entity store: keep declared attributes only, and drop
 * null, undefined and empty strings. Returns the clean value and the names of
 * any undeclared fields, so the caller can log them rather than lose them
 * silently.
 *
 * @param {Record<string, unknown>} record
 * @returns {{value: Record<string, unknown>, undeclared: string[]}}
 */
export function toEntity(record) {
  const value = {};
  const undeclared = [];
  for (const [key, raw] of Object.entries(record ?? {})) {
    const type = DECISION_ATTRIBUTES[key];
    if (!type) {
      undeclared.push(key);
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (type === 'string') {
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      value[key] = raw;
    } else if (type === 'integer') {
      if (!Number.isInteger(raw)) continue;
      value[key] = raw;
    } else if (type === 'float') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      value[key] = raw;
    } else if (type === 'boolean') {
      if (typeof raw !== 'boolean') continue;
      value[key] = raw;
    } else {
      value[key] = raw;
    }
  }
  return { value, undeclared };
}
