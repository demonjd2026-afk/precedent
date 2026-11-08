/**
 * Evidence hashing — the mechanism behind "this decision stands on changed ground".
 *
 * When we capture a decision we hash the source text it came from. Later, the
 * drift checker re-reads that source and compares. If the hash moved, the
 * decision is flagged for review even though nobody touched the decision itself.
 *
 * Two details matter:
 *
 *  - We normalise before hashing. Confluence rewrites markup on save (whitespace,
 *    attribute order, macro ids) without a human changing a word. Hashing raw
 *    storage format would flag every decision every time somebody opened a page
 *    in the editor, and a checker that cries wolf gets switched off.
 *
 *  - We also keep a shingled fingerprint, so we can tell a typo fix from a
 *    rewrite. A single changed word should not read the same as a replaced
 *    paragraph, and the UI says which it was.
 */

const encoder = new TextEncoder();

/**
 * Strip the things that change without meaning changing.
 * @param {string} text
 * @returns {string}
 */
export function normalise(text) {
  if (!text) return '';
  return text
    // Confluence storage format and Jira ADF both arrive full of markup.
    .replace(/<[^>]+>/g, ' ')
    // HTML entities left behind by the above.
    .replace(/&[a-z]+;/gi, ' ')
    // Typographic punctuation. Jira and Confluence auto-convert ' and " to
    // curly quotes and -- to dashes, while a model quoting the text back will
    // often emit the plain ASCII form. Without folding these, a verbatim quote
    // fails grounding and a correct decision is discarded.
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    // Zero-width and non-breaking characters that editors inject.
    .replace(/[​-‍﻿ ]/g, ' ')
    // Collapse all whitespace.
    .replace(/\s+/g, ' ')
    // Stripping an inline tag ("<strong>Postgres</strong>.") leaves a space
    // before the punctuation that follows it. Without this, the same sentence
    // hashes differently in markup and in plain text, and every page converted
    // between formats would look like drift.
    .replace(/\s+([.,;:!?)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .trim()
    .toLowerCase();
}

/**
 * SHA-256 of the normalised text, hex encoded.
 * Uses WebCrypto, which the Forge Node runtime exposes as globalThis.crypto.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function contentHash(text) {
  const data = encoder.encode(normalise(text));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Word-level shingles, used to measure how much changed rather than whether
 * anything did.
 *
 * @param {string} text
 * @param {number} k
 * @returns {Set<string>}
 */
function shingles(text, k = 4) {
  const words = normalise(text).split(' ').filter(Boolean);
  const set = new Set();
  if (words.length < k) {
    if (words.length) set.add(words.join(' '));
    return set;
  }
  for (let i = 0; i <= words.length - k; i += 1) {
    set.add(words.slice(i, i + k).join(' '));
    }
  return set;
}

/**
 * Jaccard similarity between two texts, 0 to 1.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const s of sa) if (sb.has(s)) intersection += 1;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Classify how far a source has moved since capture.
 *
 * The thresholds decide what a human is asked to look at, so they are named
 * rather than inlined as magic numbers:
 *
 *   >= 0.98  unchanged in substance (formatting only)
 *   >= 0.75  edited — worth a note, not worth interrupting anyone
 *    < 0.75  rewritten — the decision's basis may genuinely be gone
 *
 * @param {string} capturedText
 * @param {string} currentText
 * @returns {{changed: boolean, severity: 'none'|'edited'|'rewritten', similarity: number}}
 */
export function classifyDrift(capturedText, currentText) {
  const score = similarity(capturedText, currentText);
  if (score >= 0.98) return { changed: false, severity: 'none', similarity: score };
  if (score >= 0.75) return { changed: true, severity: 'edited', similarity: score };
  return { changed: true, severity: 'rewritten', similarity: score };
}
