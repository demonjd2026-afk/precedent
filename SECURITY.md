# Security policy

## Reporting a vulnerability

Please don't report security problems in a public issue.

Report them privately through GitHub: open https://github.com/demonjd2026-afk/precedent/security/advisories/new and describe the problem, how to reproduce it, and what it affects. You can also email precedent.app.support@gmail.com.

I'll acknowledge a report within 2 business days, keep you updated while it's investigated, and credit you when the fix ships unless you'd rather not be named.

## Scope

Precedent is a Forge app that runs entirely on Atlassian's platform:

- Data is stored only in Forge storage on the customer's Atlassian site.
- AI calls use Forge LLM, hosted by Atlassian. The app declares no external fetch permissions and makes no calls to servers outside Atlassian.
- The app has no web triggers. Its MCP tools are reached only through Atlassian's MCP gateway, are read-only, and must be enabled by a site admin.
- Users never provide passwords, API tokens or other secrets to the app.

Vulnerabilities in Atlassian's own platform should be reported to Atlassian: https://www.atlassian.com/trust/security/report-a-vulnerability

## Supported versions

Only the latest version is supported. Forge deploys updates to every installation automatically.

## Data handling

What the app stores, and how it's removed, is described in [PRIVACY.md](PRIVACY.md).
