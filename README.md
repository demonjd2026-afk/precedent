# Precedent

**Decision memory for Atlassian teams.**

Atlassian's Teamwork Graph connects goals, work, people, decisions and outcomes. Three of those are real objects in the graph. Decisions are not.

Decisions happen in a Jira comment that settles an argument, a Confluence page nobody links to again, an approval in a service request. Then they evaporate. Six months later nobody knows why the team chose this vendor, who signed off, what it assumed, or whether that assumption still holds — so the debate reruns from scratch, and every AI agent re-answers it wrong, because none of them has any memory of what was already settled.

Precedent makes decisions first-class citizens of the graph.

---

## What it does

**Captures** — detects when a decision has actually been *made* in the flow of work and extracts a structured record: what was decided, by whom, which alternatives were rejected, which assumptions it rests on, and what it binds.

**Binds** — writes those records into Teamwork Graph, so decisions become searchable entities alongside work items, pages and goals, and surface in Search and Rovo Chat without anyone opening this app.

**Guards** — when new work lands inside a decision's scope, it says so: *"This contradicts DR-14, decided twelve weeks ago, because the migration cost it rejected is the cost this proposal takes on."*

**Expires** — assumptions rot. A daily sweep re-checks every binding decision for expired assumptions, deleted references, and **evidence drift**: the source a decision was based on being edited after the fact. A decision log that knows when it might be wrong is a memory. One that doesn't is a graveyard.

---

## Why it should be believed

Three design commitments do the work:

**Nothing is recorded that cannot be quoted.** Every field the model produces must carry a verbatim span from the source. `enforceGrounding` then checks that span actually appears in the text and drops the claim if it doesn't. A fabricated decision record is worse than no register at all, so hallucination is handled as a data-integrity constraint in code, not as a prompting style.

**Nothing becomes binding without a human.** Extraction always lands as `proposed`. Only a person pressing confirm makes a record citable by the agent or visible in org-wide search. This is asserted in the test suite, not just intended.

**Silence is a first-class outcome.** The conflict checker reports nothing below 0.6 confidence and says so plainly. A tool that finds a problem every time is muted within a week, and then it may as well not exist.

---

## Architecture

```
Jira comment / issue / Confluence page edited
        │
        ▼
  trigger (25s budget)
    ├── lexical triage ──── rejected ──▶ stop, no model call, no cost
    └── accepted ──▶ async queue
                        │
                        ▼
              capture worker (300s budget)
                    │
                    ├── Forge LLM (Haiku) — grounded extraction
                    ├── quote verification — ungrounded claims dropped
                    └── register (custom entity store) as PROPOSED
                                    │
                             human confirms
                                    │
                    ┌───────────────┼────────────────┐
                    ▼               ▼                ▼
            Teamwork Graph     Jira panel      Rovo agent / MCP
            (search, Rovo)     (warnings)      (chat, Claude, Cursor)

  daily sweep (900s budget) ──▶ expiry · evidence drift · dangling refs
```

Costs are shaped deliberately. Forge LLMs carry **no free usage allowance** — every token is billed to the app developer — so the free lexical gate rejects most traffic before any model call, Haiku does the high-volume extraction, and Sonnet is reserved for the one call a user actually reads.

### Platform constraints this design respects

| Constraint | How it's handled |
|---|---|
| Trigger functions get 25s; actions 55s | All model work runs on async consumers with explicit `timeoutSeconds` |
| `requestTeamworkGraph` exists on `asUser()` only | Graph reads happen on user-initiated paths; the background sweep records what it *couldn't* verify rather than assuming it's fine |
| A missing graph scope returns empty, not an error | Every read returns `{rows, empty, errors}` so the UI can distinguish "nothing found" from "no permission" |
| KVS pages are capped | Every list read paginates; nothing silently truncates |
| Forge scope cap is 50 | 16 declared, each tied to a specific object type the queries actually touch |
| Connector terms forbid HR, health and regulated financial data | Only decision records derived from the customer's own Jira/Confluence content; deciders stored as account ids, never names or emails |

---

## Layout

```
manifest.yml              All modules; storage entities and indexes
src/
  actions.js              The six actions — one implementation, four surfaces
  triggers.js             Thin event handlers; triage then enqueue
  workers.js              Async consumers and the daily sweep
  connector.js            Teamwork Graph ingestion
  panels.js               UI resolvers (the only user-context paths)
  engine/
    detect.js             Free lexical gate + ADF flattening
    extract.js            Grounded extraction via tool calling
    conflict.js           Recall → precision → confidence floor
    staleness.js          Expiry, evidence drift, dangling references
  lib/
    model.js              The decision record and its validation rules
    store.js              Indexed register, paginated reads, id allocation
    llm.js                Structured output + grounding enforcement
    graph.js              Teamwork Graph reader with honest empty-results
    hash.js               Normalisation, hashing, drift classification
    log.js                Budgeted structured logging
skills/                   Two SKILL.md playbooks
resources/agent/          The agent prompt
test/                     20 tests over the pure logic
```

## Running the tests

```bash
node --test test/engine.test.js
```

The engine modules have no Forge imports by design, so the parts that decide what reaches the register are testable without a deployed app.

## Install

See [docs/INSTALL.md](docs/INSTALL.md).

## Licence

MIT
