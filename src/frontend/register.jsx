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

function App() {
  const [status, setStatus] = useState('binding');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    setData(null);
    setOpen(null);
    invoke('listRegister', { status }).then(setData);
  }, [status]);

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
      { key: `t-${d.id}`, content: <Text>{d.title}</Text> },
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
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
