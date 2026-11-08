/**
 * Structured logging with a budget.
 *
 * Forge caps log lines per invocation (100 per runtime minute, rounded up) and
 * 200KB of log data per invocation. A chatty loop over 400 decision records
 * will blow that and take the useful lines with it, so this module counts and
 * truncates rather than letting the platform drop whatever happens to be last.
 */

const MAX_LINES = 80; // Leave headroom under the per-minute cap.
const MAX_FIELD_CHARS = 500;

let emitted = 0;
let suppressed = 0;

function truncate(value) {
  if (typeof value !== 'string') return value;
  return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…[truncated]` : value;
}

function sanitise(context = {}) {
  const out = {};
  for (const [k, v] of Object.entries(context)) {
    out[k] = truncate(v);
  }
  return out;
}

function emit(level, message, context) {
  if (emitted >= MAX_LINES) {
    suppressed += 1;
    return;
  }
  emitted += 1;
  const line = JSON.stringify({
    level,
    message,
    ...sanitise(context),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  if (emitted === MAX_LINES) {
    console.warn(JSON.stringify({ level: 'warn', message: 'log budget reached; further lines suppressed' }));
  }
}

export const log = {
  info: (message, context) => emit('info', message, context),
  warn: (message, context) => emit('warn', message, context),
  error: (message, context) => emit('error', message, context),
  /** Call at the end of a long worker to report what was swallowed. */
  summary: () => ({ emitted, suppressed }),
  /** Workers reset between invocations in practice, but be explicit. */
  reset: () => {
    emitted = 0;
    suppressed = 0;
  },
};
