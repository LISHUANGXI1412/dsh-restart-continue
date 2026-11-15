/**
 * Refuse to restart while another conversation is mid-turn.
 *
 * A restart replaces the whole app process, so any other Agent with an active
 * driver would lose its turn. Idle Agents are fine: nothing is executing.
 */

/**
 * @param {Array<{ id: unknown, status?: string }> | undefined} agents - live agents.
 * @param {unknown} callerId - the Agent that asked for the restart.
 * @returns {Array<{ id: string, status: string }>} running agents other than the caller.
 */
export function otherRunningAgents(agents, callerId) {
  const caller = String(callerId ?? '')
  return (agents ?? [])
    .filter((agent) => agent !== undefined && agent !== null)
    .filter((agent) => String(agent.id) !== caller)
    .filter((agent) => agent.status === 'running')
    .map((agent) => ({ id: String(agent.id), status: 'running' }))
}
