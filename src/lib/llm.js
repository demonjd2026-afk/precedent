/**
 * Atlassian-hosted LLM access, with grounding enforced in code.
 *
 * Two things here are worth more than the prompt engineering:
 *
 *  1. Structured output via tool calling, not "please reply in JSON". The model
 *     is given exactly one tool and required to call it, so we parse a schema'd
 *     object instead of hoping a fenced code block is well-formed.
 *
 *  2. Quote verification. Every claim the model makes must carry a verbatim
 *     span from the source. We then check that span actually appears in the
 *     source text, and drop any claim that fails. A decision register that
 *     invents decisions is worse than no decision register, so hallucination is
 *     handled as a data-integrity problem rather than a prompting one.
 *
 * Model choice is deliberate. Forge LLMs have no free allowance — every token
 * is billed to the app developer — so the cheap model does the high-volume
 * work and the expensive one is reserved for the single call a user reads.
 */

import { chat } from '@forge/llm';
import { quoteIsGrounded, enforceGrounding } from './grounding.js';
import { log } from './log.js';

export const MODELS = Object.freeze({
  /** High volume, runs on every comment. Classification and extraction. */
  FAST: 'claude-haiku-4-5-20251001',
  /** Low volume, user-facing reasoning where quality is visible. */
  REASONING: 'claude-sonnet-4-5-20250929',
});

/** Keep prompts bounded; a runaway page should not become a runaway bill. */
const MAX_SOURCE_CHARS = 24000;

export function clampSource(text) {
  if (!text) return '';
  if (text.length <= MAX_SOURCE_CHARS) return text;
  return `${text.slice(0, MAX_SOURCE_CHARS)}\n\n[source truncated at ${MAX_SOURCE_CHARS} characters]`;
}

/**
 * Call the model and require a call to one named tool.
 *
 * @param {Object} options
 * @param {string} options.model
 * @param {string} options.system
 * @param {string} options.user
 * @param {{name: string, description: string, parameters: Record<string, unknown>}} options.tool
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @returns {Promise<{args: any, usage: any}>}
 */
export async function callStructured({
  model,
  system,
  user,
  tool,
  temperature = 0,
  maxTokens = 2000,
}) {
  const request = {
    model,
    temperature,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [{ type: 'function', function: tool }],
    tool_choice: { type: 'function', function: { name: tool.name } },
  };

  let response;
  try {
    response = await chat(request);
  } catch (err) {
    // The SDK surfaces API detail on err.context.responseText; keep it, because
    // moderation blocks and validation failures look identical without it.
    log.error('llm call failed', {
      model,
      tool: tool.name,
      error: err?.message,
      detail: err?.context?.responseText,
    });
    throw err;
  }

  const message = response?.choices?.[0]?.message;
  const call = message?.tool_calls?.[0];

  if (!call) {
    log.warn('model returned no tool call', {
      model,
      tool: tool.name,
      finish: response?.choices?.[0]?.finish_reason,
    });
    return { args: null, usage: response?.usage };
  }

  // The SDK types `arguments` as an object, but defend against a string in case
  // a model or a future version hands back raw JSON.
  let args = call.function?.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      log.warn('tool arguments were an unparseable string', { model, tool: tool.name });
      return { args: null, usage: response?.usage };
    }
  }

  return { args, usage: response?.usage };
}

/**
 * Report token usage so cost is visible in logs during the hackathon and in
 * production. Forge returns input/output token counts on every response.
 *
 * @param {string} label
 * @param {{input_tokens?: number, output_tokens?: number}} usage
 */
export function recordUsage(label, usage) {
  if (!usage) return;
  log.info('llm usage', {
    label,
    input: usage.input_tokens,
    output: usage.output_tokens,
  });
}

export { quoteIsGrounded, enforceGrounding };
