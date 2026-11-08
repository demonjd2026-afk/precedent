/**
 * Actions: the single tool layer.
 *
 * Each function here is referenced four ways — by the Rovo agent, by the two
 * skills, by the rovo:mcp server for external clients like Claude or Cursor,
 * and by the UI resolvers. Writing them once is the reason the MCP surface is
 * not a second implementation that drifts from the first.
 *
 * Design rules for everything in this file:
 *
 *  - Return plain objects with a `summary` string. An agent reads the summary;
 *    a UI reads the fields. Neither has to parse the other's format.
 *  - Say when nothing was found, and why. "No results" and "I could not look"
 *    are different answers and the caller must be able to tell them apart.
 *  - Never present a PROPOSED record as settled. Unconfirmed extractions are
 *    labelled as such everywhere they appear.
 *  - Stay inside the 55 second action budget. Anything slower belongs on a queue.
 */

import {
  getDecision as loadDecision,
  listCandidates,
  listByScope,
  listByStatus,
  patchDecision,
  allocateId,
  putDecision,
} from './lib/store.js';
import { STATUS, describeStatus } from './lib/model.js';
import { checkConflicts } from './engine/conflict.js';
import { extractDecision } from './engine/extract.js';
import { dueForReview } from './engine/staleness.js';
import { triage } from './engine/detect.js';
import { log } from './lib/log.js';

/**
 * Forge delivers action inputs on the payload. Older samples nest them under
 * `inputs`, newer ones put them at the top level; accept either so the same
 * code works from chat, from automation and from an MCP client.
 */
function inputsOf(payload) {
  if (!payload) return {};
  return payload.inputs && typeof payload.inputs === 'object' ? payload.inputs : payload;
}

/** Shorten a record for list output: enough to decide, not enough to overwhelm. */
function brief(d) {
  return {
    id: d.id,
    title: d.title,
    status: d.status,
    statusLabel: describeStatus(d),
    scope: d.scopeKey,
    decidedAt: d.decidedAt,
    tags: d.tags ?? [],
    unconfirmed: d.status === STATUS.PROPOSED,
  };
}

/** Lexical relevance, shared with the conflict engine's recall step. */
function score(query, d) {
  const words = (query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return 0;

  const haystack = [d.title, d.statement, ...(d.tags ?? []), ...(d.rejected ?? [])]
    .join(' ')
    .toLowerCase();

  let hits = 0;
  for (const w of words) if (haystack.includes(w)) hits += 1;

  // Tag matches are a stronger signal than prose matches.
  const tagHits = (d.tags ?? []).filter((t) => words.includes(t)).length;
  return hits / words.length + tagHits * 0.25;
}

// ---------------------------------------------------------------------------
// search-decisions
// ---------------------------------------------------------------------------
export async function searchDecisions(payload) {
  const { query, scope, status } = inputsOf(payload);

  if (!query || String(query).trim().length < 2) {
    return { summary: 'Give me something to search for.', results: [] };
  }

  let pool = status ? await listByStatus(status) : await listCandidates(scope);
  if (scope && !status) pool = pool.filter((d) => d.scopeKey === scope || d.scopeKey === 'GLOBAL');

  if (pool.length === 0) {
    return {
      summary:
        'The decision register is empty' +
        (scope ? ` for ${scope}` : '') +
        '. Nothing has been recorded yet.',
      results: [],
      registerEmpty: true,
    };
  }

  const ranked = pool
    .map((d) => ({ d, s: score(query, d) }))
    .filter((r) => r.s > 0.15)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8)
    .map((r) => r.d);

  if (ranked.length === 0) {
    return {
      summary: `Nothing in the register matches "${query}". ${pool.length} decisions were searched.`,
      results: [],
      searched: pool.length,
    };
  }

  const stale = ranked.filter((d) => d.status === STATUS.STALE).length;

  return {
    summary:
      `Found ${ranked.length} decision${ranked.length === 1 ? '' : 's'} matching "${query}"` +
      (stale > 0 ? `, ${stale} of which need review.` : '.'),
    results: ranked.map(brief),
    searched: pool.length,
  };
}

// ---------------------------------------------------------------------------
// get-decision
// ---------------------------------------------------------------------------
export async function getDecision(payload) {
  const { decisionId } = inputsOf(payload);

  if (!decisionId) return { summary: 'Which decision? Give me an id such as DR-14.', found: false };

  const d = await loadDecision(String(decisionId).trim().toUpperCase());
  if (!d) {
    return { summary: `No decision with id ${decisionId} exists in the register.`, found: false };
  }

  return {
    found: true,
    summary: `${d.id}: ${d.title} — ${describeStatus(d)}`,
    id: d.id,
    title: d.title,
    statement: d.statement,
    status: d.status,
    statusLabel: describeStatus(d),
    unconfirmed: d.status === STATUS.PROPOSED,
    rejected: d.rejected ?? [],
    // Recheck dates are suggested by the model at capture time, not stated by
    // the people who decided. Label them so the agent never presents a derived
    // date as part of what the team said.
    assumptions: (d.assumptions ?? []).map((x) => ({
      text: x.text,
      ...(x.expiresAt ? { suggestedRecheckBy: x.expiresAt.slice(0, 10) } : {}),
    })),
    suggestedReviewBy: d.reviewAt ? d.reviewAt.slice(0, 10) : undefined,
    // The person who posted the decision. Usually a decider, not always the only one.
    recordedBy: d.deciders ?? [],
    decidedAt: d.decidedAt,
    scope: d.scopeKey,
    tags: d.tags ?? [],
    staleDetail: d.staleDetail,
    supersededBy: d.supersededBy,
    supersedeReason: d.supersedeReason,
    // Evidence is what lets a reader verify rather than trust.
    evidence: (d.evidence ?? []).map((e) => ({ quote: e.quote, url: e.url, capturedAt: e.capturedAt })),
  };
}

// ---------------------------------------------------------------------------
// check-conflict
// ---------------------------------------------------------------------------
export async function checkConflict(payload) {
  const { text, scope } = inputsOf(payload);

  if (!text || String(text).trim().length < 20) {
    return {
      summary: 'Give me the proposal text to check — a sentence or two is enough.',
      findings: [],
    };
  }

  const { findings, checked, silent } = await checkConflicts(String(text), scope);

  if (silent) {
    return {
      summary:
        checked === 0
          ? 'There are no recorded decisions to check this against yet.'
          : `Checked against ${checked} related decision${checked === 1 ? '' : 's'}. Nothing conflicts.`,
      findings: [],
      checked,
    };
  }

  const contradictions = findings.filter((f) => f.relationship === 'contradicts');
  const dependencies = findings.filter((f) => f.relationship === 'depends_on');

  const parts = [];
  if (contradictions.length > 0) {
    parts.push(
      `This contradicts ${contradictions.length} earlier decision${contradictions.length === 1 ? '' : 's'}: ` +
        contradictions.map((f) => f.decisionId).join(', ')
    );
  }
  if (dependencies.length > 0) {
    parts.push(
      `It depends on ${dependencies.map((f) => f.decisionId).join(', ')} continuing to hold.`
    );
  }

  return { summary: parts.join(' '), findings, checked };
}

// ---------------------------------------------------------------------------
// capture-decision
// ---------------------------------------------------------------------------
export async function captureDecision(payload, context) {
  const { text, sourceUrl, scope } = inputsOf(payload);

  if (!text || String(text).trim().length < 30) {
    return { summary: 'Give me the text containing the decision.', captured: false };
  }

  // Run the same cheap gate the event pipeline uses, so a user asking the agent
  // to "record this" gets the same judgement as the automatic path.
  const gate = triage(String(text));
  if (!gate.proceed) {
    return {
      summary: `That does not look like a settled decision — ${gate.reason}.`,
      captured: false,
      reason: gate.reason,
    };
  }

  const { record, reason } = await extractDecision(
    {
      text: String(text),
      sourceType: 'manual',
      sourceId: `manual:${Date.now()}`,
      url: sourceUrl ?? '',
      scopeKey: scope ?? 'UNSCOPED',
      deciders: context?.accountId ? [context.accountId] : [],
    },
    { id: 'PENDING', sequence: 0 }
  );

  if (!record) {
    return { summary: `I did not record anything — ${reason}.`, captured: false, reason };
  }

  const allocated = await allocateId();
  record.id = allocated.id;
  record.sequence = allocated.sequence;
  await putDecision(record);

  return {
    captured: true,
    summary:
      `Recorded as ${record.id}: ${record.title}. ` +
      'It is marked as awaiting confirmation until a person confirms it in the decision register.',
    id: record.id,
    title: record.title,
    status: record.status,
  };
}

// ---------------------------------------------------------------------------
// list-stale-decisions
// ---------------------------------------------------------------------------
export async function listStale(payload) {
  const { scope } = inputsOf(payload);

  const flagged = await listByStatus(STATUS.STALE);
  const scoped = scope ? flagged.filter((d) => d.scopeKey === scope) : flagged;
  const due = await dueForReview(scope);

  // A decision can be both flagged and past its review date; show it once.
  const seen = new Set(scoped.map((d) => d.id));
  const combined = [...scoped, ...due.filter((d) => !seen.has(d.id))];

  if (combined.length === 0) {
    return {
      summary: scope
        ? `Nothing in ${scope} needs review right now.`
        : 'Nothing in the register needs review right now.',
      results: [],
    };
  }

  const byReason = {};
  for (const d of combined) {
    const key = d.staleReason ?? 'due_for_review';
    byReason[key] = (byReason[key] ?? 0) + 1;
  }

  return {
    summary:
      `${combined.length} decision${combined.length === 1 ? '' : 's'} need${combined.length === 1 ? 's' : ''} review` +
      (scope ? ` in ${scope}` : '') +
      '.',
    results: combined.map((d) => ({ ...brief(d), why: d.staleDetail ?? 'Past its review date.' })),
    byReason,
  };
}

// ---------------------------------------------------------------------------
// supersede-decision
// ---------------------------------------------------------------------------
export async function supersedeDecision(payload, context) {
  const { decisionId, supersededBy, reason } = inputsOf(payload);

  if (!decisionId || !supersededBy) {
    return { summary: 'I need both the decision to supersede and the one replacing it.', ok: false };
  }

  const oldId = String(decisionId).trim().toUpperCase();
  const newId = String(supersededBy).trim().toUpperCase();

  if (oldId === newId) {
    return { summary: 'A decision cannot supersede itself.', ok: false };
  }

  const [older, newer] = await Promise.all([loadDecision(oldId), loadDecision(newId)]);

  if (!older) return { summary: `${oldId} is not in the register.`, ok: false };
  if (!newer) return { summary: `${newId} is not in the register.`, ok: false };

  if (older.status === STATUS.SUPERSEDED) {
    return {
      summary: `${oldId} was already superseded by ${older.supersededBy}.`,
      ok: false,
    };
  }

  await patchDecision(oldId, {
    status: STATUS.SUPERSEDED,
    supersededBy: newId,
    supersedeReason: reason ?? '',
    confirmedBy: context?.accountId,
  });

  log.info('decision superseded', { oldId, newId, by: context?.accountId });

  return {
    ok: true,
    summary: `${oldId} is now marked as superseded by ${newId}. The original record is kept.`,
  };
}
