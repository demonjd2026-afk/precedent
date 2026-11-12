# Installing Precedent

Written for someone who has never seen this app and is working on their own empty Atlassian site. Every step is listed, including the ones that are easy to assume.

**Time required: about 5 minutes.**

---

## What you need

- An Atlassian Cloud site with **Jira**, and **site admin** rights on it. Precedent asks for Teamwork Graph scopes, which only an admin can grant.
- At least one Jira project (space) to try it in.
- **Rovo** on the site for steps 4 and 6 only (the chat agent and MCP tools). Rovo is not part of Jira's Free plan: if your site shows **Upgrade** where **Ask Rovo** would be, skip those steps. Developer sites created with `forge site provision` include Rovo.

| Works on any Jira Cloud site, including Free | Needs Rovo |
|---|---|
| Decision capture from comments, confirmation, the decision register, the conflict check, staleness, sample data | The Precedent agent in Rovo Chat; MCP tools for external AI clients |

All of Precedent's own AI runs on Atlassian-hosted models through Forge, so the core features need no Rovo licence.

---

## 1. Install

1. **[Install Precedent](https://developer.atlassian.com/console/install/25ffbde5-7905-491b-8f9f-1bce3fed7de9?signature=AYABeDyPZ8Wjt715iskciBFBGNkAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBBGkKOe0%2FvccRxu918mRRxQAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDGnUJZO%2BP6fZzIYHawIBEIA7%2FLJbWz1Wgou7E6blbEy7%2Bf%2FhagpCkz1Z1k6Nw9bkb9uTOgquby%2FGpEoV%2FWBBNMVsT6aqZLUsbk%2Bl%2F3wAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgGc8A3ksbtLvz81ATrPybd1AAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQM8kuGyM%2F4RiRFR1pbAgEQgDtslbfng%2FctfzdXkBuVxD%2FZ3Bn%2F%2FZqFeL3kQOOW%2FHHfuG%2FdLFDWgNsgAdjfBhgeH58TvnJULklEXcO8DQAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEATa7vBTu8clWoy%2F0Df57nOUAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAxTuBdnO6SIydTy74ECARCAO2LkZ1%2FqLnWR7RJ5bJnJymaVMNymPTqxgHoTlttTyoG0WExeUn7yicWSDKcF1uBOEDJRq0D%2Frh397b4AAgAAAAAMAAAQAAAAAAAAAAAAAAAAAOsJlhKR6Np0nIBzPcAQTBD%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADK9irWueEaZ5i50DM%2BtQ1ljSWTUxuBCPBHUclHjHLYdkH9p5pkuql0HZwuxtIAUoUMg%2BJJLRnwYRQaDhhFOw%2BKyNSk%3D&product=jira)**, signed in as a site admin.
2. Choose your site and **Jira**, then **Get app**.
3. Review the permissions and accept them all. A declined Teamwork Graph permission does not cause an error: it returns empty results, so the app looks fine but shows less.

It takes about a minute. Precedent then appears under **Apps → Decision register**, and as a panel on every work item, reached through **View app actions** (the hexagon button under a work item's title).

---

## 2. See it work immediately

The app needs decisions in the register before it has anything to say. You have two ways to get them.

### Option A — load sample data (recommended for a first look)

1. In Jira, open **Apps → Decision register**.
2. In the **See Precedent with sample data** card at the top, choose any project and press **Load sample data**.

In about half a minute this adds eight work items with comments, and six decisions: four binding, one awaiting your confirmation, and one already flagged for review because the assumption behind it has expired. Two of the work items contradict earlier decisions, so the conflict check can be tried immediately. The card names the work items to open.

Everything is labelled `precedent-sample`, and **Remove sample data** deletes exactly what was created. Sample decisions follow the same rules as captured ones: every quote is verbatim in its comment, and every evidence link opens the real comment.

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

## 4. Try the agent (needs Rovo)

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

## 6. Optional — MCP from your own editor (needs Rovo)

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

---

## Build from source (optional)

For reviewing or modifying the code rather than trying the app.

```bash
npm install -g @forge/cli
forge login
git clone https://github.com/demonjd2026-afk/precedent.git
cd precedent
npm install
forge register      # creates your own app id in manifest.yml
forge deploy
forge install       # choose Jira
npm test            # 54 tests, no Atlassian site needed
```
