/**
 * Decision record → Teamwork Graph document. Pure, so its shape is tested.
 */

import { describeStatus } from './model.js';

export const SCHEMA_VERSION = '1.0';
export const OBJECT_TYPE = 'atlassian:document';

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
    // Workspace-wide by declaration; see the note at the top of this file.
    permissions: [
      {
        accessControls: [{ principals: [{ type: 'ATLASSIAN_WORKSPACE' }] }],
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
