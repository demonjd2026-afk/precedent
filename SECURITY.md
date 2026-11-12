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

## Incident response

If a security incident or a critical vulnerability affects Precedent, I follow Atlassian's Marketplace guidelines (https://developer.atlassian.com/platform/marketplace/app-security-incident-management-guidelines/):

1. **Contain.** Stop the harm first: deploy a fix, or disable the affected feature or the app's production environment.
2. **Notify Atlassian** through the Marketplace security channel as soon as the incident is confirmed, and **notify affected customers** using Atlassian's vulnerability notification template.
3. **Fix and verify.** Ship the fix within Atlassian's security bug fix policy timelines (https://developer.atlassian.com/platform/marketplace/security-bugfix-policy/), and confirm it with a test that reproduces the problem.
4. **Review.** Publish a short summary of what happened, what was affected and what changed, and record the lessons in this repository.

Because the app stores data only in Forge storage on each customer's site and makes no calls outside Atlassian, an incident is limited to the app's own behaviour on a site. There is no separate database or server of mine to breach.

## Supported versions

Only the latest version is supported. Forge deploys updates to every installation automatically.

## Data handling

What the app stores, and how it's removed, is described in [PRIVACY.md](PRIVACY.md).
