/**
 * UI resolvers for the issue panel and the decision register.
 *
 * These are the only code paths with a user context, which makes them the only
 * place Teamwork Graph reads can happen (see lib/graph.js). The panel therefore
 * does double duty: it shows the user their answer, and opportunistically
 * verifies the graph-dependent checks the background sweep could not run.
 */

import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { adfToText } from './engine/detect.js';
import {
  getDecision,
  listByScope,
  listByStatus,
  listProposals,
  patchDecision,
} from './lib/store.js';
import { STATUS, describeStatus } from './lib/model.js';
import { checkConflicts } from './engine/conflict.js';
import { syncDecisionToGraph, removeDecisionFromGraph, graphIndexStatus } from './connector.js';
import { echo as graphEcho } from './lib/graph.js';
import { log } from './lib/log.js';
import { evalsEnabled, startEvalRun, getEvalRun } from './evals.js';
import { seedStatus, listProjects, requestLoad, requestRemove } from './seed/seed.js';

// ---------------------------------------------------------------------------
// Issue panel
// ---------------------------------------------------------------------------
const panel = new Resolver();

panel.define('getPanelData', async ({ context }) => {
  const issueKey = context?.extension?.issue?.key;
  const projectKey = context?.extension?.project?.key ?? scopeFromIssueKey(issueKey);

  const [proposals, scoped] = await Promise.all([
    listProposals(issueKey),
    listByScope(projectKey, 100),
  ]);

  const needsReview = scoped.filter((d) => d.status === STATUS.STALE);
  const binding = scoped.filter((d) => d.status === STATUS.BINDING);

  return {
    issueKey,
    projectKey,
    // Proposals captured from this very issue, awaiting a human.
    proposals: proposals.map(summarise),
    binding: binding.slice(0, 5).map(summarise),
    needsReview: needsReview.slice(0, 5).map(summarise),
    counts: {
      binding: binding.length,
      needsReview: needsReview.length,
      proposals: proposals.length,
    },
  };
});

/**
 * Run the conflict check against this issue's own text. Separate from the
 * initial load because it costs a model call, and a panel that bills on every
 * page view is a panel an admin uninstalls.
 */
panel.define('checkThisIssue', async ({ payload, context }) => {
  const issueKey = context?.extension?.issue?.key;
  const projectKey = context?.extension?.project?.key ?? scopeFromIssueKey(issueKey);

  // Read the issue as the viewing user, so the check never sees text that
  // person could not see themselves.
  let text = payload?.text;
  if (!text && issueKey) {
    const res = await api
      .asUser()
      .requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description`);
    if (res.ok) {
      const body = await res.json();
      text = [body?.fields?.summary, adfToText(body?.fields?.description)].filter(Boolean).join('\n\n');
    }
  }

  if (!text || text.trim().length < 20) {
    return { findings: [], summary: 'This issue has too little text to check. Add a description first.' };
  }

  const { findings, checked, silent, ownDecisions } = await checkConflicts(text, projectKey, {
    sourceKey: issueKey,
  });

  // Say which decisions were skipped because they were made on this issue, so
  // a silent result is never mistaken for "nothing was looked at".
  const own = [...(ownDecisions ?? [])].sort(
    (a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''))
  );
  const ownList = own.length > 1 ? `${own.slice(0, -1).join(', ')} and ${own.at(-1)}` : own[0];
  const ownNote = own.length
    ? ` ${ownList} ${own.length === 1 ? 'was' : 'were'} decided on this issue, so ${own.length === 1 ? 'it was' : 'they were'} not checked against it.`
    : '';

  return {
    findings,
    checked,
    summary:
      (silent
        ? checked === 0
          ? own.length
            ? 'No other recorded decisions apply to this project yet.'
            : 'No recorded decisions apply to this project yet.'
          : `Checked against ${checked} decision${checked === 1 ? '' : 's'} — nothing conflicts.`
        : `${findings.length} thing${findings.length === 1 ? '' : 's'} to look at.`) + ownNote,
  };
});

/**
 * Confirm a proposed decision. This is the human-in-the-loop gate: nothing the
 * model extracted becomes binding, citable or visible in org-wide search until
 * somebody presses this.
 */
panel.define('confirmDecision', async ({ payload, context }) => {
  const { decisionId, edits } = payload ?? {};
  const existing = await getDecision(decisionId);
  if (!existing) return { ok: false, error: `${decisionId} not found` };
  if (existing.status !== STATUS.PROPOSED) {
    return { ok: false, error: `${decisionId} is already ${existing.status}` };
  }

  // A human may correct the extraction before confirming. Their edits override
  // the model's output, and the record keeps the original evidence either way.
  const updated = await patchDecision(decisionId, {
    ...(edits?.title ? { title: String(edits.title).slice(0, 160) } : {}),
    ...(edits?.statement ? { statement: String(edits.statement) } : {}),
    ...(Array.isArray(edits?.rejected) ? { rejected: edits.rejected } : {}),
    status: STATUS.BINDING,
    confirmedBy: context?.accountId,
  });

  // Now that a human stands behind it, publish to the graph.
  const sync = await syncDecisionToGraph(updated);
  log.info('decision confirmed', { id: decisionId, synced: sync.synced });

  return { ok: true, decision: summarise(updated), synced: sync.synced };
});

/** Mark a proposal as not a decision. Keeps the record so we do not re-extract it. */
panel.define('rejectProposal', async ({ payload, context }) => {
  const { decisionId, reason } = payload ?? {};
  const existing = await getDecision(decisionId);
  if (!existing) return { ok: false, error: `${decisionId} not found` };

  await patchDecision(decisionId, {
    status: STATUS.REJECTED,
    staleDetail: reason ?? 'A person reviewed this and said it is not a decision.',
    confirmedBy: context?.accountId,
  });

  // If it had previously been confirmed and synced, pull it back out of search.
  if (existing.status !== STATUS.PROPOSED) {
    await removeDecisionFromGraph(decisionId).catch(() => {});
  }

  return { ok: true };
});

export const panelHandler = panel.getDefinitions();

// ---------------------------------------------------------------------------
// Decision register (global page)
// ---------------------------------------------------------------------------
const register = new Resolver();

register.define('listRegister', async ({ payload }) => {
  const { status = STATUS.BINDING, scope } = payload ?? {};
  let rows = await listByStatus(status);
  if (scope) rows = rows.filter((d) => d.scopeKey === scope);

  const [binding, stale, proposed, superseded] = await Promise.all([
    listByStatus(STATUS.BINDING),
    listByStatus(STATUS.STALE),
    listByStatus(STATUS.PROPOSED),
    listByStatus(STATUS.SUPERSEDED),
  ]);

  return {
    rows: rows.map(summarise),
    scopes: [...new Set([...binding, ...stale].map((d) => d.scopeKey))].sort(),
    counts: {
      binding: binding.length,
      stale: stale.length,
      proposed: proposed.length,
      superseded: superseded.length,
    },
  };
});

register.define('getFullDecision', async ({ payload }) => {
  const d = await getDecision(payload?.decisionId);
  if (!d) return null;
  return { ...d, statusLabel: describeStatus(d) };
});

/**
 * Health check for the admin. Reports what is wired up and what is not, which
 * turns "the panel is empty" from a mystery into a diagnosis — including the
 * scope-granted-or-not ambiguity that the graph API cannot distinguish for us.
 */
register.define('health', async () => {
  const graph = await graphEcho();
  const [binding, proposed] = await Promise.all([
    listByStatus(STATUS.BINDING),
    listByStatus(STATUS.PROPOSED),
  ]);

  const synced = [...binding, ...(await listByStatus(STATUS.STALE))].map((d) => d.id);
  const index = await graphIndexStatus(synced);

  return {
    index,
    graphReachable: graph.ok,
    graphDetail: graph.detail,
    registerSize: binding.length + proposed.length,
    awaitingConfirmation: proposed.length,
    note: graph.ok
      ? 'Teamwork Graph is reachable. If graph-backed results are still empty, an admin may not have granted every scope — missing scopes return empty rather than an error.'
      : 'Teamwork Graph could not be reached. Precedent still works; graph-backed context will be unavailable.',
  };
});

register.define('evalStatus', async () => ({ enabled: evalsEnabled(), latest: evalsEnabled() ? await getEvalRun() : null }));
register.define('startEval', async ({ payload }) => startEvalRun(payload?.suite ?? 'all'));
register.define('getEval', async ({ payload }) => getEvalRun(payload?.runId));

register.define('seedStatus', async () => seedStatus());
register.define('listProjects', async () => listProjects());
register.define('loadSample', async ({ payload }) => requestLoad(payload?.projectKey));
register.define('removeSample', async () => requestRemove());

export const registerHandler = register.getDefinitions();

// ---------------------------------------------------------------------------

function summarise(d) {
  return {
    id: d.id,
    sequence: d.sequence,
    title: d.title,
    statement: d.statement,
    status: d.status,
    statusLabel: describeStatus(d),
    scope: d.scopeKey,
    decidedAt: d.decidedAt,
    rejected: d.rejected ?? [],
    assumptions: d.assumptions ?? [],
    tags: d.tags ?? [],
    staleDetail: d.staleDetail,
    supersededBy: d.supersededBy,
    evidence: (d.evidence ?? []).map((e) => ({ quote: e.quote, url: e.url })),
    extractionScore: d.extractionScore,
  };
}

function scopeFromIssueKey(issueKey) {
  const match = /^([A-Z][A-Z0-9]+)-\d+$/.exec(issueKey ?? '');
  return match ? match[1] : 'UNSCOPED';
}
