/**
 * Decision register — the full record, and the admin's diagnostic view.
 *
 * Tabs follow the lifecycle a decision moves through. The health panel exists
 * because Teamwork Graph returns empty rather than an error when a scope is
 * missing, so "why is this empty?" needs an answer the page can give itself.
 */

import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  Em,
  Heading,
  Inline,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Text,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const TABS = [
  { status: 'binding', label: 'Binding' },
  { status: 'stale', label: 'Needs review' },
  { status: 'proposed', label: 'Awaiting confirmation' },
  { status: 'superseded', label: 'Superseded' },
];

const detailBox = xcss({
  backgroundColor: 'color.background.neutral',
  borderRadius: 'border.radius',
  padding: 'space.200',
});

function lozengeFor(status) {
  return status === 'binding' ? 'success'
    : status === 'stale' ? 'moved'
    : status === 'proposed' ? 'new'
    : 'default';
}

function Detail({ id, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { invoke('getFullDecision', { decisionId: id }).then(setD); }, [id]);
  if (!d) return <Spinner />;

  return (
    <Box xcss={detailBox}>
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center" spread="space-between">
          <Inline space="space.100" alignBlock="center">
            <Heading size="small">{d.id}</Heading>
            <Lozenge appearance={lozengeFor(d.status)}>{d.statusLabel}</Lozenge>
          </Inline>
          <Button appearance="subtle" onClick={onClose}>Close</Button>
        </Inline>

        <Text><Strong>{d.title}</Strong></Text>
        {d.statement && d.statement !== d.title && <Text>{d.statement}</Text>}

        {d.staleDetail && (
          <SectionMessage appearance="warning" title="Why this needs review">
            <Text>{d.staleDetail}</Text>
          </SectionMessage>
        )}
        {d.supersededBy && (
          <SectionMessage appearance="information" title={`Replaced by ${d.supersededBy}`}>
            <Text>{d.supersedeReason || 'No reason was recorded.'}</Text>
          </SectionMessage>
        )}

        {d.rejected?.length > 0 && (
          <Stack space="space.050">
            <Strong>Alternatives rejected</Strong>
            {d.rejected.map((r) => <Text key={r}>• {r}</Text>)}
          </Stack>
        )}

        {d.assumptions?.length > 0 && (
          <Stack space="space.050">
            <Strong>Rests on</Strong>
            {d.assumptions.map((a) => (
              <Text key={a.text}>
                • {a.text}{a.expiresAt ? ` — recheck by ${a.expiresAt.slice(0, 10)}` : ''}
              </Text>
            ))}
          </Stack>
        )}

        {d.evidence?.length > 0 && (
          <Stack space="space.050">
            <Strong>Evidence</Strong>
            {d.evidence.map((e, i) => (
              <Text key={i}><Em>“{e.quote}”</Em></Text>
            ))}
          </Stack>
        )}

        <Text>
          Scope {d.scopeKey} · decided {d.decidedAt?.slice(0, 10)}
          {d.extractionScore != null ? ` · extraction confidence ${Math.round(d.extractionScore * 100)}%` : ''}
        </Text>
      </Stack>
    </Box>
  );
}

function Health() {
  const [h, setH] = useState(null);
  const [loading, setLoading] = useState(false);
  const run = async () => { setLoading(true); setH(await invoke('health')); setLoading(false); };

  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Button onClick={run} isDisabled={loading}>Run health check</Button>
        {loading && <Spinner size="small" />}
      </Inline>
      {h && (
        <SectionMessage appearance={h.graphReachable ? 'success' : 'warning'}
          title={h.graphReachable ? 'Teamwork Graph reachable' : 'Teamwork Graph not reachable'}>
          <Stack space="space.050">
            <Text>{h.registerSize} decisions in the register, {h.awaitingConfirmation} awaiting confirmation.</Text>
            <Text>{h.note}</Text>
            {h.graphDetail && <Text><Em>{h.graphDetail}</Em></Text>}
          </Stack>
        </SectionMessage>
      )}
    </Stack>
  );
}


// ---------------------------------------------------------------------------
// Sample data — the first thing a new visitor on an empty site sees
// ---------------------------------------------------------------------------

const BUSY = ['queued', 'loading', 'removing'];

function SampleData({ onChange }) {
  const [state, setState] = useState(null);
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);

  const refresh = async () => {
    const next = await invoke('seedStatus');
    setState((prev) => {
      // Tell the register to reload once a job finishes.
      if (prev && BUSY.includes(prev.status) && !BUSY.includes(next.status)) onChange();
      return next;
    });
  };

  useEffect(() => {
    refresh();
    invoke('listProjects').then((r) => {
      setProjects(r.projects ?? []);
      if (r.error) setError(r.error);
    });
  }, []);

  const busy = state && BUSY.includes(state.status);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [busy]);

  const act = async (kind) => {
    setError(null);
    const res = kind === 'load'
      ? await invoke('loadSample', { projectKey: project?.value })
      : await invoke('removeSample');
    if (res?.error) setError(res.error);
    else refresh();
  };

  if (!state) return null;

  if (busy) {
    return (
      <SectionMessage appearance="information" title={state.status === 'removing' ? 'Removing sample data' : 'Loading sample data'}>
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" />
          <Text>{state.progress ?? 'Queued'}</Text>
        </Inline>
      </SectionMessage>
    );
  }

  if (state.status === 'loaded') {
    const bait = (state.issues ?? []).filter((i) => i.ref.startsWith('bait')).map((i) => i.key);
    const proposal = (state.issues ?? []).find((i) => i.ref === 'cadence')?.key;
    return (
      <SectionMessage appearance="success" title={`Sample data loaded in ${state.projectKey}`}>
        <Stack space="space.100">
          <Text>
            {state.issues.length} work items and {state.decisionIds.length} decisions, one of them
            already flagged for review because the assumption it rests on has expired.
          </Text>
          {proposal && <Text>To try confirming a decision: open <Strong>{proposal}</Strong> and its Precedent panel.</Text>}
          {bait.length > 0 && <Text>To try the conflict check: open <Strong>{bait.join(' or ')}</Strong> and press “Check this issue”.</Text>}
          <Inline><Button appearance="subtle" onClick={() => act('remove')}>Remove sample data</Button></Inline>
          {error && <Text><Em>{error}</Em></Text>}
        </Stack>
      </SectionMessage>
    );
  }

  if (state.status === 'failed') {
    return (
      <SectionMessage appearance="error" title="Sample data did not finish">
        <Stack space="space.100">
          <Text>{state.error}</Text>
          <Text>Anything that was created can be cleaned up.</Text>
          <Inline><Button onClick={() => act('remove')}>Remove what was created</Button></Inline>
        </Stack>
      </SectionMessage>
    );
  }

  const options = projects.map((p) => ({ label: `${p.name} (${p.key})`, value: p.key }));
  return (
    <SectionMessage appearance="discovery" title="See Precedent with sample data">
      <Stack space="space.150">
        <Text>
          Adds eight work items to a project you choose, with comments recording real-looking decisions:
          four binding, one awaiting your confirmation, one flagged for review, and two proposals that
          contradict earlier decisions. Everything is labelled {'“precedent-sample”'} and can be removed in one click.
        </Text>
        <Inline space="space.100" alignBlock="center">
          <Box xcss={xcss({ minWidth: '280px' })}>
            <Select options={options} value={project} onChange={setProject}
                    placeholder={projects.length ? 'Choose a project' : 'No projects available'} />
          </Box>
          <Button appearance="primary" isDisabled={!project} onClick={() => act('load')}>Load sample data</Button>
        </Inline>
        {error && <Text><Em>{error}</Em></Text>}
      </Stack>
    </SectionMessage>
  );
}

// ---------------------------------------------------------------------------
// Evaluation scorecard (development environment only)
// ---------------------------------------------------------------------------

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);

function Metric({ label, value, min, max }) {
  const ok = value === null || value === undefined ? null
    : min !== undefined ? value >= min
    : max !== undefined ? value <= max
    : null;
  const target = min !== undefined ? `target ≥ ${pct(min)}` : max !== undefined ? `target ≤ ${pct(max)}` : '';
  return (
    <Inline space="space.100" alignBlock="center">
      {ok === null ? <Lozenge>info</Lozenge> : <Lozenge appearance={ok ? 'success' : 'removed'}>{ok ? 'pass' : 'fail'}</Lozenge>}
      <Text><Strong>{pct(value)}</Strong> {label}{target ? ` (${target})` : ''}</Text>
    </Inline>
  );
}

function Scorecard({ report, heldOut = false }) {
  // Held-out results show as measurements without pass/fail: no thresholds.
  const T = heldOut ? { triage: {}, extraction: {}, conflict: {} } : report.thresholds;
  const e = report.extraction;
  const c = report.conflict;
  const t = report.triage;
  return (
    <Stack space="space.200">
      {heldOut ? (
        <SectionMessage appearance="information" title="Held-out hard set — measured, not gated">
          <Text>Written after the prompts and never used to tune them. These numbers estimate real-world performance.</Text>
        </SectionMessage>
      ) : (
        <SectionMessage appearance={report.passed ? 'success' : 'warning'}
          title={report.passed ? 'All thresholds met' : `${report.failures.length} threshold(s) missed`}>
          <Text>Finished {report.finishedAt?.slice(0, 19).replace('T', ' ')} UTC in {report.durationSeconds}s.</Text>
          {report.failures?.map((f) => <Text key={f}>• {f}</Text>)}
        </SectionMessage>
      )}

      {t && (
        <Stack space="space.075">
          <Strong>Triage gate — free, runs before any model call</Strong>
          <Metric label="of real decisions kept" value={t.recall} min={T.triage.recall} />
          <Text>{t.modelCallsAvoided} model calls avoided on this dataset.</Text>
          {t.missed?.length > 0 && <Text><Em>Dropped before the model: {t.missed.join(', ')}</Em></Text>}
        </Stack>
      )}

      {e && (
        <Stack space="space.075">
          <Strong>Decision extraction — {e.counts.scored} labelled comments</Strong>
          <Metric label="precision" value={e.precision} min={T.extraction.precision} />
          <Metric label="recall" value={e.recall} min={T.extraction.recall} />
          <Metric label="rejected alternatives recovered" value={e.rejectedRecall} min={T.extraction.rejectedRecall} />
          <Metric label="assumptions recovered" value={e.assumptionRecall} />
          <Text>{e.groundingRejections} extraction(s) blocked by the grounding check.</Text>
          {e.falsePositives.map((f) => <Text key={f.id}><Em>False decision: {f.id} — “{f.title}”</Em></Text>)}
          {e.falseNegatives.map((f) => <Text key={f.id}><Em>Missed: {f.id} — {f.reason}</Em></Text>)}
          {e.fieldMisses.map((f) => <Text key={`${f.id}-${f.field}`}><Em>{f.field} not recovered: {f.id}</Em></Text>)}
        </Stack>
      )}

      {c && (
        <Stack space="space.075">
          <Strong>Conflict check — {c.counts.unrelatedPairs + c.counts.contradictionsExpected + c.counts.dependsExpected} proposal × decision pairs</Strong>
          <Metric label="of contradictions caught" value={c.contradictionRecall} min={T.conflict.contradictionRecall} />
          <Metric label="of dependencies caught" value={c.dependencyRecall} />
          <Metric label="false alarm rate" value={c.falseAlarmRate} max={T.conflict.falseAlarmRate} />
          <Metric label="of unrelated proposals left alone" value={c.silenceOnUnrelated} min={T.conflict.silenceOnUnrelated} />
          {c.ambiguousAgreement != null && <Metric label="agreement on ambiguous pairs" value={c.ambiguousAgreement} />}
          {c.alarms.map((a) => <Text key={`${a.case}-${a.decision}`}><Em>False alarm: {a.case} → {a.decision} ({a.got})</Em></Text>)}
          {c.misses.map((m) => <Text key={`${m.case}-${m.decision}`}><Em>Missed: {m.case} → {m.decision} (wanted {m.want}, got {m.got})</Em></Text>)}
        </Stack>
      )}
    </Stack>
  );
}

function Evaluation() {
  const [enabled, setEnabled] = useState(null);
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    invoke('evalStatus').then((s) => { setEnabled(s.enabled); setRun(s.latest); });
  }, []);

  const active = run && (run.status === 'queued' || run.status === 'running');

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(async () => {
      const next = await invoke('getEval', { runId: run.runId });
      if (next) setRun(next);
    }, 5000);
    return () => clearInterval(timer);
  }, [active, run?.runId]);

  if (!enabled) return null;

  const start = async () => {
    setError(null);
    const res = await invoke('startEval', { suite: 'all' });
    if (res?.error) setError(res.error);
    else setRun({ runId: res.runId, status: 'queued' });
  };

  return (
    <Stack space="space.150">
      <Heading size="small">Evaluation</Heading>
      <Text>Scores the live model against labelled datasets. Development only; about 60 model calls per run, including the held-out hard set.</Text>
      <Inline space="space.100" alignBlock="center">
        <Button appearance="primary" isDisabled={active} onClick={start}>
          {active ? 'Running…' : 'Run evaluation'}
        </Button>
        {active && <Spinner size="small" />}
        {active && <Text>{run.status}</Text>}
      </Inline>
      {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
      {run?.status === 'failed' && <SectionMessage appearance="error" title="Run failed"><Text>{run.error}</Text></SectionMessage>}
      {run?.status === 'complete' && <Scorecard report={run} />}
      {run?.status === 'complete' && run.heldOut && <Scorecard report={{ ...run.heldOut }} heldOut />}
    </Stack>
  );
}

function App() {
  const [status, setStatus] = useState('binding');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setData(null);
    setOpen(null);
    invoke('listRegister', { status }).then(setData);
  }, [status, version]);

  const head = {
    cells: [
      { key: 'id', content: 'Id', isSortable: true },
      { key: 'title', content: 'Decision' },
      { key: 'scope', content: 'Scope', isSortable: true },
      { key: 'date', content: 'Decided', isSortable: true },
      { key: 'open', content: '' },
    ],
  };

  const rows = (data?.rows ?? []).map((d) => ({
    key: d.id,
    cells: [
      { key: d.sequence ?? d.id, content: <Strong>{d.id}</Strong> },
      {
        key: `t-${d.id}`,
        content: (d.tags ?? []).includes('sample')
          ? <Inline space="space.100" alignBlock="center"><Text>{d.title}</Text><Lozenge>Sample</Lozenge></Inline>
          : <Text>{d.title}</Text>,
      },
      { key: d.scope, content: <Text>{d.scope}</Text> },
      { key: d.decidedAt ?? '', content: <Text>{d.decidedAt?.slice(0, 10)}</Text> },
      { key: `o-${d.id}`, content: <Button appearance="link" onClick={() => setOpen(d.id)}>View</Button> },
    ],
  }));

  const counts = data?.counts ?? {};

  return (
    <Stack space="space.300">
      <Stack space="space.050">
        <Heading size="large">Decision register</Heading>
        <Text>What this team has decided, why, and whether it still stands.</Text>
      </Stack>

      <SampleData onChange={() => setVersion((v) => v + 1)} />

      <Inline space="space.100">
        {TABS.map((t) => (
          <Button key={t.status} appearance={status === t.status ? 'primary' : 'default'}
                  onClick={() => setStatus(t.status)}>
            {t.label}{counts[t.status] != null ? ` (${counts[t.status]})` : ''}
          </Button>
        ))}
      </Inline>

      {open && <Detail id={open} onClose={() => setOpen(null)} />}

      {!data ? <Spinner label="Loading register" /> : rows.length === 0 ? (
        <SectionMessage appearance="discovery">
          <Text>
            {status === 'binding' && 'No confirmed decisions yet. Captured decisions appear under “Awaiting confirmation” first.'}
            {status === 'stale' && 'Nothing needs review. Every binding decision still stands on its original evidence.'}
            {status === 'proposed' && 'Nothing waiting. New decisions are captured automatically from Jira and Confluence.'}
            {status === 'superseded' && 'No decision has been reversed yet.'}
          </Text>
        </SectionMessage>
      ) : (
        <DynamicTable head={head} rows={rows} rowsPerPage={20} defaultSortKey="id" />
      )}

      <Stack space="space.100">
        <Heading size="small">Health</Heading>
        <Health />
      </Stack>

      <Evaluation />
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
