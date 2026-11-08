/**
 * Teamwork Graph API reader.
 *
 * Three platform realities shape everything in this file.
 *
 * 1. `requestTeamworkGraph` exists on `api.asUser()` only — there is no app-level
 *    variant in @forge/api 8.4.0. So graph reads can only happen on a path that
 *    has a user: a UI resolver, an action invoked from chat, an MCP tool call.
 *    Background workers (scheduled triggers, async consumers) have no user, and
 *    this module refuses rather than failing obscurely inside the SDK. The
 *    staleness sweep is designed around that constraint, not in spite of it.
 *
 * 2. A missing scope returns success and an empty result, never an error. An
 *    empty list is therefore ambiguous: no data, or no permission. Every read
 *    here returns `{ rows, empty, errors }` so callers can tell the difference
 *    and say so in the UI, instead of rendering a confident blank panel.
 *
 * 3. Scopes are checked per object type, including types you only traverse
 *    through. A missing scope anywhere in the path empties the whole result,
 *    so each query below documents every type it touches.
 *
 * The published tutorial's own sample code contains several transcription bugs
 * (a mismatched parameter name, two different field names for the same call).
 * The shapes used here follow the documented GraphQL contract: `cypherQuery`
 * taking `query` and `params`, with results under edges → node → columns.
 */

import api from '@forge/api';
import { log } from './log.js';

/** Thrown when graph access is attempted from a context with no user. */
export class NoUserContextError extends Error {
  constructor(operation) {
    super(
      `Teamwork Graph read "${operation}" needs a user context, but this code path has none. ` +
        'Graph reads must happen on a user-initiated path.'
    );
    this.name = 'NoUserContextError';
  }
}

/** Operation names are prefixed, per the convention in Atlassian's examples. */
const OP_PREFIX = 'precedent_';

/**
 * Execute a Cypher query wrapped in the GraphQL envelope.
 *
 * @param {Object} options
 * @param {string} options.operationName  Unprefixed name, e.g. "userTeams".
 * @param {string} options.selection      GraphQL selection set for the node data.
 * @param {string} options.cypher         The Cypher string.
 * @param {Record<string, unknown>} options.params
 * @returns {Promise<{rows: any[], empty: boolean, errors: any[]}>}
 */
async function runCypher({ operationName, selection, cypher, params }) {
  const opName = `${OP_PREFIX}${operationName}`;
  const graphql = `
    query ${opName}($cypherQuery: String!, $params: CypherRequestParams) {
      cypherQuery(query: $cypherQuery, params: $params) {
        edges {
          node {
            columns {
              key
              value {
                __typename
                ... on CypherQueryResultNode {
                  node {
                    id
                    data { __typename ${selection} }
                  }
                }
                ... on CypherQueryResultListNode {
                  nodes {
                    id
                    data { __typename ${selection} }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  let json;
  try {
    const response = await api
      .asUser()
      .requestTeamworkGraph(graphql, { cypherQuery: cypher, params }, opName);

    if (!response.ok) {
      log.warn('teamwork graph http error', { operationName, status: response.status });
      return { rows: [], empty: true, errors: [{ message: `HTTP ${response.status}` }] };
    }
    json = await response.json();
  } catch (err) {
    log.error('teamwork graph request threw', { operationName, error: err?.message });
    return { rows: [], empty: true, errors: [{ message: err?.message ?? 'request failed' }] };
  }

  const errors = json?.errors ?? [];
  if (errors.length > 0) {
    log.warn('teamwork graph returned errors', {
      operationName,
      first: errors[0]?.message,
      count: errors.length,
    });
  }

  const edges = json?.data?.cypherQuery?.edges ?? [];
  const rows = edges.map((edge) => {
    const row = {};
    for (const column of edge?.node?.columns ?? []) {
      const value = column?.value;
      if (!value) continue;
      if (Array.isArray(value.nodes)) {
        row[column.key] = value.nodes.map((n) => ({ id: n?.id, ...(n?.data ?? {}) }));
      } else if (value.node) {
        row[column.key] = { id: value.node.id, ...(value.node.data ?? {}) };
      }
    }
    return row;
  });

  return { rows, empty: rows.length === 0, errors };
}

/**
 * Connectivity probe. Distinguishes "the graph is unreachable" from "the graph
 * returned nothing", which is the single most useful diagnostic when a panel
 * renders empty. Surfaced in the admin page.
 *
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export async function echo() {
  try {
    const response = await api.asUser().requestTeamworkGraph(`query ${OP_PREFIX}echo {
      echo(myString: "precedent")
    }`);
    const json = await response.json();
    if (json?.data?.echo === 'precedent') return { ok: true };
    return { ok: false, detail: json?.errors?.[0]?.message ?? 'unexpected echo response' };
  } catch (err) {
    return { ok: false, detail: err?.message ?? 'request failed' };
  }
}

/**
 * The teams a user belongs to.
 * Object types touched: AtlassianUser, AtlassianTeam.
 * Scopes: read:graph:user:atlassian, read:graph:team:atlassian.
 *
 * @param {string} userAri
 */
export async function userTeams(userAri) {
  return runCypher({
    operationName: 'userTeams',
    selection: '... on AtlassianTeam { id displayName }',
    cypher:
      'MATCH (user:AtlassianUser {ari: $id})-[:atlassian_user_is_in_atlassian_team]->(team:AtlassianTeam) ' +
      'RETURN collect(distinct team) as teams',
    params: { id: userAri },
  });
}

/**
 * The project a work item sits in, used to infer a decision's scope when the
 * capture source did not state one.
 *
 * Object types touched: JiraWorkItem, JiraSpace.
 * Scopes: read:graph:issue:jira, read:graph:project:jira.
 *
 * @param {string} issueAri
 */
export async function workItemProject(issueAri) {
  return runCypher({
    operationName: 'workItemProject',
    selection: '... on JiraSpace { id displayName key }',
    cypher:
      'MATCH (item:JiraWorkItem {ari: $id})<-[:jira_space_has_jira_work_item]-(space:JiraSpace) ' +
      'RETURN space',
    params: { id: issueAri },
  });
}

/**
 * Work currently assigned to a user, used by the agent to answer "what
 * constrains what I'm working on right now" without the user naming anything.
 *
 * Object types touched: AtlassianUser, JiraWorkItem.
 * Scopes: read:graph:user:atlassian, read:graph:issue:jira.
 *
 * @param {string} userAri
 */
export async function assignedWork(userAri) {
  return runCypher({
    operationName: 'assignedWork',
    selection: '... on JiraWorkItem { id displayName url }',
    cypher:
      'MATCH (user:AtlassianUser {ari: $id})-[:atlassian_user_assigned_jira_work_item]->(item:JiraWorkItem) ' +
      'RETURN collect(distinct item) as items',
    params: { id: userAri },
  });
}

/**
 * Check whether a set of referenced entities still resolves.
 *
 * This backs the "dangling reference" staleness reason: a decision that cites a
 * ticket or page which has since been deleted is standing on nothing. Because
 * graph reads need a user, this runs opportunistically when someone opens the
 * register, and the sweep records that it could not verify rather than
 * asserting everything is fine.
 *
 * @param {string[]} aris
 * @returns {Promise<{resolved: Set<string>, checked: boolean}>}
 */
export async function resolveEntities(aris) {
  if (!aris || aris.length === 0) return { resolved: new Set(), checked: true };

  const { rows, errors } = await runCypher({
    operationName: 'resolveEntities',
    selection: '... on JiraWorkItem { id } ... on ConfluencePage { id }',
    cypher:
      'MATCH (n) WHERE n.ari IN $aris RETURN collect(distinct n) as found',
    params: { aris },
  });

  if (errors.length > 0) return { resolved: new Set(), checked: false };

  const resolved = new Set();
  for (const row of rows) {
    for (const node of row.found ?? []) {
      if (node?.id) resolved.add(node.id);
    }
  }
  return { resolved, checked: true };
}

/**
 * Guard for background contexts. Call before any graph read in a worker.
 * @param {string} operation
 */
export function assertUserContext(hasUser, operation) {
  if (!hasUser) throw new NoUserContextError(operation);
}
