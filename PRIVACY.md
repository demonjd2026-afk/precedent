# Precedent — Privacy Policy

_Last updated: 9 November 2026_

Precedent is a Jira app built on Atlassian Forge by Jayanth Dolai, an independent developer. This policy describes exactly what the app does with data. It runs entirely on Atlassian's infrastructure and carries the **Runs on Atlassian** designation: no data is sent to servers operated by the developer or any other third party.

## What Precedent stores

All data is held in Atlassian-hosted Forge storage, inside your Atlassian site's installation of the app.

- **Decision records** — what was decided, the alternatives that were rejected, the assumptions it rests on, its status, and the project it belongs to.
- **Evidence** — short verbatim quotes from the Jira comment a decision came from, a link to that comment, and a fingerprint (hash) of the comment text, used to detect when the source is later edited.
- **Atlassian account IDs** — of the person who posted a decision and of the person who confirmed, dismissed or superseded it. Precedent does not store names, email addresses or any other profile information.
- **App settings** — such as the Teamwork Graph connection and the sample-data state.

## How data is processed

- **AI processing.** To recognise decisions and check new work against them, comment text and work item descriptions are processed by large language models hosted by Atlassian through the Forge LLMs service. This processing stays within Atlassian's platform.
- **Teamwork Graph (optional).** If a site administrator connects Precedent's Teamwork Graph connector, confirmed decision records are made searchable across the Atlassian workspace, in Atlassian Search and Rovo. Records synced this way are visible to everyone in the workspace; this is declared to administrators on the connector setup screen before they enable it. Decisions awaiting confirmation are never synced.
- **MCP tools (optional).** If a site administrator enables MCP access, users who connect an MCP-compatible AI client can use Precedent's read-only tools through Atlassian's MCP service. Those tools act with the connecting user's own permissions and cannot create or change decisions.

## What the developer can see

The developer cannot access your decision records. Operational logs, available to the developer through Atlassian Forge, contain identifiers and counts (for example a decision id such as DR-14, or a Jira issue key) and are deliberately designed to exclude comment text, quotes and account IDs. An automated test in the source code enforces this.

## Retention and deletion

- Decision records are kept while the app is installed, because a history of decisions is the purpose of the app. Superseded decisions are kept, not deleted.
- **Closed accounts.** Every week Precedent reports the account IDs it stores to Atlassian's Personal Data Reporting API. When Atlassian reports an account as closed, Precedent removes that account ID from every record.
- **Uninstall.** When the app is uninstalled, its Forge storage is deleted by Atlassian according to Atlassian's Forge data deletion process. Data synced to the Teamwork Graph is removed by Atlassian when the connector is disconnected.
- **Sample data.** Sample work items and decisions created by the in-app sample loader can be removed at any time with "Remove sample data".

## Your rights and contact

Precedent processes data on behalf of the organisation that installs it, which controls that data. Questions or requests about this policy can be raised at <https://github.com/demonjd2026-afk/precedent/issues>.

Atlassian's own handling of data on its platform is described in the [Atlassian Privacy Policy](https://www.atlassian.com/legal/privacy-policy).
