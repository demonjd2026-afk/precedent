# Installing Precedent

Written for someone who has never seen this app and is working on their own empty Atlassian site. Every step is listed, including the ones that are easy to assume.

**Time required: about 10 minutes**, most of it waiting for a deploy.

---

## What you need first

- An Atlassian Cloud site with **Jira**. Confluence is optional; Precedent reaches it through the Teamwork Graph. A free developer site works: run `forge site provision` if you don't have one.
- **Rovo** available on that site, for the agent and MCP parts. Provisioned developer sites include Rovo.
- **Node.js 20 or later** (`node --version`).
- **Site admin** on the site you're installing to. Precedent requests Teamwork Graph scopes, and only an admin can grant those.

---

## 1. Install the app

```bash
npm install -g @forge/cli
forge login          # paste an API token from id.atlassian.com/manage/api-tokens

git clone <repository-url> precedent
cd precedent
npm install

forge register       # creates your own app id and writes it into manifest.yml
forge deploy
forge install
```

When `forge install` asks which product, **select Jira**. Precedent is a single Jira installation by design, so the decision register stays one register.

You will be shown the list of scopes. Accept all of them. The Teamwork Graph scopes are the ones that matter most — a declined graph scope returns *empty results rather than an error*, so the app will appear to work and quietly show you nothing.

---

## 2. See it work immediately

The app needs decisions in the register before it has anything to say. You have two ways to get them.

### Option A — seed the demo data (recommended for a first look)

```bash
npm run seed -- --project DEMO
```

This creates a Jira project with a handful of realistic issues and comments containing genuine decisions, triggers capture on each, and confirms them. Takes about a minute. Skip to step 3.

### Option B — make a real decision

1. Open any Jira issue.
2. Add a comment that settles something, for example:

   > After comparing both, we're going with Postgres instead of DynamoDB for the ledger store. DynamoDB was ruled out on the migration cost. This assumes our write volume stays under 500/sec, which we should recheck in six months.

3. Wait about 20 seconds. Capture runs asynchronously.
4. Open the **Precedent** panel on that issue. You will see a proposed decision record.
5. Press **Confirm**. It becomes binding and is published to the Teamwork Graph.

**If nothing appears**, the comment probably didn't read as a settled decision. That's the gate working as intended — proposals and questions are deliberately ignored. Use wording that settles something ("we're going with", "we've decided", "ruled out").

---

## 3. See the conflict warning — the main demo

1. Create a **new issue in the same project** with a description that contradicts the decision you just confirmed, for example:

   > Migrate the ledger store to DynamoDB to cut operational overhead.

2. Open the **Precedent** panel on that new issue and press **Check this issue**.
3. The panel names the decision this would reverse, and why.

This is the core of the product: not that it found the decision, but that nobody had to remember the decision existed.

---

## 4. Try the agent

Open **Rovo Chat** (the Chat button in the Jira or Confluence top bar) and select the **Precedent** agent. Ask:

- *"Why did we choose Postgres?"* — answers from the record, citing the id, leading with the rejected alternative.
- *"Does moving to DynamoDB conflict with anything?"* — runs the guard.
- *"Which decisions need review?"* — lists stale records with the specific reason.

Ask it something with no record behind it. It should say there's no record rather than inventing a reason. That refusal is a feature, and worth testing.

---

## 5. Optional — Teamwork Graph connector

Makes decisions appear in Atlassian Search and to other agents, not just in this app.

1. Go to [admin.atlassian.com](https://admin.atlassian.com) → **Apps** → **Sites** → your site → **Connected apps**.
2. Select **Precedent** → **Connections** tab → **Connect**.
3. Give the connection any nickname and save.

On connect, every confirmed decision is backfilled into the graph. Search for a decision title in Atlassian Search to confirm.

---

## 6. Optional — MCP from your own editor

Lets you ask what constrains a piece of work from Claude or Cursor, before writing code.

1. In **admin.atlassian.com** → **Apps** → **Sites** → your site → **Connected apps**, select **Precedent**, open its app details, and **turn on the tools**. External MCP exposure is off by default.
2. Add this to your MCP client's remote server configuration:

   ```
   https://mcp.atlassian.com/forge/<appId>
   ```

   `<appId>` is the UUID from `app.id` in `manifest.yml` — the part after `ari:cloud:ecosystem::app/`.
3. Your client opens an OAuth consent screen. Pick the site, review the tools, approve.
4. Ask it: *"Check with Precedent whether moving the ledger to DynamoDB conflicts with anything."*

---

## Troubleshooting

**The panel is empty and says nothing.**
Open **Apps → Decision register → Health**. It reports whether Teamwork Graph is reachable and how many records exist, which separates "no decisions yet" from "scopes not granted".

**Decisions aren't being captured.**
Check `forge logs`. Triage decisions are logged with their reason. `"no decision language present"` means the comment read as discussion, not a decision — that's correct behaviour, not a failure.

**A decision was captured that isn't one.**
Press **Not a decision** in the panel. The record is kept as rejected so the same source isn't re-extracted.

**Everything suddenly shows as needing review.**
Something edited the source pages. Open any flagged record to see exactly which source changed and how much of it.

**`forge deploy` fails on the manifest.**
Run `forge lint`. The Preview modules (`rovo:skill`, `rovo:mcp`) and the Teamwork Graph connector require a current CLI — `npm install -g @forge/cli@latest`.
