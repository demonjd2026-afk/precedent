/**
 * Event triggers.
 *
 * These stay deliberately thin. A trigger function gets 25 seconds, and an LLM
 * call plus a store write does not reliably fit in that. So triggers do three
 * cheap things — extract text, run the free lexical gate, and push to a queue —
 * and the async consumer, which gets up to 900 seconds, does the real work.
 *
 * The gate running here rather than in the worker is the point: most comments
 * are rejected before anything is enqueued, so a busy site does not generate a
 * queue backlog or a model bill for a thousand "+1" comments a day.
 */

import { Queue } from '@forge/events';
import { triage, adfToText } from './engine/detect.js';
import { listCitingSource } from './lib/store.js';
import { log } from './lib/log.js';

const captureQueue = new Queue({ key: 'decision-capture' });
const driftQueue = new Queue({ key: 'evidence-drift' });

/**
 * Jira comments and issue updates.
 *
 * Two independent jobs happen here:
 *   - new text might contain a decision        → capture queue
 *   - edited text might be cited by a decision → drift queue
 *
 * The second is what makes evidence drift real rather than a once-a-day guess:
 * when someone edits the comment a decision was built on, we know immediately.
 */
export async function onJiraActivity(event) {
  try {
    const eventType = event?.eventType ?? '';
    const issue = event?.issue ?? {};
    const issueKey = issue.key;
    if (!issueKey) return;

    const isComment = eventType.includes('commented');
    const comment = event?.comment;

    const text = isComment
      ? adfToText(comment?.body)
      : [issue?.fields?.summary, adfToText(issue?.fields?.description)].filter(Boolean).join('\n\n');

    const sourceId = isComment && comment?.id ? `${issueKey}:${comment.id}` : issueKey;
    const sourceType = isComment ? 'jira_comment' : 'jira_issue';

    // --- Drift: is this source cited by an existing decision? ---------------
    // An edit to cited text matters even when the new text contains no decision.
    const citing = await listCitingSource(sourceId);
    if (citing.length > 0) {
      await driftQueue.push({ sourceId, sourceType, decisionIds: citing.map((d) => d.id) });
      log.info('queued drift check', { sourceId, decisions: citing.length });
    }

    // --- Capture: might this be a new decision? -----------------------------
    const gate = triage(text);
    if (!gate.proceed) {
      log.info('triage rejected', { sourceId, reason: gate.reason });
      return;
    }

    await captureQueue.push({
      text,
      sourceType,
      sourceId,
      issueKey,
      url: buildJiraUrl(event, issueKey, comment?.id),
      scopeKey: projectKeyFrom(issueKey),
      authorId: isComment ? comment?.author?.accountId : event?.atlassianId,
      occurredAt: isComment ? comment?.created : event?.timestamp,
      triageScore: gate.score,
    });

    log.info('queued capture', { sourceId, score: gate.score.toFixed(2) });
  } catch (err) {
    // A trigger that throws is retried by the platform; log enough to diagnose
    // but never let a malformed event stall the pipeline.
    log.error('jira trigger failed', { error: err?.message });
  }
}

/**
 * Confluence page updates. Same two jobs, different payload shape.
 */
export async function onConfluenceActivity(event) {
  try {
    const page = event?.content ?? event?.page ?? {};
    const pageId = page.id ?? event?.contentId;
    if (!pageId) return;

    const title = page.title ?? '';
    const body = adfToText(page?.body?.atlas_doc_format?.value ?? page?.body);
    const text = [title, body].filter(Boolean).join('\n\n');
    const sourceId = String(pageId);

    const citing = await listCitingSource(sourceId);
    if (citing.length > 0) {
      await driftQueue.push({
        sourceId,
        sourceType: 'confluence_page',
        decisionIds: citing.map((d) => d.id),
      });
      log.info('queued drift check', { sourceId, decisions: citing.length });
    }

    const gate = triage(text);
    if (!gate.proceed) return;

    await captureQueue.push({
      text,
      sourceType: 'confluence_page',
      sourceId,
      url: page?._links?.webui ?? '',
      scopeKey: page?.spaceKey ?? page?.space?.key ?? 'UNSCOPED',
      authorId: event?.atlassianId ?? page?.version?.by?.accountId,
      occurredAt: page?.version?.when ?? event?.timestamp,
      triageScore: gate.score,
    });
  } catch (err) {
    log.error('confluence trigger failed', { error: err?.message });
  }
}

/** JIRA-123 → JIRA */
function projectKeyFrom(issueKey) {
  const match = /^([A-Z][A-Z0-9]+)-\d+$/.exec(issueKey ?? '');
  return match ? match[1] : 'UNSCOPED';
}

/**
 * Build a link a human can click. Event payloads carry a self link we can
 * derive the site URL from; fall back to a relative path rather than guessing
 * a hostname, because a wrong link is worse than a short one.
 */
function buildJiraUrl(event, issueKey, commentId) {
  const self = event?.issue?.self ?? '';
  const match = /^(https:\/\/[^/]+)/.exec(self);
  const base = match ? match[1] : '';
  const path = `/browse/${issueKey}${commentId ? `?focusedCommentId=${commentId}` : ''}`;
  return `${base}${path}`;
}
