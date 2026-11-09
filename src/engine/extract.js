/**
 * Grounded extraction: turn a blob of conversation into a decision record.
 *
 * The contract with the model is narrow on purpose. It is not asked to
 * summarise, judge importance, or write prose. It is asked to locate specific
 * things and quote the exact span each one came from. Anything it cannot quote
 * is discarded by code before it reaches the register.
 *
 * This is why Precedent can claim a decision register rather than a summary
 * feed: a record either traces to words a human actually wrote, or it does not
 * exist.
 */

import { MODELS, callStructured, clampSource, enforceGrounding, recordUsage } from '../lib/llm.js';
import { contentHash } from '../lib/hash.js';
import { buildDecision } from '../lib/model.js';
import { log } from '../lib/log.js';

const EXTRACTION_TOOL = {
  name: 'record_decision',
  description:
    'Record a decision found in the supplied text. Every field that makes a claim about ' +
    'the text must be accompanied by the exact words it came from.',
  parameters: {
    type: 'object',
    properties: {
      isDecision: {
        type: 'boolean',
        description:
          'True only if the text records a decision that has actually been settled. ' +
          'A proposal, a question, a suggestion awaiting agreement, or a status update is not a decision.',
      },
      notDecisionReason: {
        type: 'string',
        description: 'If isDecision is false, one short sentence explaining why.',
      },
      title: {
        type: 'string',
        description: 'One line, under 160 characters, stating what was decided. Plain language.',
      },
      statement: {
        type: 'string',
        description: 'A fuller statement of the decision, two or three sentences at most.',
      },
      decisionQuote: {
        type: 'string',
        description:
          'The exact, verbatim words from the text where the decision is stated. ' +
          'Copy them character for character. Do not paraphrase, correct or shorten mid-sentence.',
      },
      rejected: {
        type: 'array',
        description: 'Alternatives the text explicitly says were considered and not chosen.',
        items: {
          type: 'object',
          properties: {
            option: { type: 'string', description: 'The alternative that was rejected.' },
            quote: { type: 'string', description: 'Exact verbatim words showing it was rejected.' },
          },
          required: ['option', 'quote'],
        },
      },
      assumptions: {
        type: 'array',
        description:
          'Conditions the decision depends on that could later stop being true. ' +
          'Only include assumptions the text actually states or directly implies.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The assumption in plain language.' },
            quote: { type: 'string', description: 'Exact verbatim words it was drawn from.' },
            suggestedReviewMonths: {
              type: 'number',
              description: 'How many months until this should be rechecked. Omit if open-ended.',
            },
          },
          required: ['text', 'quote'],
        },
      },
      tags: {
        type: 'array',
        description: 'Three to six short topic keywords for retrieval, lowercase.',
        items: { type: 'string' },
      },
      confidence: {
        type: 'number',
        description: 'Your confidence from 0 to 1 that this is a settled decision.',
      },
    },
    required: ['isDecision', 'confidence'],
  },
};

const SYSTEM_PROMPT = `You identify decisions in workplace conversation and record them exactly.

A decision is a choice a team has settled. These are NOT decisions:
- a proposal or suggestion that nobody has agreed to yet
- a question, even a leading one
- a status update describing work that happened
- an individual stating a preference without agreement
- a restatement of a decision made elsewhere, unless this text is where it was settled

Rules you must follow:
1. Every quote field must contain words copied EXACTLY from the supplied text. Character for character. If you cannot find exact words to support a claim, leave that item out entirely.
2. Never invent an alternative, an assumption, or a participant that the text does not mention.
3. Prefer leaving a field empty over filling it with something plausible.
4. If the text does not contain a settled decision, set isDecision to false and stop. This is a normal and correct outcome; most text is not a decision.`;

/**
 * @typedef {Object} ExtractionInput
 * @property {string} text          Plain text of the source.
 * @property {string} sourceType    One of SOURCE_TYPE.
 * @property {string} sourceId      Issue key, comment id or page id.
 * @property {string} url           Link to the source.
 * @property {string} scopeKey      Project key, space key or team.
 * @property {string[]} [deciders]  Account ids known from the event payload.
 * @property {string} [decidedAt]   ISO timestamp from the event.
 */

/**
 * @param {ExtractionInput} input
 * @param {{id: string, sequence: number}} allocatedId
 * @returns {Promise<{record: import('../lib/model.js').DecisionRecord | null, reason?: string}>}
 */
export async function extractDecision(input, allocatedId) {
  const source = clampSource(input.text);

  const { args, usage } = await callStructured({
    model: MODELS.FAST,
    system: SYSTEM_PROMPT,
    user: `Examine this text and record any decision it contains.\n\n---\n${source}\n---`,
    tool: EXTRACTION_TOOL,
    temperature: 0,
    maxTokens: 1500,
  });

  recordUsage('extract', usage);

  if (!args) {
    return { record: null, reason: 'model returned no structured output' };
  }

  if (!args.isDecision) {
    return { record: null, reason: args.notDecisionReason ?? 'not a decision' };
  }

  // --- Grounding enforcement -------------------------------------------------
  // The decision quote is load-bearing: without it there is no record at all.
  const decisionGrounded = enforceGrounding(
    [{ quote: args.decisionQuote }],
    source,
    (c) => c.quote
  );
  if (decisionGrounded.kept.length === 0) {
    // Diagnostics only: never log customer text, which the developer can read.
    log.warn('rejected extraction: decision quote not found in source', {
      sourceId: input.sourceId,
      quoteLength: (args.decisionQuote ?? '').length,
    });
    return { record: null, reason: 'the quoted decision text does not appear in the source' };
  }

  const rejected = enforceGrounding(args.rejected ?? [], source, (r) => r.quote);
  const assumptions = enforceGrounding(args.assumptions ?? [], source, (a) => a.quote);

  // --- Evidence --------------------------------------------------------------
  const capturedAt = new Date().toISOString();
  const hash = await contentHash(input.text);

  const evidence = [
    {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      url: input.url,
      quote: args.decisionQuote,
      contentHash: hash,
      capturedAt,
    },
  ];

  for (const r of rejected.kept) {
    evidence.push({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      url: input.url,
      quote: r.quote,
      contentHash: hash,
      capturedAt,
    });
  }

  // --- Review date -----------------------------------------------------------
  // The earliest assumption expiry becomes the record's review date. A decision
  // is only as fresh as its most perishable assumption.
  const reviewAt = earliestReview(assumptions.kept);

  const record = buildDecision({
    id: allocatedId.id,
    sequence: allocatedId.sequence,
    title: (args.title ?? '').slice(0, 160),
    statement: args.statement ?? args.title ?? '',
    rejected: rejected.kept.map((r) => r.option),
    assumptions: assumptions.kept.map((a) => ({
      text: a.text,
      expiresAt: monthsFromNow(a.suggestedReviewMonths),
    })),
    deciders: input.deciders ?? [],
    decidedAt: input.decidedAt ?? capturedAt,
    scopeKey: input.scopeKey,
    tags: (args.tags ?? []).map((t) => String(t).toLowerCase().slice(0, 32)).slice(0, 6),
    evidence,
    reviewAt,
    extractionScore: typeof args.confidence === 'number' ? args.confidence : undefined,
  });

  log.info('decision extracted', {
    id: record.id,
    scope: record.scopeKey,
    rejectedKept: rejected.kept.length,
    rejectedDropped: rejected.dropped.length,
    assumptionsKept: assumptions.kept.length,
    assumptionsDropped: assumptions.dropped.length,
    confidence: record.extractionScore,
  });

  return { record };
}

function monthsFromNow(months) {
  if (typeof months !== 'number' || months <= 0) return undefined;
  const d = new Date();
  d.setMonth(d.getMonth() + Math.round(months));
  return d.toISOString();
}

function earliestReview(assumptions) {
  const dates = assumptions
    .map((a) => monthsFromNow(a.suggestedReviewMonths))
    .filter(Boolean)
    .sort();
  if (dates.length > 0) return dates[0];

  // No assumption carried an expiry. Default to a twelve-month recheck so that
  // nothing sits in the register unexamined forever.
  const d = new Date();
  d.setMonth(d.getMonth() + 12);
  return d.toISOString();
}
