/**
 * Conflict detection: does this new work contradict something already settled?
 *
 * This is the feature the whole product points at. It is also the easiest one
 * to get embarrassingly wrong, because a tool that shouts "conflict" at
 * unrelated work gets muted in a week and then it may as well not exist.
 *
 * So the pipeline is recall-then-precision:
 *
 *   1. Cheap lexical recall over the candidate set. No model, no cost.
 *   2. One model call over the top candidates, asked to classify each as
 *      contradicts / depends-on / unrelated, with a reason and a confidence.
 *   3. A confidence floor, below which we stay silent.
 *
 * Silence is a valid and common output. The code is written to make silence
 * easy rather than to justify a finding.
 */

import { MODELS, callStructured, clampSource, recordUsage } from '../lib/llm.js';
import { listCandidates } from '../lib/store.js';
import { STATUS } from '../lib/model.js';
import { log } from '../lib/log.js';

/** Below this, we do not show the user anything. */
const REPORT_THRESHOLD = 0.6;
/** How many candidates the model is allowed to see. Bounds cost and latency. */
const MAX_CANDIDATES = 12;

const CONFLICT_TOOL = {
  name: 'report_relationships',
  description: 'Report how a proposal relates to each past decision it was shown.',
  parameters: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            decisionId: { type: 'string', description: 'The id of the decision, e.g. DR-14.' },
            relationship: {
              type: 'string',
              enum: ['contradicts', 'depends_on', 'unrelated'],
              description:
                'contradicts: the proposal would reverse or violate this decision. ' +
                'depends_on: the proposal relies on this decision holding true. ' +
                'unrelated: no meaningful relationship. Use this freely; most pairs are unrelated.',
            },
            reason: {
              type: 'string',
              description:
                'One sentence a colleague would find useful, naming the specific point of ' +
                'conflict or dependency. Empty if unrelated.',
            },
            confidence: { type: 'number', description: 'Confidence from 0 to 1.' },
          },
          required: ['decisionId', 'relationship', 'confidence'],
        },
      },
    },
    required: ['findings'],
  },
};

const SYSTEM_PROMPT = `You compare a proposal against decisions a team has already made.

For each decision, say whether the proposal contradicts it, depends on it, or is unrelated.

Be strict. Two things touching the same general topic are NOT related. A relationship exists only when:
- contradicts: doing the proposal would reverse, violate or undo the specific thing the decision settled.
- depends_on: the proposal only works if the decision continues to hold.

Most comparisons are "unrelated". Saying so is the correct answer and carries no penalty. A false alarm costs the team far more than a missed subtlety, because it teaches them to ignore the tool.

Set confidence honestly. Below 0.6 the finding will not be shown, which is the right outcome when you are unsure.`;

/**
 * Cheap lexical overlap so the model only sees plausible candidates.
 * @param {string} text
 * @param {import('../lib/model.js').DecisionRecord} decision
 */
function recallScore(text, decision) {
  const words = new Set(
    (text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
  );
  if (words.size === 0) return 0;

  const haystack = [
    decision.title,
    decision.statement,
    ...(decision.tags ?? []),
    ...(decision.rejected ?? []),
  ]
    .join(' ')
    .toLowerCase();

  let hits = 0;
  for (const w of words) {
    if (haystack.includes(w)) hits += 1;
  }
  return hits / words.size;
}

/**
 * @typedef {Object} Finding
 * @property {string} decisionId
 * @property {string} title
 * @property {'contradicts'|'depends_on'} relationship
 * @property {string} reason
 * @property {number} confidence
 * @property {string} status
 * @property {string} [staleDetail]
 */

/**
 * @param {string} text   The proposal, ticket body or plan to check.
 * @param {string} [scopeKey]
 * @returns {Promise<{findings: Finding[], checked: number, silent: boolean}>}
 */
export async function checkConflicts(text, scopeKey) {
  const candidates = await listCandidates(scopeKey);
  return classifyAgainstCandidates(text, candidates, scopeKey);
}

/**
 * The storage-free core of the conflict check: recall, model classification,
 * confidence floor. Exported separately so the evaluation suite can run the
 * exact production pipeline against a fixed, labelled register.
 *
 * @param {string} text
 * @param {import('../lib/model.js').DecisionRecord[]} candidates
 * @param {string} [scopeKey]  Used for logging only.
 */
export async function classifyAgainstCandidates(text, candidates, scopeKey) {
  if (candidates.length === 0) {
    return { findings: [], checked: 0, silent: true };
  }

  // Word overlap ranks candidates; it must not decide which ones the model may
  // see. A proposal that paraphrases a decision ("have the lawyers mark up each
  // supplier's own paperwork" vs "custom redlines") shares no words with it, so
  // a lexical cut-off silently drops exactly the conflicts that matter most.
  // When the register fits the budget, the model sees all of it. Only above the
  // budget does overlap decide what is cut.
  const scored = candidates
    .map((d) => ({ decision: d, score: recallScore(text, d) }))
    .sort((a, b) => b.score - a.score);
  const ranked =
    scored.length <= MAX_CANDIDATES
      ? scored
      : scored.filter((c) => c.score > 0.05).slice(0, MAX_CANDIDATES);

  if (ranked.length === 0) {
    log.info('conflict check: no lexical candidates', { scope: scopeKey, pool: candidates.length });
    return { findings: [], checked: candidates.length, silent: true };
  }

  const summary = ranked
    .map(({ decision: d }) =>
      [
        `id: ${d.id}`,
        `decided: ${d.title}`,
        d.statement ? `detail: ${d.statement}` : null,
        (d.rejected ?? []).length ? `explicitly rejected: ${d.rejected.join('; ')}` : null,
        (d.assumptions ?? []).length
          ? `assumes: ${d.assumptions.map((a) => a.text).join('; ')}`
          : null,
        `status: ${d.status}`,
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');

  const { args, usage } = await callStructured({
    model: MODELS.REASONING,
    system: SYSTEM_PROMPT,
    user:
      `PROPOSAL:\n${clampSource(text)}\n\n` +
      `PAST DECISIONS:\n${summary}\n\n` +
      'Classify the proposal against each decision above.',
    tool: CONFLICT_TOOL,
    temperature: 0,
    maxTokens: 1500,
  });

  recordUsage('conflict', usage);

  if (!args?.findings) {
    return { findings: [], checked: ranked.length, silent: true };
  }

  const byId = new Map(ranked.map(({ decision }) => [decision.id, decision]));

  const findings = args.findings
    .filter((f) => f.relationship !== 'unrelated')
    .filter((f) => typeof f.confidence === 'number' && f.confidence >= REPORT_THRESHOLD)
    .filter((f) => byId.has(f.decisionId))
    .map((f) => {
      const d = byId.get(f.decisionId);
      return {
        decisionId: f.decisionId,
        title: d.title,
        relationship: f.relationship,
        reason: f.reason ?? '',
        confidence: f.confidence,
        status: d.status,
        // A conflict with a decision that is itself stale needs saying, or we
        // hold people to a rule that may no longer apply.
        staleDetail: d.status === STATUS.STALE ? d.staleDetail : undefined,
      };
    })
    // Contradictions first; they are what someone needs to see.
    .sort((a, b) => {
      if (a.relationship !== b.relationship) return a.relationship === 'contradicts' ? -1 : 1;
      return b.confidence - a.confidence;
    });

  log.info('conflict check complete', {
    scope: scopeKey,
    examined: ranked.length,
    reported: findings.length,
  });

  return { findings, checked: ranked.length, silent: findings.length === 0 };
}
