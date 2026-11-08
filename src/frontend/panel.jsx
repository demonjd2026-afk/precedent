/**
 * Issue panel — the demo's centre of gravity.
 *
 * Three jobs, in the order a person needs them:
 *   1. Confirm or dismiss decisions captured from this issue.
 *   2. Check this issue against everything already decided.
 *   3. Show what already binds this project, and what has gone stale.
 *
 * The conflict check runs on demand, never on load: it costs a model call,
 * and a panel that bills on every page view is a panel an admin uninstalls.
 */

import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Em,
  Heading,
  Inline,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Text,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const card = xcss({
  borderColor: 'color.border',
  borderStyle: 'solid',
  borderWidth: 'border.width',
  borderRadius: 'border.radius',
  padding: 'space.150',
});

const quote = xcss({
  borderLeftColor: 'color.border.discovery',
  borderLeftStyle: 'solid',
  borderLeftWidth: 'border.width.outline',
  paddingLeft: 'space.100',
});

function StatusLozenge({ status, label }) {
  const appearance =
    status === 'binding' ? 'success'
    : status === 'stale' ? 'moved'
    : status === 'superseded' ? 'default'
    : status === 'proposed' ? 'new'
    : 'default';
  return <Lozenge appearance={appearance}>{label ?? status}</Lozenge>;
}

// ---------------------------------------------------------------------------
// 1. Proposals awaiting a human
// ---------------------------------------------------------------------------
function Proposal({ d, onDone }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const act = async (kind) => {
    setBusy(kind);
    setError(null);
    const res = await invoke(kind === 'confirm' ? 'confirmDecision' : 'rejectProposal', {
      decisionId: d.id,
    });
    setBusy(null);
    if (res?.ok) onDone();
    else setError(res?.error ?? 'Something went wrong. Try again.');
  };

  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center">
          <Strong>{d.id}</Strong>
          <StatusLozenge status="proposed" label="Awaiting confirmation" />
          {(d.tags ?? []).includes('sample') && <Lozenge>Sample</Lozenge>}
        </Inline>
        <Text>{d.title}</Text>

        {d.evidence?.[0]?.quote && (
          <Box xcss={quote}>
            <Text><Em>“{d.evidence[0].quote}”</Em></Text>
          </Box>
        )}

        {d.rejected?.length > 0 && (
          <Text><Strong>Rejected:</Strong> {d.rejected.join(' · ')}</Text>
        )}
        {d.assumptions?.length > 0 && (
          <Text><Strong>Assumes:</Strong> {d.assumptions.map((a) => a.text).join(' · ')}</Text>
        )}

        {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}

        <Inline space="space.100">
          <Button appearance="primary" isDisabled={!!busy} onClick={() => act('confirm')}>
            {busy === 'confirm' ? 'Confirming…' : 'Confirm decision'}
          </Button>
          <Button appearance="subtle" isDisabled={!!busy} onClick={() => act('reject')}>
            {busy === 'reject' ? 'Dismissing…' : 'Not a decision'}
          </Button>
        </Inline>
      </Stack>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// 2. Conflict check
// ---------------------------------------------------------------------------
function Finding({ f }) {
  const contradicts = f.relationship === 'contradicts';
  return (
    <SectionMessage
      appearance={contradicts ? 'warning' : 'information'}
      title={contradicts ? `Contradicts ${f.decisionId}` : `Depends on ${f.decisionId}`}
    >
      <Stack space="space.050">
        <Text><Strong>{f.title}</Strong></Text>
        {f.reason && <Text>{f.reason}</Text>}
        {f.staleDetail && (
          <Text><Em>{f.decisionId} is itself flagged for review: {f.staleDetail}</Em></Text>
        )}
      </Stack>
    </SectionMessage>
  );
}

function ConflictCheck() {
  const [state, setState] = useState({ status: 'idle' });

  const run = async () => {
    setState({ status: 'running' });
    try {
      const res = await invoke('checkThisIssue', {});
      setState({ status: 'done', ...res });
    } catch (e) {
      setState({ status: 'error', message: e?.message ?? 'Check failed.' });
    }
  };

  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Button appearance={state.status === 'done' ? 'default' : 'primary'}
                isDisabled={state.status === 'running'} onClick={run}>
          {state.status === 'done' ? 'Check again' : 'Check this issue against past decisions'}
        </Button>
        {state.status === 'running' && <Spinner size="small" />}
      </Inline>

      {state.status === 'error' && (
        <SectionMessage appearance="error"><Text>{state.message}</Text></SectionMessage>
      )}

      {state.status === 'done' && state.findings?.length === 0 && (
        <SectionMessage appearance="success"><Text>{state.summary}</Text></SectionMessage>
      )}

      {state.status === 'done' && state.findings?.map((f) => <Finding key={f.decisionId} f={f} />)}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// 3. What binds this project
// ---------------------------------------------------------------------------
function DecisionLine({ d }) {
  return (
    <Stack space="space.025">
      <Inline space="space.100" alignBlock="center">
        <Strong>{d.id}</Strong>
        <StatusLozenge status={d.status} label={d.statusLabel} />
        {(d.tags ?? []).includes('sample') && <Lozenge>Sample</Lozenge>}
      </Inline>
      <Text>{d.title}</Text>
      {d.status === 'stale' && d.staleDetail && <Text><Em>{d.staleDetail}</Em></Text>}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      setData(await invoke('getPanelData'));
    } catch (e) {
      setError(e?.message ?? 'Could not load the decision register.');
    }
  };

  useEffect(() => { load(); }, []);

  if (error) return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
  if (!data) return <Spinner label="Loading decisions" />;

  const { proposals, binding, needsReview, counts, projectKey } = data;
  const empty = counts.binding === 0 && counts.needsReview === 0 && counts.proposals === 0;

  return (
    <Stack space="space.300">
      {proposals.length > 0 && (
        <Stack space="space.100">
          <Heading size="xsmall">Captured from this issue</Heading>
          {proposals.map((d) => <Proposal key={d.id} d={d} onDone={load} />)}
        </Stack>
      )}

      <Stack space="space.100">
        <Heading size="xsmall">Precedent check</Heading>
        <ConflictCheck />
      </Stack>

      {needsReview.length > 0 && (
        <Stack space="space.150">
          <Heading size="xsmall">Needs review in {projectKey} ({counts.needsReview})</Heading>
          {needsReview.map((d) => <DecisionLine key={d.id} d={d} />)}
        </Stack>
      )}

      {binding.length > 0 && (
        <Stack space="space.150">
          <Heading size="xsmall">Binding in {projectKey} ({counts.binding})</Heading>
          {binding.map((d) => <DecisionLine key={d.id} d={d} />)}
        </Stack>
      )}

      {empty && (
        <SectionMessage appearance="discovery" title="No decisions recorded for this project yet">
          <Text>
            When a comment settles something — “we’re going with Postgres instead of DynamoDB” —
            Precedent captures it here for you to confirm.
          </Text>
        </SectionMessage>
      )}

      <Text>Full history: <Strong>Apps → Decision register</Strong></Text>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
