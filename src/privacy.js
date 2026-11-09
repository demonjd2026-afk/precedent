/**
 * Weekly personal data report, as Atlassian requires of every app that stores
 * account IDs. Reports each stored ID, then erases any account Atlassian
 * reports as closed. "Updated" needs no action: Precedent stores IDs only, no
 * profile data that could go stale.
 */

import { privacy } from '@forge/api';
import { STATUS } from './lib/model.js';
import { listByStatus, putDecision } from './lib/store.js';
import { collectAccounts, eraseAccount } from './lib/privacy-core.js';
import { log } from './lib/log.js';

const BATCH = 90;

export async function reportPersonalData() {
  log.reset();
  const records = [];
  for (const status of Object.values(STATUS)) records.push(...(await listByStatus(status, 5000)));

  const accounts = collectAccounts(records);
  if (accounts.length === 0) {
    log.info('privacy report: no account ids stored');
    return { reported: 0, erased: 0 };
  }

  const closed = new Set();
  for (let i = 0; i < accounts.length; i += BATCH) {
    const updates = await privacy.reportPersonalData(accounts.slice(i, i + BATCH));
    for (const u of updates ?? []) if (u.status === 'closed') closed.add(u.accountId);
  }

  let erased = 0;
  for (const accountId of closed) {
    for (const record of records) {
      const cleaned = eraseAccount(record, accountId);
      if (!cleaned) continue;
      await putDecision(cleaned);
      Object.assign(record, cleaned);
      erased += 1;
    }
  }

  log.info('privacy report complete', { reported: accounts.length, closedAccounts: closed.size, recordsUpdated: erased });
  return { reported: accounts.length, erased };
}
