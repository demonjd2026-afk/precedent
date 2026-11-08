/**
 * Decision detection — the cheap gate in front of the expensive one.
 *
 * Every Jira comment on a busy site would otherwise hit the model. At Haiku
 * rates that is small money per call and real money per month, and Forge LLMs
 * carry no free allowance, so the pipeline is deliberately two-stage:
 *
 *   Stage 1 (this file, free): lexical triage. Reject the obvious noise.
 *   Stage 2 (extract.js, paid): the model, only on what survives.
 *
 * The heuristic is tuned for recall, not precision. A missed decision is
 * invisible and permanent; a false positive costs one cheap model call that
 * returns "not a decision". So the bar to proceed is low on purpose.
 */

/**
 * Phrases that mark a settlement rather than a suggestion. The distinction
 * that matters is tense and finality: "we should use X" is a proposal,
 * "we're going with X" is a decision.
 */
const DECISION_MARKERS = [
  /\bwe(?:'| a)?re going (?:to go )?with\b/i,
  /\bwe(?:'ve| have) decided\b/i,
  /\bdecision\b/i,
  /\bdecided\b/i,
  /\blet'?s go with\b/i,
  /\bwe'?ll use\b/i,
  /\bagreed\b/i,
  /\bsigned off\b/i,
  /\bapproved\b/i,
  /\bfinal(?:ised|ized)?\b/i,
  /\bgo(?:ing)? ahead with\b/i,
  /\bsticking with\b/i,
  /\bruled out\b/i,
  /\bnot going (?:to go )?with\b/i,
  /\binstead of\b/i,
  /\bconclusion\b/i,
  /\bthe call is\b/i,
  /\bwe settled on\b/i,
  // Colloquial settlements. Real threads often close a debate without any
  // formal wording ("fine, Lisbon it is"). The gate is tuned for recall, and a
  // false pass costs one cheap model call, so these lean inclusive.
  /\b(?:fine|ok(?:ay)?|alright|right|so)\b[\s,.\u2014\u2013-]+(?:\S+\s+){0,4}it is\b/i,
  /\b\w+ it is then\b/i,
  /\bthat'?s (?:settled|decided|final)\b/i,
  /\b(?:settled|sorted)[,.!]\s/i,
  /\bship it\b/i,
  /\blet'?s (?:do|use|go for|pick|stick with)\b/i,
  /\bwe'?(?:ll| will) (?:go|stick) with\b/i,
];

/** Hedges that usually mean the thread is still open. */
const HEDGE_MARKERS = [
  /\bwhat do (?:you|we) think\b/i,
  /\bthoughts\?/i,
  /\bshould we\b/i,
  /\bmaybe we\b/i,
  /\bcould we\b/i,
  /\bany objections\b/i,
  /\bnot sure\b/i,
  /\bopen question\b/i,
  /\btbd\b/i,
];

/** Content that is never a decision regardless of wording. */
const NOISE_MARKERS = [
  /^\s*(?:lgtm|\+1|thanks|ty|ok|okay|done|ack)\s*[.!]?\s*$/i,
  /\bautomation rule\b.*\bexecuted\b/i,
  /^\s*\[?(?:automated|bot)\]?/i,
];

const MIN_CHARS = 40;

/**
 * @typedef {Object} TriageResult
 * @property {boolean} proceed       Whether to spend a model call on this.
 * @property {number} score          0-1 rough confidence this holds a decision.
 * @property {string} reason         Why, for logs and the admin page.
 * @property {string[]} matched      Which markers fired.
 */

/**
 * @param {string} text
 * @returns {TriageResult}
 */
export function triage(text) {
  const clean = (text ?? '').trim();

  if (clean.length < MIN_CHARS) {
    return { proceed: false, score: 0, reason: 'too short to contain a decision', matched: [] };
  }

  for (const noise of NOISE_MARKERS) {
    if (noise.test(clean)) {
      return { proceed: false, score: 0, reason: 'acknowledgement or automated content', matched: [] };
    }
  }

  const matched = [];
  for (const marker of DECISION_MARKERS) {
    if (marker.test(clean)) matched.push(marker.source);
  }

  if (matched.length === 0) {
    return { proceed: false, score: 0, reason: 'no decision language present', matched: [] };
  }

  let hedges = 0;
  for (const hedge of HEDGE_MARKERS) {
    if (hedge.test(clean)) hedges += 1;
  }

  // Markers push up, hedges pull down, but hedges never veto outright: plenty
  // of real decisions are announced in the same breath as a caveat.
  const raw = matched.length / (matched.length + 1) - hedges * 0.15;
  const score = Math.max(0.1, Math.min(1, raw));

  return {
    proceed: true,
    score,
    reason: hedges > 0 ? 'decision language present, with hedging' : 'decision language present',
    matched,
  };
}

/**
 * Strip Atlassian Document Format down to plain text for triage and hashing.
 *
 * Jira comments arrive as ADF, a nested node tree. We walk it rather than
 * regexing it, because a regex over JSON picks up field names and ids as if
 * they were prose and poisons both the triage and the content hash.
 *
 * @param {any} adf
 * @returns {string}
 */
export function adfToText(adf) {
  if (!adf) return '';
  if (typeof adf === 'string') return adf;

  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text' && typeof node.text === 'string') {
      parts.push(node.text);
    }
    // Preserve block boundaries so sentences do not run together.
    const isBlock = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type);
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
      if (isBlock) parts.push('\n');
    }
  };

  walk(adf);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}
