/**
 * Personal data handling — pure logic, no Forge imports, so it is tested.
 *
 * Precedent stores no names or email addresses. The only personal data it
 * keeps is Atlassian account IDs: who recorded a decision (`deciders`) and who
 * confirmed, rejected or superseded it (`confirmedBy`). Comment quotes kept as
 * evidence are the customer's own content, copied from their Jira site.
 */

/**
 * Every account ID held in the register, with the most recent time data for it
 * was stored, in the shape the Personal Data Reporting API expects.
 *
 * @param {import('./model.js').DecisionRecord[]} records
 * @returns {{accountId: string, updatedAt: string}[]}
 */
export function collectAccounts(records) {
  const latest = new Map();
  for (const r of records) {
    const stamp = r.updatedAt ?? r.createdAt ?? new Date(0).toISOString();
    const ids = [...(r.deciders ?? []), ...(r.confirmedBy ? [r.confirmedBy] : [])];
    for (const id of ids) {
      if (!id || typeof id !== 'string') continue;
      if (!latest.has(id) || latest.get(id) < stamp) latest.set(id, stamp);
    }
  }
  return [...latest.entries()].map(([accountId, updatedAt]) => ({ accountId, updatedAt }));
}

/**
 * Remove an account from a record. Returns the cleaned record, or null when
 * the account does not appear in it (so the caller writes only what changed).
 *
 * @param {import('./model.js').DecisionRecord} record
 * @param {string} accountId
 */
export function eraseAccount(record, accountId) {
  const inDeciders = (record.deciders ?? []).includes(accountId);
  const inConfirmed = record.confirmedBy === accountId;
  if (!inDeciders && !inConfirmed) return null;

  const cleaned = { ...record, deciders: (record.deciders ?? []).filter((id) => id !== accountId) };
  if (inConfirmed) delete cleaned.confirmedBy;
  return cleaned;
}
