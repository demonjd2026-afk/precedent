/**
 * Staleness: the part that makes this a memory rather than an archive.
 *
 * A decision log that only ever accumulates is a graveyard — technically
 * complete, practically ignored, because nobody knows which entries still
 * apply. Precedent runs three checks against every binding decision:
 *
 *   1. Expiry           — an assumption carried a date and the date has passed.
 *   2. Evidence drift   — the source the decision was based on has been edited
 *                         since capture. The decision text is untouched, but
 *                         the ground under it moved.
 *   3. Dangling refs    — a cited ticket or page no longer resolves.
 *
 * Check 3 needs the Teamwork Graph, which needs a user context, which a
 * scheduled trigger does not have. Rather than pretend otherwise, the sweep
 * records that the check was skipped and the register verifies it the next
 * time a human opens it. Being explicit about what was not checked is the
 * whole point of a tool that claims to tell you what is trustworthy.
 */

import api, { route } from '@forge/api';
import { STATUS, STALE_REASON } from '../lib/model.js';
import { listBinding, listDueForReview, patchDecision } from '../lib/store.js';
import { classifyDrift, contentHash } from '../lib/hash.js';
import { adfToText } from './detect.js';
import { log } from '../lib/log.js';

/**
 * Re-read a source document as plain text, for drift comparison.
 *
 * Returns null when the source cannot be read, which the caller must treat as
 * "unknown", never as "unchanged" and never as "deleted" — a 500 from Jira is
 * not evidence that a decision has gone bad.
 *
 * @param {import('../lib/model.js').Evidence} evidence
 * @returns {Promise<{text: string|null, missing: boolean}>}
 */
export async function readSource(evidence) {
  try {
    if (evidence.sourceType === 'jira_comment') {
      // sourceId is "ISSUEKEY:COMMENTID".
      const [issueKey, commentId] = evidence.sourceId.split(':');
      const res = await api
        .asApp()
        .requestJira(route`/rest/api/3/issue/${issueKey}/comment/${commentId}`);
      if (res.status === 404) return { text: null, missing: true };
      if (!res.ok) return { text: null, missing: false };
      const body = await res.json();
      return { text: adfToText(body?.body), missing: false };
    }

    if (evidence.sourceType === 'jira_issue') {
      const res = await api
        .asApp()
        .requestJira(route`/rest/api/3/issue/${evidence.sourceId}?fields=summary,description`);
      if (res.status === 404) return { text: null, missing: true };
      if (!res.ok) return { text: null, missing: false };
      const body = await res.json();
      const summary = body?.fields?.summary ?? '';
      const description = adfToText(body?.fields?.description);
      return { text: `${summary}\n\n${description}`, missing: false };
    }

    // Confluence sources cannot be re-read over REST from a Jira-only install,
    // so they report as unverified rather than as unchanged.
    return { text: null, missing: false };
  } catch (err) {
    log.warn('could not re-read source', {
      sourceId: evidence.sourceId,
      type: evidence.sourceType,
      error: err?.message,
    });
    return { text: null, missing: false };
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Check one decision for evidence drift.
 *
 * @param {import('../lib/model.js').DecisionRecord} decision
 * @returns {Promise<{stale: boolean, reason?: string, detail?: string, unverified: boolean}>}
 */
export async function checkEvidenceDrift(decision) {
  let unverified = false;

  for (const evidence of decision.evidence ?? []) {
    const { text, missing } = await readSource(evidence);

    if (missing) {
      return {
        stale: true,
        reason: STALE_REASON.DANGLING_REFERENCE,
        detail: `The source this decision cites no longer exists (${evidence.sourceId}).`,
        unverified: false,
      };
    }

    if (text === null) {
      unverified = true;
      continue;
    }

    const currentHash = await contentHash(text);
    if (currentHash === evidence.contentHash) continue;

    // Hash moved. Decide whether it moved meaningfully.
    const drift = classifyDrift(evidence.quote, text);

    // The decisive test: can we still find the quoted span? If the exact words
    // the decision rests on are gone, the basis is gone, whatever else changed.
    const quoteStillPresent = text.toLowerCase().includes(evidence.quote.toLowerCase().slice(0, 60));

    if (!quoteStillPresent) {
      return {
        stale: true,
        reason: STALE_REASON.EVIDENCE_DRIFT,
        detail:
          `The text this decision was based on has been rewritten. ` +
          `The passage it quoted is no longer present in ${evidence.sourceId}.`,
        unverified: false,
      };
    }

    if (drift.severity === 'rewritten') {
      return {
        stale: true,
        reason: STALE_REASON.EVIDENCE_DRIFT,
        detail:
          `The source has changed substantially since this decision was captured ` +
          `(about ${Math.round((1 - drift.similarity) * 100)}% of the wording differs).`,
        unverified: false,
      };
    }

    // An edit that left the quoted basis intact: record it, do not raise it.
    log.info('minor source edit, not flagging', {
      id: decision.id,
      sourceId: evidence.sourceId,
      similarity: drift.similarity.toFixed(2),
    });
  }

  return { stale: false, unverified };
}

/**
 * Check whether an explicit review date has passed.
 * @param {import('../lib/model.js').DecisionRecord} decision
 * @param {string} isoNow
 */
export function checkExpiry(decision, isoNow) {
  const expired = (decision.assumptions ?? []).filter(
    (a) => a.expiresAt && a.expiresAt <= isoNow
  );

  if (expired.length > 0) {
    return {
      stale: true,
      reason: STALE_REASON.EXPIRED,
      detail:
        expired.length === 1
          ? `An assumption behind this decision was due for recheck: "${expired[0].text}".`
          : `${expired.length} assumptions behind this decision are due for recheck.`,
    };
  }

  if (decision.reviewAt && decision.reviewAt <= isoNow) {
    return {
      stale: true,
      reason: STALE_REASON.EXPIRED,
      detail: 'This decision has passed its scheduled review date.',
    };
  }

  return { stale: false };
}

/**
 * The daily sweep. Runs without a user, so it does expiry and drift only.
 *
 * @returns {Promise<{examined: number, flagged: number, unverified: number}>}
 */
export async function runSweep() {
  const isoNow = new Date().toISOString();
  const binding = await listBinding();

  let flagged = 0;
  let unverified = 0;

  for (const decision of binding) {
    // Cheap check first; if it is already expired there is no need to spend
    // REST calls re-reading sources.
    const expiry = checkExpiry(decision, isoNow);
    if (expiry.stale) {
      await markStale(decision, expiry.reason, expiry.detail);
      flagged += 1;
      continue;
    }

    const drift = await checkEvidenceDrift(decision);
    if (drift.stale) {
      await markStale(decision, drift.reason, drift.detail);
      flagged += 1;
      continue;
    }

    if (drift.unverified) {
      unverified += 1;
      await patchDecision(decision.id, { lastVerifiedAt: null, lastSweepAt: isoNow });
    } else {
      await patchDecision(decision.id, { lastVerifiedAt: isoNow, lastSweepAt: isoNow });
    }
  }

  log.info('staleness sweep complete', { examined: binding.length, flagged, unverified });
  return { examined: binding.length, flagged, unverified };
}

/**
 * @param {import('../lib/model.js').DecisionRecord} decision
 * @param {string} reason
 * @param {string} detail
 */
export async function markStale(decision, reason, detail) {
  log.info('flagging decision stale', { id: decision.id, reason });
  return patchDecision(decision.id, {
    status: STATUS.STALE,
    staleReason: reason,
    staleDetail: detail,
    lastSweepAt: new Date().toISOString(),
  });
}

/**
 * Decisions whose review date has passed, for the "needs review" view.
 * @param {string} [scopeKey]
 */
export async function dueForReview(scopeKey) {
  const isoNow = new Date().toISOString();
  const due = await listDueForReview(isoNow);
  return scopeKey ? due.filter((d) => d.scopeKey === scopeKey) : due;
}
