/**
 * Live evaluation runner — scores the real model against labelled datasets.
 *
 * Runs inside Forge because @forge/llm only works there. Two pieces:
 *
 *  - `evalTrigger` (web trigger): starts a run and returns a run id, or returns
 *    a finished report. A web trigger gets 55 seconds, too short for ~36 model
 *    calls, so it only enqueues.
 *  - `evalWorker` (async consumer, 900s): executes the run and stores the report.
 *
 * Security. Web trigger URLs are public and unauthenticated by default. This
 * one fails closed: it answers 404 unless (a) the app is not running in the
 * production environment and (b) the request carries the EVAL_TOKEN set with
 * `forge variables set --encrypt`. With no token configured it never answers,
 * so a production install exposes nothing.
 *
 * The scoring is not here: it lives in eval/score.js as pure functions, which
 * are unit-tested offline.
 */

import { kvs } from '@forge/kvs';
import { Queue } from '@forge/events';
import { getAppContext } from '@forge/api';
import { timingSafeEqual, randomUUID } from 'crypto';

import { extractDecision } from './engine/extract.js';
import { classifyAgainstCandidates } from './engine/conflict.js';
import { triage } from './engine/detect.js';
import { scoreTriage, scoreExtraction, scoreConflict, checkThresholds, THRESHOLDS } from '../eval/score.js';
import extractionData from '../eval/datasets/extraction.json';
import conflictData from '../eval/datasets/conflict.json';
import { log } from './lib/log.js';

const evalQueue = new Queue({ key: 'precedent-evals' });
const RUN_KEY = (id) => `precedent:eval:run:${id}`;
const SUITES = ['extraction', 'conflict'];
const CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Web trigger
// ---------------------------------------------------------------------------

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(body),
  };
}

const NOT_FOUND = () => respond(404, { error: 'not found' });

function header(request, name) {
  const headers = request?.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function query(request, name) {
  const value = request?.queryParameters?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function authorised(request) {
  const expected = process.env.EVAL_TOKEN;
  if (!expected || expected.length < 16) return false;

  let environmentType;
  try {
    environmentType = getAppContext()?.environmentType;
  } catch {
    return false;
  }
  if (!environmentType || environmentType.toUpperCase() === 'PRODUCTION') return false;

  const supplied = (header(request, 'authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function evalTrigger(request) {
  if (!authorised(request)) return NOT_FOUND();

  const runId = query(request, 'run');
  if (runId) {
    if (!/^[a-f0-9-]{36}$/.test(runId)) return respond(400, { error: 'bad run id' });
    const report = await kvs.get(RUN_KEY(runId));
    return report ? respond(200, report) : respond(404, { error: 'unknown run' });
  }

  const requested = (query(request, 'suite') ?? 'all').toLowerCase();
  const suites = requested === 'all' ? SUITES : SUITES.filter((s) => s === requested);
  if (suites.length === 0) return respond(400, { error: `suite must be one of: all, ${SUITES.join(', ')}` });

  const id = randomUUID();
  await kvs.set(RUN_KEY(id), { runId: id, status: 'queued', suites, queuedAt: new Date().toISOString() });
  await evalQueue.push({ body: { runId: id, suites } });
  log.info('eval run queued', { runId: id, suites: suites.join(',') });

  return respond(202, { runId: id, status: 'queued', suites });
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/** Run tasks with bounded parallelism; never let one failure sink the run. */
async function pool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await worker(items[i]);
      } catch (err) {
        out[i] = { error: err?.message ?? String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane));
  return out;
}

async function runExtraction() {
  const cases = extractionData.cases;
  const outputs = await pool(cases, async (c) => {
    const { record, reason } = await extractDecision(
      {
        text: c.text,
        sourceType: 'manual',
        sourceId: `eval:${c.id}`,
        url: `eval://${c.id}`,
        scopeKey: 'EVAL',
      },
      { id: `EVAL-${c.id}`, sequence: 0 }
    );
    // Nothing is stored: the eval measures extraction, not persistence.
    return {
      predicted: Boolean(record),
      reason,
      title: record?.title,
      rejected: record?.rejected ?? [],
      assumptions: (record?.assumptions ?? []).map((a) => a.text),
    };
  });

  const results = Object.fromEntries(cases.map((c, i) => [c.id, outputs[i]]));
  const proceeded = Object.fromEntries(cases.map((c) => [c.id, triage(c.text).proceed]));
  return { extraction: scoreExtraction(cases, results), triage: scoreTriage(cases, proceeded) };
}

async function runConflict() {
  const register = conflictData.register.map((d) => ({
    ...d,
    statement: d.statement ?? d.title,
    evidence: [],
  }));
  const outputs = await pool(conflictData.cases, async (c) => {
    const { findings } = await classifyAgainstCandidates(c.text, register, 'EVAL');
    return { findings: findings.map((f) => ({ decisionId: f.decisionId, relationship: f.relationship, confidence: f.confidence })) };
  });
  const results = Object.fromEntries(conflictData.cases.map((c, i) => [c.id, outputs[i]]));
  return { conflict: scoreConflict(conflictData, results) };
}

export async function evalWorker(event) {
  const { runId, suites = SUITES } = event?.body ?? {};
  if (!runId) return;

  const started = Date.now();
  await kvs.set(RUN_KEY(runId), { runId, status: 'running', suites, startedAt: new Date().toISOString() });

  const report = { runId, suites, thresholds: THRESHOLDS };
  try {
    if (suites.includes('extraction')) Object.assign(report, await runExtraction());
    if (suites.includes('conflict')) Object.assign(report, await runConflict());
    report.failures = checkThresholds(report);
    report.passed = report.failures.length === 0;
    report.status = 'complete';
  } catch (err) {
    report.status = 'failed';
    report.error = err?.message ?? String(err);
    log.error('eval run failed', { runId, error: report.error });
  }

  report.durationSeconds = Math.round((Date.now() - started) / 1000);
  report.finishedAt = new Date().toISOString();
  await kvs.set(RUN_KEY(runId), report);
  log.info('eval run finished', { runId, status: report.status, passed: report.passed, seconds: report.durationSeconds });
}
