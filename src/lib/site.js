/**
 * The site's base URL, e.g. https://acme.atlassian.net.
 *
 * Asked of Jira once and cached, rather than inferred from event payloads:
 * comment events do not reliably carry a self link, and an inferred fallback
 * produced relative evidence URLs that the Teamwork Graph rejects.
 */

import api, { route } from '@forge/api';
import { getState, setState } from './store.js';
import { log } from './log.js';

const KEY = 'precedent:site-url';

export async function siteUrl() {
  const cached = await getState(KEY);
  if (cached) return cached;
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/serverInfo`);
    if (!res.ok) return '';
    const { baseUrl } = await res.json();
    const clean = String(baseUrl ?? '').replace(/\/+$/, '');
    if (/^https:\/\//.test(clean)) {
      await setState(KEY, clean);
      return clean;
    }
  } catch (err) {
    log.warn('could not resolve site url', { error: err?.message });
  }
  return '';
}

export { absolutise } from './url.js';
