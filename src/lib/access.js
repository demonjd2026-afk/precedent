/**
 * What the current user is allowed to see.
 *
 * Decisions are stored by the app and quote Jira content the app read with its
 * own access. Before any of that reaches a person, through the panel, the
 * register page, Rovo or MCP, it is filtered to the projects that person can
 * browse in Jira. The check runs as the user, so Jira's own permission scheme
 * is the source of truth, not a copy of it.
 *
 * Every function fails closed: if Jira cannot be asked, the answer is "nothing
 * is visible" and "not permitted".
 */

import api, { route } from '@forge/api';
import { log } from './log.js';
import { visibleTo } from './model.js';

/**
 * Keys of the projects the current user can browse, or an empty set if that
 * cannot be determined.
 *
 * @returns {Promise<Set<string>>}
 */
export async function browsableProjectKeys() {
  try {
    const res = await api.asUser().requestJira(route`/rest/api/3/permissions/project`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: ['BROWSE_PROJECTS'] }),
    });
    if (!res.ok) {
      log.warn('could not read browsable projects', { status: res.status });
      return new Set();
    }
    const body = await res.json();
    return new Set((body.projects ?? []).map((p) => p.key).filter(Boolean));
  } catch (err) {
    log.warn('could not read browsable projects', { error: err?.message });
    return new Set();
  }
}

/**
 * Whether the current user holds a Jira project permission, for example
 * ADMINISTER_PROJECTS. Jira administrators hold every project permission.
 *
 * @param {string} projectKey
 * @param {string} permission
 * @returns {Promise<boolean>}
 */
export async function hasProjectPermission(projectKey, permission) {
  if (!projectKey || !permission) return false;
  try {
    const res = await api
      .asUser()
      .requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=${permission}`);
    if (!res.ok) return false;
    const body = await res.json();
    return body?.permissions?.[permission]?.havePermission === true;
  } catch {
    return false;
  }
}

/**
 * A visibility predicate for the current user, for filtering decision lists.
 *
 * @returns {Promise<(decision: object) => boolean>}
 */
export async function visibilityFilter() {
  const keys = await browsableProjectKeys();
  return (d) => visibleTo(d, keys);
}
