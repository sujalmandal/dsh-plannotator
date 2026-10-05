/**
 * Plan-mode intercept helpers. Pure enough to unit-test without a harness.
 * @module dsh-plannotator/lib/plan
 */

import { randomUUID } from 'node:crypto'
import { throwDecision } from './decision.js'

export const EXIT_PLAN_MODE = 'exit_plan_mode'

const HEADING_RE = /^#\s+\S/

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./types.js').PlanAgent} [agent]
 * @returns {import('./types.js').PlanModeService | undefined}
 */
export function resolvePlanMode(ctx, agent) {
  const fromPreset = asPlanModeService(readPresetPlanMode(ctx, agent))
  if (fromPreset) return fromPreset
  const fromAgent = asPlanModeService(agent?.ctx?.get?.('planMode'))
  if (fromAgent) return fromAgent
  return asPlanModeService(ctx.get('planMode'))
}

function readPresetPlanMode(ctx, agent) {
  if (!agent) return undefined
  const agentPresets = ctx.get?.('agentPresets')
  if (!agentPresets || typeof agentPresets.serviceFor !== 'function') return undefined
  return agentPresets.serviceFor(agent, 'planMode')
}

/**
 * @param {unknown} value
 * @returns {import('./types.js').PlanModeService | undefined}
 */
function asPlanModeService(value) {
  if (!value || typeof value !== 'object') return undefined
  if (!('get' in value) || !('set' in value)) return undefined
  return /** @type {import('./types.js').PlanModeService} */ (value)
}

/**
 * @param {Pick<import('./types.js').ToolDispatchExecution, 'name' | 'arguments' | 'agent'>} exec
 * @param {import('./types.js').PlanModeService} [planMode]
 * @returns {boolean}
 */
export function shouldInterceptExitPlanMode(exec, planMode) {
  if (exec.name !== EXIT_PLAN_MODE) return false
  if (!exec.agent) return false
  if (!isPlanModeActive(exec.agent, planMode)) return false
  return HEADING_RE.test(readPlanArgument(exec.arguments).trim())
}

/**
 * @param {import('./types.js').PlanAgent} agent
 * @param {import('./types.js').PlanModeService} [planMode]
 * @returns {boolean}
 */
export function isPlanModeActive(agent, planMode) {
  if (planMode) return planMode.get(agent).active
  let active = false
  for (const event of readSessionEvents(agent)) {
    if (event.type === 'plan/mode') active = event.data?.active === true
  }
  return active
}

function readSessionEvents(agent) {
  const session = agent?.session
  if (!session) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents !== 'function') return []
  return session.snapshotEvents()
}

/**
 * @param {unknown} args
 * @returns {string}
 */
export function readPlanArgument(args) {
  if (!args || typeof args !== 'object') return ''
  const plan = /** @type {{ plan?: unknown }} */ (args).plan
  return typeof plan === 'string' ? plan : ''
}

/**
 * @typedef {object} ApprovedToolResult
 * @property {false} isError
 * @property {{ approved: true }} value
 */

/**
 * @param {import('./types.js').PlanModeService | undefined} planMode
 * @param {import('./types.js').PlanAgent} agent
 * @param {import('./types.js').PlanDecision} decision
 * @returns {Promise<ApprovedToolResult>}
 */
export async function settlePlanDecision(planMode, agent, decision) {
  if (decision.kind !== 'approved') throwDecision(decision)

  leavePlanMode(agent, planMode)
  if (decision.notes) await injectApprovalNotes(agent, decision.notes)
  // tools/execute wrappers must return a ToolExecutionResult. A bare
  // `{ approved: true }` is read as `{ value: undefined }`, fails the
  // official output schema, and the model retries after we already left
  // plan mode — which surfaces as "exit_plan_mode is only available in plan mode".
  return { isError: false, value: { approved: true } }
}

/**
 * @param {import('./types.js').PlanAgent} agent
 * @param {import('./types.js').PlanModeService} [planMode]
 */
export function leavePlanMode(agent, planMode) {
  if (planMode) {
    planMode.set(agent, false)
    return
  }
  agent.session?.append?.('plan/mode', { active: false })
}

/**
 * @param {import('./types.js').PlanAgent} agent
 * @param {string} notes
 */
async function injectApprovalNotes(agent, notes) {
  const text = `Implementation notes from the reviewer:\n\n${notes}`
  const payload = {
    content: [{ type: /** @type {const} */ ('text'), text }],
    source: {
      kind: /** @type {const} */ ('plugin'),
      plugin: 'plannotator',
      form: 'notice',
      summary: 'Plan approved with notes',
    },
  }

  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    agent.inject(createUserMessage(payload))
    return
  } catch {
    // Resolved from the dsh host when present; otherwise fall through.
  }
  try {
    agent.inject({
      id: randomUUID(),
      role: 'user',
      ...payload,
    })
  } catch {
    // Notes are best-effort. Approval already left plan mode.
  }
}
