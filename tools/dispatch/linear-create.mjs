/**
 * Create a child issue under a parent (the dispatch form's `newIssue`).
 * The ONLY tracker write in tools/dispatch; reads go through
 * server/linear-lineage.js. The API key comes from the server's one key
 * resolver and only ever travels in the Authorization header.
 */

import { resolveLinearApiKey } from '../../server/linear-key.js'

const TIMEOUT_MS = 20_000

async function gql({ graphqlUrl, fetchImpl, getApiKey }, query, variables) {
  const key = getApiKey()
  if (!key) throw new Error('Linear API key not configured')
  const res = await fetchImpl(graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.errors?.length) throw new Error(`Linear: ${body?.errors?.[0]?.message || `HTTP ${res.status}`}`)
  return body.data
}

/** → the new issue's key (e.g. "ALGO-900"). Throws (with Linear's message) on any failure. */
export async function createChildIssue({ graphqlUrl, fetchImpl = fetch, getApiKey = resolveLinearApiKey }, { parentKey, teamKey, title, description = '' }) {
  const ctx = { graphqlUrl, fetchImpl, getApiKey }
  const parent = await gql(ctx, 'query ($id: String!) { issue(id: $id) { id identifier team { id key } } }', { id: parentKey })
  if (!parent?.issue?.id) throw new Error(`parent ${parentKey} not found`)
  let teamId = parent.issue.team?.id
  if (teamKey && teamKey !== parent.issue.team?.key) {
    const t = await gql(ctx, 'query ($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }', { key: teamKey })
    teamId = t?.teams?.nodes?.[0]?.id
    if (!teamId) throw new Error(`team ${teamKey} not found`)
  }
  const made = await gql(ctx,
    'mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier } } }',
    { input: { teamId, parentId: parent.issue.id, title, description } })
  const key = made?.issueCreate?.issue?.identifier
  if (!made?.issueCreate?.success || !key) throw new Error('issueCreate did not succeed')
  return key
}
