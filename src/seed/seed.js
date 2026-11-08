/**
 * Load and remove sample data.
 *
 * Runs on an async consumer: a dozen Jira calls do not fit a 25-second
 * resolver. The resolver queues a job and the register page polls the status
 * stored here.
 *
 * Everything created is recorded in the seed state, so removal deletes exactly
 * what was made and nothing else, whether or not the label could be applied.
 */

import api, { route } from '@forge/api';
import { Queue } from '@forge/events';

import { SAMPLE_ITEMS, SAMPLE_LABEL } from './data.js';
import { buildDecision, STATUS, SOURCE_TYPE } from '../lib/model.js';
import { contentHash } from '../lib/hash.js';
import { quoteIsGrounded } from '../lib/grounding.js';
import {
  allocateId, putDecision, getDecision, deleteDecision,
  getState, setState, deleteState,
} from '../lib/store.js';
import { checkExpiry, markStale } from '../engine/staleness.js';
import { syncDecisionToGraph, removeDecisionFromGraph } from '../connector.js';
import { log } from '../lib/log.js';

const STATE_KEY = 'precedent:seed';
const SKIP_PREFIX = 'precedent:seed:skip:';
const seedQueue = new Queue({ key: 'precedent-seed' });

// ---------------------------------------------------------------------------
// Public API (called from the register page's resolver)
// ---------------------------------------------------------------------------

export async function seedStatus() {
  return (await getState(STATE_KEY)) ?? { status: 'idle' };
}

/** Projects the current user can create work in, for the picker. */
export async function listProjects() {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/project/search?maxResults=50&orderBy=name&action=create`);
  if (!res.ok) return { projects: [], error: `Could not list projects (HTTP ${res.status}).` };
  const body = await res.json();
  return {
    projects: (body.values ?? []).map((p) => ({ key: p.key, name: p.name, type: p.projectTypeKey })),
  };
}

export async function requestLoad(projectKey) {
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(projectKey ?? '')) return { error: 'Choose a project first.' };
  const current = await seedStatus();
  if (['queued', 'loading', 'removing'].includes(current.status)) return { error: 'A sample-data job is already running.' };
  if (current.status === 'loaded') return { error: `Sample data is already loaded in ${current.projectKey}. Remove it first.` };

  await setState(STATE_KEY, { status: 'queued', projectKey, queuedAt: now() });
  await seedQueue.push({ body: { action: 'load', projectKey } });
  return { ok: true };
}

export async function requestRemove() {
  const current = await seedStatus();
  if (!['loaded', 'failed'].includes(current.status)) return { error: 'There is no sample data to remove.' };
  await setState(STATE_KEY, { ...current, status: 'removing', progress: 'Queued' });
  await seedQueue.push({ body: { action: 'remove' } });
  return { ok: true };
}

/**
 * True when a comment was written by the seeder. The capture worker checks this
 * so sample comments are never re-captured, even if the platform delivers the
 * app's own events despite `ignoreSelf`.
 */
export async function isSeededSource(sourceId) {
  return Boolean(await getState(`${SKIP_PREFIX}${sourceId}`));
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export async function seedWorker(event) {
  log.reset();
  const { action, projectKey } = event?.body ?? {};
  if (action === 'load') return load(projectKey);
  if (action === 'remove') return remove();
  log.warn('unknown seed action', { action });
}

async function load(projectKey) {
  const state = { status: 'loading', projectKey, startedAt: now(), issues: [], decisionIds: [] };
  const save = (progress) => setState(STATE_KEY, { ...state, progress });

  try {
    await save('Finding a work type');
    const issueTypeId = await pickIssueType(projectKey);

    let n = 0;
    for (const item of SAMPLE_ITEMS) {
      n += 1;
      await save(`Creating work item ${n} of ${SAMPLE_ITEMS.length}`);
      const issue = await createIssue(projectKey, issueTypeId, item);
      const record = { ref: item.ref, key: issue.key, labelled: issue.labelled };
      state.issues.push(record);

      if (!item.comment) continue;

      const comment = await addComment(issue.key, item.comment);
      record.commentId = comment.id;
      const sourceId = `${issue.key}:${comment.id}`;
      // Mark before anything else can observe the comment.
      await setState(`${SKIP_PREFIX}${sourceId}`, true);

      const decision = await recordDecision(item, {
        sourceId,
        url: `${issue.siteUrl}/browse/${issue.key}?focusedCommentId=${comment.id}`,
        scopeKey: projectKey,
      });
      state.decisionIds.push(decision.id);
    }

    await setState(STATE_KEY, {
      ...state,
      status: 'loaded',
      progress: undefined,
      finishedAt: now(),
    });
    log.info('sample data loaded', { projectKey, issues: state.issues.length, decisions: state.decisionIds.length });
  } catch (err) {
    log.error('sample data load failed', { projectKey, error: err?.message });
    // Keep what was created, so "Remove sample data" can still clean it up.
    await setState(STATE_KEY, { ...state, status: 'failed', error: err?.message ?? String(err), finishedAt: now() });
  }
}

async function remove() {
  const state = await seedStatus();
  const save = (progress) => setState(STATE_KEY, { ...state, status: 'removing', progress });
  const problems = [];

  let n = 0;
  for (const id of state.decisionIds ?? []) {
    n += 1;
    await save(`Removing decision ${n} of ${state.decisionIds.length}`);
    await removeDecisionFromGraph(id).catch(() => {});
    await deleteDecision(id).catch((err) => problems.push(`${id}: ${err?.message}`));
  }

  n = 0;
  for (const issue of state.issues ?? []) {
    n += 1;
    await save(`Removing work item ${n} of ${state.issues.length}`);
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issue.key}?deleteSubtasks=true`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) problems.push(`${issue.key}: HTTP ${res.status}`);
    if (issue.commentId) await deleteState(`${SKIP_PREFIX}${issue.key}:${issue.commentId}`);
  }

  if (problems.length > 0) {
    log.warn('sample removal incomplete', { problems: problems.join('; ') });
    await setState(STATE_KEY, { ...state, status: 'failed', error: `Could not remove: ${problems.join('; ')}` });
  } else {
    await deleteState(STATE_KEY);
    log.info('sample data removed', { projectKey: state.projectKey });
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function pickIssueType(projectKey) {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`);
  if (!res.ok) throw new Error(`Could not read work types for ${projectKey} (HTTP ${res.status}). Does the app have access to this project?`);
  const body = await res.json();
  // The field is `issueTypes` on some Jira versions and `values` on others.
  const types = (body.issueTypes ?? body.values ?? []).filter((t) => !t.subtask);
  const chosen = types.find((t) => t.name === 'Task') ?? types[0];
  if (!chosen) throw new Error(`${projectKey} has no work type that can be created.`);
  return chosen.id;
}

const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function createIssue(projectKey, issueTypeId, item) {
  const fields = {
    project: { key: projectKey },
    issuetype: { id: issueTypeId },
    summary: item.summary,
    description: adf(item.description),
  };

  // Labels are a convenience, not a dependency: some business spaces leave the
  // field off the create screen, which rejects the whole request. Retry
  // without it; removal works from recorded keys either way.
  let res = await post(route`/rest/api/3/issue`, { fields: { ...fields, labels: [SAMPLE_LABEL] } });
  let labelled = true;
  if (res.status === 400) {
    res = await post(route`/rest/api/3/issue`, { fields });
    labelled = false;
  }
  if (!res.ok) throw new Error(`Could not create "${item.summary}" (HTTP ${res.status}): ${await res.text()}`);

  const body = await res.json();
  const siteUrl = /^(https:\/\/[^/]+)/.exec(body.self ?? '')?.[1] ?? '';
  return { key: body.key, siteUrl, labelled };
}

async function addComment(issueKey, text) {
  const res = await post(route`/rest/api/3/issue/${issueKey}/comment`, { body: adf(text) });
  if (!res.ok) throw new Error(`Could not comment on ${issueKey} (HTTP ${res.status})`);
  return res.json();
}

async function post(path, body) {
  return api.asApp().requestJira(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Write the decision with the same guarantees as live capture: every quote is
 * checked against the comment text and the evidence carries a real hash.
 */
async function recordDecision(item, { sourceId, url, scopeKey }) {
  const { decision: d, comment } = item;
  const quotes = [d.quote, ...(d.rejected ?? []).map((r) => r.quote), ...(d.assumptions ?? []).map((a) => a.quote)];
  for (const q of quotes) {
    if (!quoteIsGrounded(q, comment)) throw new Error(`Sample "${item.ref}" quotes text that is not in its comment.`);
  }

  const hash = await contentHash(comment);
  const capturedAt = now();
  const evidence = [d.quote, ...(d.rejected ?? []).map((r) => r.quote)].map((quote) => ({
    sourceType: SOURCE_TYPE.JIRA_COMMENT, sourceId, url, quote, contentHash: hash, capturedAt,
  }));

  const allocated = await allocateId();
  const record = buildDecision({
    id: allocated.id,
    sequence: allocated.sequence,
    title: d.title,
    statement: d.statement,
    rejected: (d.rejected ?? []).map((r) => r.option),
    assumptions: (d.assumptions ?? []).map((a) => ({ text: a.text, ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}) })),
    decidedAt: d.decidedAt ?? capturedAt,
    scopeKey,
    tags: [...d.tags, 'sample'],
    evidence,
  });
  if (d.status === STATUS.BINDING) record.status = STATUS.BINDING;

  await putDecision(record);

  if (record.status === STATUS.BINDING) {
    // Stale is never written directly: it comes from the same expiry check the
    // daily sweep runs.
    const expiry = checkExpiry(record, now());
    if (expiry.stale) await markStale(record, expiry.reason, expiry.detail);
    const stored = await getDecision(record.id);
    await syncDecisionToGraph(stored).catch((err) => log.warn('sample graph sync failed', { id: record.id, error: err?.message }));
  }
  return record;
}

function now() {
  return new Date().toISOString();
}
