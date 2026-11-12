/**
 * The decision record.
 *
 * This shape is the product. Everything else in Precedent exists to fill it in,
 * keep it honest, or surface it at the right moment.
 *
 * Three fields do the work that a summary cannot:
 *
 *  - `rejected`    — what the team chose NOT to do. A decision without its
 *                    rejected alternatives is a fact; with them it is reasoning,
 *                    and reasoning is what stops the same debate rerunning.
 *  - `assumptions` — what the decision rests on. Assumptions are the thing that
 *                    rots. Tracking them is what makes expiry possible.
 *  - `evidence`    — where each claim came from, hashed. If the ground moves,
 *                    we can prove it moved.
 */

/** Lifecycle of a decision record. */
export const STATUS = Object.freeze({
  /** Extracted by the model, not yet confirmed by a human. Never cited as binding. */
  PROPOSED: 'proposed',
  /** Confirmed by a human. This is the only status the agent may cite as settled. */
  BINDING: 'binding',
  /** Still confirmed, but something it rests on has changed. Cite with a warning. */
  STALE: 'stale',
  /** Deliberately replaced by a newer decision. Kept forever; history is the point. */
  SUPERSEDED: 'superseded',
  /** A human looked at a proposal and said "that wasn't a decision". */
  REJECTED: 'rejected',
});

/** Why a binding decision went stale. Drives the wording the UI and agent use. */
export const STALE_REASON = Object.freeze({
  /** An explicit review date passed. */
  EXPIRED: 'expired',
  /** Source evidence was edited after the decision was made. */
  EVIDENCE_DRIFT: 'evidence_drift',
  /** A referenced Jira issue, page or project no longer resolves in the graph. */
  DANGLING_REFERENCE: 'dangling_reference',
  /** A human flagged it by hand. */
  MANUAL: 'manual',
});

export const SOURCE_TYPE = Object.freeze({
  JIRA_COMMENT: 'jira_comment',
  JIRA_ISSUE: 'jira_issue',
  CONFLUENCE_PAGE: 'confluence_page',
  MANUAL: 'manual',
});

/**
 * @typedef {Object} Evidence
 * @property {string} sourceType     One of SOURCE_TYPE.
 * @property {string} sourceId       Jira issue key, comment id or Confluence page id.
 * @property {string} url            Human-openable link to the source.
 * @property {string} quote          The verbatim span the claim came from. Short.
 * @property {string} contentHash    Hash of the source text at capture time.
 * @property {string} capturedAt     ISO timestamp.
 */

/**
 * @typedef {Object} Assumption
 * @property {string} text           What is being assumed, in plain language.
 * @property {string} [expiresAt]    ISO date after which this must be rechecked.
 * @property {string} [evidenceRef]  Index into `evidence`, if it was sourced.
 */

/**
 * @typedef {Object} DecisionRecord
 * @property {string} id                 Human-facing id, e.g. "DR-14".
 * @property {number} sequence           Monotonic allocation number behind the id.
 * @property {string} status             One of STATUS.
 * @property {string} title              One line: what was decided.
 * @property {string} statement          Full text of the decision.
 * @property {string[]} rejected         Alternatives explicitly not taken.
 * @property {Assumption[]} assumptions  What it rests on.
 * @property {string[]} deciders         Account ids of the people who decided.
 * @property {string} decidedAt          ISO timestamp of the decision itself.
 * @property {string} scopeKey           What it binds: project key, space key or team.
 * @property {string[]} tags             Free-text topics, used for retrieval.
 * @property {Evidence[]} evidence       Provenance for every claim above.
 * @property {string} [reviewAt]         ISO date for scheduled recheck.
 * @property {string} [staleReason]      One of STALE_REASON, when status is stale.
 * @property {string} [staleDetail]      Human-readable explanation of the staleness.
 * @property {string} [supersededBy]     Decision id that replaced this one.
 * @property {string} [supersedeReason]  Why it was reversed.
 * @property {string} createdAt          ISO timestamp.
 * @property {string} updatedAt          ISO timestamp.
 * @property {string} [confirmedBy]      Account id of the human who confirmed it.
 * @property {number} [extractionScore]  Model's own 0-1 confidence at capture.
 */

/** Statuses the agent is allowed to present as settled fact. */
export const CITABLE = Object.freeze([STATUS.BINDING, STATUS.STALE, STATUS.SUPERSEDED]);

/**
 * Validate a record before it is written. Returns a list of problems; empty
 * means valid. We fail loudly here rather than letting a malformed record reach
 * the graph, because a wrong decision record is worse than no decision record.
 *
 * @param {Partial<DecisionRecord>} record
 * @returns {string[]}
 */
export function validateDecision(record) {
  const problems = [];
  const required = ['id', 'status', 'title', 'statement', 'scopeKey', 'createdAt', 'updatedAt'];

  for (const field of required) {
    if (!record[field] || String(record[field]).trim() === '') {
      problems.push(`missing required field: ${field}`);
    }
  }

  if (record.status && !Object.values(STATUS).includes(record.status)) {
    problems.push(`unknown status: ${record.status}`);
  }

  if (record.status === STATUS.STALE && !record.staleReason) {
    problems.push('a stale decision must carry a staleReason');
  }

  if (record.status === STATUS.SUPERSEDED && !record.supersededBy) {
    problems.push('a superseded decision must name the decision that replaced it');
  }

  // A decision with no evidence is an assertion, not a record. The only way to
  // have one is for a human to have typed it in directly, which the caller
  // must declare explicitly via `manualEntry`.
  //
  // Note for future edits: do not infer this from the evidence array. An empty
  // array passes `.every()` vacuously, which would make every evidence-free
  // record look hand-entered and silently disable this check entirely.
  if ((record.evidence ?? []).length === 0 && record.manualEntry !== true) {
    problems.push('a captured decision must cite at least one piece of evidence');
  }

  if (record.title && record.title.length > 160) {
    problems.push('title must be 160 characters or fewer');
  }

  for (const [i, ev] of (record.evidence ?? []).entries()) {
    if (!ev.contentHash) problems.push(`evidence[${i}] is missing a contentHash`);
    // A decision typed into chat has no page to link to; every other source must.
    if (!ev.url && ev.sourceType !== SOURCE_TYPE.MANUAL) problems.push(`evidence[${i}] is missing a url`);
  }

  return problems;
}

/**
 * Build a well-formed record from extracted parts, filling defaults.
 * Always lands in PROPOSED: nothing a model produced becomes binding on its own.
 *
 * @param {Object} parts
 * @returns {DecisionRecord}
 */
export function buildDecision(parts) {
  const now = new Date().toISOString();
  return {
    id: parts.id,
    sequence: parts.sequence,
    status: STATUS.PROPOSED,
    title: (parts.title ?? '').trim(),
    statement: (parts.statement ?? '').trim(),
    rejected: parts.rejected ?? [],
    assumptions: parts.assumptions ?? [],
    deciders: parts.deciders ?? [],
    decidedAt: parts.decidedAt ?? now,
    scopeKey: parts.scopeKey ?? 'UNSCOPED',
    tags: parts.tags ?? [],
    evidence: parts.evidence ?? [],
    reviewAt: parts.reviewAt,
    createdAt: now,
    updatedAt: now,
    extractionScore: parts.extractionScore,
  };
}

/**
 * The register page and the agent both need a one-line status summary that
 * reads like a person wrote it. Centralised so the wording never drifts apart
 * between surfaces.
 *
 * @param {DecisionRecord} d
 * @returns {string}
 */
export function describeStatus(d) {
  switch (d.status) {
    case STATUS.BINDING:
      return 'Binding';
    case STATUS.PROPOSED:
      return 'Awaiting confirmation';
    case STATUS.REJECTED:
      return 'Not a decision';
    case STATUS.SUPERSEDED:
      return `Superseded by ${d.supersededBy}`;
    case STATUS.STALE:
      switch (d.staleReason) {
        case STALE_REASON.EXPIRED:
          return 'Needs review — review date passed';
        case STALE_REASON.EVIDENCE_DRIFT:
          return 'Needs review — the source it was based on has changed';
        case STALE_REASON.DANGLING_REFERENCE:
          return 'Needs review — something it referenced no longer exists';
        default:
          return 'Needs review';
      }
    default:
      return 'Unknown';
  }
}

/**
 * Does this evidence come from the given issue or page?
 *
 * Comment evidence is recorded as "ISSUE-KEY:COMMENT-ID", so a decision
 * captured from a comment on LEO-13 must match a lookup for "LEO-13". An exact
 * comparison misses every comment-sourced decision, which is almost all of them.
 *
 * @param {{sourceId?: string}} evidence
 * @param {string} key  An issue key, a page id, or a full "ISSUE:COMMENT" id.
 */
export function evidenceMatches(evidence, key) {
  const id = evidence?.sourceId;
  if (!id || !key) return false;
  return id === key || id.startsWith(`${key}:`);
}

/**
 * Drop decisions that were captured from the work item being checked.
 *
 * An issue cannot contradict a decision that was made on it. Without this, an
 * issue whose description still asks the open question ("decide how often we
 * review vendors") is flagged against the answer recorded in its own comments.
 *
 * @param {DecisionRecord[]} decisions
 * @param {string} [sourceKey]  Jira issue key being checked, e.g. "KAN-9".
 * @returns {{kept: DecisionRecord[], excluded: DecisionRecord[]}}
 */
export function partitionBySource(decisions, sourceKey) {
  if (!sourceKey) return { kept: decisions, excluded: [] };
  const kept = [];
  const excluded = [];
  for (const d of decisions) {
    const own = (d.evidence ?? []).some((e) => evidenceMatches(e, sourceKey));
    (own ? excluded : kept).push(d);
  }
  return { kept, excluded };
}

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
const ISSUE_KEY = /^([A-Z][A-Z0-9_]{1,19})-\d+/;

/**
 * The Jira projects a decision draws on: the project it binds, and the project
 * of every issue it quotes from. Non-project scopes (GLOBAL, UNSCOPED) and
 * hand-entered evidence contribute nothing.
 *
 * @param {DecisionRecord} d
 * @returns {string[]}
 */
export function projectKeysOf(d) {
  const keys = new Set();
  if (d?.scopeKey && PROJECT_KEY.test(d.scopeKey) && !['GLOBAL', 'UNSCOPED'].includes(d.scopeKey)) {
    keys.add(d.scopeKey);
  }
  for (const e of d?.evidence ?? []) {
    const m = ISSUE_KEY.exec(e?.sourceId ?? '');
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

/**
 * Whether a user who can browse `browsable` projects may see this decision.
 * They must be able to see every project it draws on, because the record
 * quotes content from those projects.
 *
 * @param {DecisionRecord} d
 * @param {Set<string>} browsable
 * @returns {boolean}
 */
export function visibleTo(d, browsable) {
  return projectKeysOf(d).every((k) => browsable.has(k));
}
