/**
 * Grounding checks — pure logic, no Forge imports.
 *
 * Kept separate from the LLM client so the rule that decides what may enter the
 * register can be tested without a Forge runtime. If this check is wrong in
 * either direction, the register either fills with fabrications or silently
 * discards real decisions, so it carries its own regression tests.
 */

import { normalise } from './hash.js';
import { log } from './log.js';

/**
 * Verify that a quoted span genuinely appears in the source.
 *
 * Compares on normalised text so that markup stripping, whitespace and case do
 * not cause false rejections, while a fabricated sentence still fails.
 *
 * @param {string} quote
 * @param {string} source
 * @returns {boolean}
 */
export function quoteIsGrounded(quote, source) {
  if (!quote || !source) return false;
  const needle = normalise(quote);
  if (needle.length < 8) return false; // Too short to be meaningful evidence.
  return normalise(source).includes(needle);
}

/**
 * Drop any claim whose quote cannot be found in the source, and report what
 * was dropped so it shows up in logs rather than vanishing silently.
 *
 * @template T
 * @param {T[]} claims
 * @param {string} source
 * @param {(claim: T) => string} getQuote
 * @returns {{kept: T[], dropped: T[]}}
 */
export function enforceGrounding(claims, source, getQuote) {
  const kept = [];
  const dropped = [];
  for (const claim of claims ?? []) {
    if (quoteIsGrounded(getQuote(claim), source)) kept.push(claim);
    else dropped.push(claim);
  }
  if (dropped.length > 0) {
    log.warn('dropped ungrounded claims', {
      count: dropped.length,
      // Lengths only: quotes are customer content and must not reach developer logs.
      quoteLengths: dropped.map((c) => (getQuote(c) ?? '').length).join(','),
    });
  }
  return { kept, dropped };
}

