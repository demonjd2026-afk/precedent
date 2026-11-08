/**
 * Sample data: a small legal and operations team's real-looking decision history.
 *
 * Pure data, no Forge imports, so test/seed.test.js can verify every quote is
 * verbatim in its comment before a single API call is made. Seeded decisions go
 * through the same rules as captured ones: grounded quotes, hashed evidence,
 * validation on write.
 *
 * Each lifecycle state appears at least once, so every screen has something
 * honest to show:
 *   binding     — four decisions
 *   stale       — one, through a genuinely expired assumption (real expiry check)
 *   proposed    — one, to demonstrate the confirmation flow
 * plus two work items whose descriptions contradict a binding decision, so the
 * conflict check can be tried immediately.
 */

export const SAMPLE_LABEL = 'precedent-sample';

/**
 * @typedef {Object} SampleDecision
 * @property {'binding'|'proposed'} status   Stale is reached via the real expiry check.
 * @property {string} title
 * @property {string} statement
 * @property {string} quote                   Verbatim from `comment`.
 * @property {{option: string, quote: string}[]} [rejected]
 * @property {{text: string, quote: string, expiresAt?: string}[]} [assumptions]
 * @property {string} [decidedAt]             ISO date, only when the comment states one.
 * @property {string[]} tags
 */

/**
 * @typedef {Object} SampleItem
 * @property {string} ref                     Stable handle used by tests and removal.
 * @property {string} summary
 * @property {string} description
 * @property {string} [comment]
 * @property {SampleDecision} [decision]
 */

/** @type {SampleItem[]} */
export const SAMPLE_ITEMS = [
  {
    ref: 'nda',
    summary: 'Standardise vendor NDAs',
    description: 'Agree one NDA approach for small vendor agreements so legal review stops being the bottleneck.',
    comment:
      "Agreed in today's legal sync: we're going with the standard mutual NDA template for all vendor agreements under $50k instead of negotiating custom terms. Custom redlines were ruled out because review was taking three weeks per contract. This assumes our insurer's liability cap stays at $2M.",
    decision: {
      status: 'binding',
      title: 'Use the standard mutual NDA template for vendor agreements under $50k',
      statement: 'All vendor agreements under $50k use the standard mutual NDA template instead of negotiated custom terms.',
      quote: "we're going with the standard mutual NDA template for all vendor agreements under $50k instead of negotiating custom terms",
      rejected: [{ option: 'Negotiating custom redlines per vendor', quote: 'Custom redlines were ruled out because review was taking three weeks per contract' }],
      assumptions: [{ text: "The insurer's liability cap stays at $2M", quote: "This assumes our insurer's liability cap stays at $2M" }],
      tags: ['nda', 'legal', 'vendor', 'contracts'],
    },
  },
  {
    ref: 'esign',
    summary: 'Choose an e-signature tool',
    description: 'Pick one e-signature tool for all contracts.',
    comment:
      "Decision from the vendor review: we're going with DocuSign for all contract e-signatures instead of Adobe Sign. Adobe Sign was ruled out because it doesn't support our SSO setup. This assumes DocuSign's pricing holds at the current tier.",
    decision: {
      status: 'binding',
      title: 'Use DocuSign for all contract e-signatures',
      statement: 'DocuSign is the e-signature tool for all contracts. Adobe Sign was rejected because it does not support the SSO setup.',
      quote: "we're going with DocuSign for all contract e-signatures instead of Adobe Sign",
      rejected: [{ option: 'Adobe Sign', quote: "Adobe Sign was ruled out because it doesn't support our SSO setup" }],
      assumptions: [{ text: "DocuSign's pricing holds at the current tier", quote: "This assumes DocuSign's pricing holds at the current tier" }],
      tags: ['e-signature', 'docusign', 'contracts'],
    },
  },
  {
    ref: 'sla',
    summary: 'Set the enterprise support SLA',
    description: 'Agree a first-response target for enterprise tickets.',
    comment:
      'We settled on a 4-hour first-response SLA for enterprise tickets rather than 1 hour. One hour was ruled out because it would need a night shift. This assumes enterprise ticket volume stays under 300 a week.',
    decision: {
      status: 'binding',
      title: '4-hour first-response SLA for enterprise tickets',
      statement: 'Enterprise tickets get a 4-hour first-response SLA rather than 1 hour.',
      quote: 'We settled on a 4-hour first-response SLA for enterprise tickets rather than 1 hour',
      rejected: [{ option: '1-hour first-response SLA', quote: 'One hour was ruled out because it would need a night shift' }],
      assumptions: [{ text: 'Enterprise ticket volume stays under 300 a week', quote: 'This assumes enterprise ticket volume stays under 300 a week' }],
      tags: ['sla', 'support', 'enterprise'],
    },
  },
  {
    ref: 'expenses',
    summary: 'Update the expense approval policy',
    description: 'Tighten approval for large expense reports after the audit.',
    comment:
      'Final call from finance: expense reports over $5,000 now require CFO approval instead of department-head approval. Department-head-only approval was ruled out after the September audit finding.',
    decision: {
      status: 'binding',
      title: 'Expense reports over $5,000 require CFO approval',
      statement: 'Expense reports above $5,000 need CFO approval; department-head approval alone is no longer enough.',
      quote: 'expense reports over $5,000 now require CFO approval instead of department-head approval',
      rejected: [{ option: 'Department-head-only approval', quote: 'Department-head-only approval was ruled out after the September audit finding' }],
      tags: ['expenses', 'finance', 'approval'],
    },
  },
  {
    // Becomes stale through the real expiry check: the rate it depends on was
    // only guaranteed until a date that has already passed.
    ref: 'ads',
    summary: 'Plan paid channels for the Q1 launch',
    description: 'Decide where the Q1 launch acquisition budget goes.',
    comment:
      "From the 15 September planning review: we're going with LinkedIn ads for the Q1 launch, not Google Display. Display was ruled out after last quarter's 0.2% click-through rate. LinkedIn's introductory rate of $7 per click is only guaranteed until 31 October, so this needs rechecking after that.",
    decision: {
      status: 'binding',
      title: 'Use LinkedIn ads for the Q1 launch',
      statement: 'Paid acquisition for the Q1 launch runs on LinkedIn ads, not Google Display.',
      quote: "we're going with LinkedIn ads for the Q1 launch, not Google Display",
      decidedAt: '2026-09-15T00:00:00.000Z',
      rejected: [{ option: 'Google Display ads', quote: "Display was ruled out after last quarter's 0.2% click-through rate" }],
      assumptions: [{
        text: "LinkedIn's introductory rate of $7 per click holds",
        quote: "LinkedIn's introductory rate of $7 per click is only guaranteed until 31 October",
        expiresAt: '2026-10-31T23:59:59.000Z',
      }],
      tags: ['ads', 'marketing', 'q1 launch', 'linkedin'],
    },
  },
  {
    // Left unconfirmed so the confirmation flow can be tried.
    ref: 'cadence',
    summary: 'Agree a vendor review cadence',
    description: 'Decide how often we review active vendors.',
    comment:
      "Agreed with procurement today: we're going with quarterly vendor reviews instead of monthly ones. Monthly reviews were ruled out because nobody had time to act on the findings.",
    decision: {
      status: 'proposed',
      title: 'Quarterly vendor reviews instead of monthly',
      statement: 'Vendor reviews move to a quarterly cadence.',
      quote: "we're going with quarterly vendor reviews instead of monthly ones",
      rejected: [{ option: 'Monthly vendor reviews', quote: 'Monthly reviews were ruled out because nobody had time to act on the findings' }],
      tags: ['vendor', 'procurement', 'review'],
    },
  },
  {
    ref: 'bait-esign',
    summary: 'Switch e-signatures to Adobe Sign',
    description: 'Move contract signing over to Adobe Sign, since marketing already pays for an Adobe licence. Should save us the DocuSign renewal.',
  },
  {
    ref: 'bait-expenses',
    summary: 'Let department heads approve larger expenses',
    description: 'Let department heads approve expense reports up to $10k on their own, to speed up reimbursements.',
  },
];
