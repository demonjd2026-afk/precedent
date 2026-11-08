/**
 * Live evaluation runner — scores the real model against labelled datasets.
 *
 * Runs inside Forge because @forge/llm only works there. Started from the
 * Decision register page and executed on an async consumer (900s), because a
 * full run is ~36 model calls and a resolver gets 25 seconds.
 *
 * Deliberately not a web trigger. A web trigger is a public inbound URL, and
 * adding one removes the app's Runs on Atlassian eligibility. Driving evals
 * through the app's own UI keeps every byte on the platform, behind Jira login,
 * and the controls disable themselves in the production environment.
 *
 * Scoring lives in eval/score.js as pure, unit-tested functions.
 */

import { kvs } from '@forge/kvs';
import { Queue } from '@forge/events';
import { getAppContext } from '@forge/api';
import { randomUUID } from 'crypto';

import { extractDecision } from './engine/extract.js';
import { classifyAgainstCandidates } from './engine/conflict.js';
import { triage } from './engine/detect.js';
import { scoreTriage, scoreExtraction, scoreConflict, checkThresholds, THRESHOLDS } from '../eval/score.js';
import extractionData from '../eval/datasets/extraction.json';
import conflictData from '../eval/datasets/conflict.json';
import extractionHardData from '../eval/datasets/extraction-hard.json';
import conflictHardData from '../eval/datasets/conflict-hard.json';
import { log } from './lib/log.js';

const evalQueue = new Queue({ key: 'precedent-evals' });
const RUN_KEY = (id) => `precedent:eval:run:${id}`;
const LATEST_KEY = 'precedent:eval:latest';
const SUITES = ['extraction', 'conflict', 'extraction-hard', 'conflict-hard'];
const CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Entry points, called from the register page's resolver
// ---------------------------------------------------------------------------

/**
 * Evaluations run only outside production. A judge or customer installing the
 * production build never sees the controls and cannot spend tokens on them.
 */
export function evalsEnabled() {
  try {
    const env = getAppContext()?.environmentType;
    return Boolean(env) && env.toUpperCase() !== 'PRODUCTION';
  } catch {
    return false;
  }
}

export async function startEvalRun(suite = 'all') {
  if (!evalsEnabled()) return { error: 'Evaluations are disabled in production.' };
  const requested = String(suite).toLowerCase();
  const suites = requested === 'all' ? SUITES : SUITES.filter((s) => s === requested);
  if (suites.length === 0) return { error: `suite must be one of: all, ${SUITES.join(', ')}` };

  const id = randomUUID();
  await kvs.set(RUN_KEY(id), { runId: id, status: 'queued', suites, queuedAt: new Date().toISOString() });
  await kvs.set(LATEST_KEY, id);
  await evalQueue.push({ body: { runId: id, suites } });
  log.info('eval run queued', { runId: id, suites: suites.join(',') });
  return { runId: id, status: 'queued', suites };
}

/** The given run, or the most recent one when no id is passed. */
export async function getEvalRun(runId) {
  if (!evalsEnabled()) return { error: 'Evaluations are disabled in production.' };
  const id = runId ?? (await kvs.get(LATEST_KEY));
  if (!id) return null;
  if (!/^[a-f0-9-]{36}$/.test(id)) return { error: 'bad run id' };
  return (await kvs.get(RUN_KEY(id))) ?? null;
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

async function runExtraction(dataset = extractionData) {
  const cases = dataset.cases;
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

async function runConflict(dataset = conflictData) {
  // Hard cases are judged against the same register as the base set.
  const full = { register: conflictData.register, cases: dataset.cases };
  const register = conflictData.register.map((d) => ({
    ...d,
    statement: d.statement ?? d.title,
    evidence: [],
  }));
  const outputs = await pool(full.cases, async (c) => {
    const { findings } = await classifyAgainstCandidates(c.text, register, 'EVAL');
    return { findings: findings.map((f) => ({ decisionId: f.decisionId, relationship: f.relationship, confidence: f.confidence })) };
  });
  const results = Object.fromEntries(full.cases.map((c, i) => [c.id, outputs[i]]));
  return { conflict: scoreConflict(full, results) };
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

    // Held-out sets are measured, not gated: they were written after the
    // prompts and must never be used to tune them, so a threshold on them
    // would invite exactly that.
    const heldOut = {};
    if (suites.includes('extraction-hard')) {
      const r = await runExtraction(extractionHardData);
      heldOut.extraction = r.extraction;
      heldOut.triage = r.triage;
    }
    if (suites.includes('conflict-hard')) heldOut.conflict = (await runConflict(conflictHardData)).conflict;
    if (Object.keys(heldOut).length > 0) report.heldOut = heldOut;

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
