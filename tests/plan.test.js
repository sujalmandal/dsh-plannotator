/**
 * Unit tests for plan-mode intercept helpers.
 * @module dsh-plannotator/tests/plan
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DENY_MESSAGE, DISMISS_MESSAGE } from '../lib/decision.js'
import {
  EXIT_PLAN_MODE,
  isPlanModeActive,
  leavePlanMode,
  readPlanArgument,
  resolvePlanMode,
  settlePlanDecision,
  shouldInterceptExitPlanMode,
} from '../lib/plan.js'
import { apply } from '../index.js'

const validPlan = '# Ship retries\n\nUse a bounded queue.'

function planMode(active) {
  return {
    get: () => ({ active }),
    set: () => 'queued',
  }
}

test('shouldInterceptExitPlanMode ignores every other tool', () => {
  assert.equal(shouldInterceptExitPlanMode({
    name: 'ask_user_question',
    arguments: { plan: validPlan },
    agent: { inject() {} },
  }, planMode(true)), false)
})

test('shouldInterceptExitPlanMode intercepts from the session log when planMode is not on this context', () => {
  const agent = {
    inject() {},
    session: {
      snapshotEvents: () => [{ type: 'plan/mode', data: { active: true } }],
    },
  }
  assert.equal(shouldInterceptExitPlanMode({
    name: EXIT_PLAN_MODE,
    arguments: { plan: validPlan },
    agent,
  }), true)
  assert.equal(isPlanModeActive(agent), true)
})

test('shouldInterceptExitPlanMode leaves official validation to exit_plan_mode when inactive or malformed', () => {
  const agent = { inject() {} }
  assert.equal(shouldInterceptExitPlanMode({
    name: EXIT_PLAN_MODE,
    arguments: { plan: validPlan },
    agent,
  }, planMode(false)), false)

  assert.equal(shouldInterceptExitPlanMode({
    name: EXIT_PLAN_MODE,
    arguments: { plan: validPlan },
  }, planMode(true)), false)

  assert.equal(shouldInterceptExitPlanMode({
    name: EXIT_PLAN_MODE,
    arguments: { plan: 'no heading' },
    agent,
  }, planMode(true)), false)
})

test('shouldInterceptExitPlanMode intercepts an in-mode plan that starts with a heading', () => {
  assert.equal(shouldInterceptExitPlanMode({
    name: EXIT_PLAN_MODE,
    arguments: { plan: validPlan },
    agent: { inject() {} },
  }, planMode(true)), true)
})

test('apply delegates non-exit tools to next()', async () => {
  let handler
  const ctx = {
    get: () => undefined,
    on(_name, listener) {
      handler = listener
      return () => {}
    },
  }

  apply(ctx)
  let called = 0
  const next = async () => {
    called += 1
    return { delegated: true }
  }
  const result = await handler(
    { name: 'bash', arguments: {}, agent: { inject() {} }, signal: new AbortController().signal },
    next,
  )
  assert.deepEqual(result, { delegated: true })
  assert.equal(called, 1)
})

test('apply returns a disposer that unregisters the intercept', () => {
  let disposed = false
  const ctx = {
    get: () => undefined,
    on() {
      return () => {
        disposed = true
      }
    },
  }
  const unload = apply(ctx)
  unload()
  assert.equal(disposed, true)
})

test('apply registers slash commands via ctx.inject when available', () => {
  const names = []
  const ctx = {
    get: () => undefined,
    inject(deps, callback) {
      assert.deepEqual(deps, ['commands'])
      callback({
        commands: {
          register(definition) {
            names.push(definition.name)
            return () => {}
          },
        },
      })
      return () => {}
    },
    on() {
      return () => {}
    },
  }
  apply(ctx)
  assert.deepEqual(names, [
    'plannotator-review',
    'plannotator-annotate',
    'plannotator-last',
  ])
})

test('readPlanArgument reads a string plan and ignores anything else', () => {
  assert.equal(readPlanArgument({ plan: validPlan }), validPlan)
  assert.equal(readPlanArgument({ plan: 12 }), '')
  assert.equal(readPlanArgument(null), '')
})

test('settlePlanDecision leaves plan mode and returns the official success value', async () => {
  const calls = []
  const set = (agent, active) => {
    calls.push([agent, active])
    return 'queued'
  }
  const agent = { inject() { throw new Error('should not inject') } }
  const result = await settlePlanDecision({ get: () => ({ active: true }), set }, agent, {
    kind: 'approved',
  })
  assert.deepEqual(result, { isError: false, value: { approved: true } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], agent)
  assert.equal(calls[0][1], false)
})

test('settlePlanDecision injects approve-with-notes after leaving plan mode', async () => {
  let injected
  const set = () => 'queued'
  const agent = {
    inject(message) {
      injected = message
    },
  }
  await settlePlanDecision({ get: () => ({ active: true }), set }, agent, {
    kind: 'approved',
    notes: 'Keep the lock ordered',
  })
  assert.match(injected.content[0].text, /Keep the lock ordered/)
})

test('settlePlanDecision throws official copy on deny and dismiss and does not leave plan mode', async () => {
  let setCalls = 0
  const set = () => {
    setCalls += 1
    return 'queued'
  }
  const agent = { inject() {} }
  const service = { get: () => ({ active: true }), set }

  await assert.rejects(settlePlanDecision(service, agent, { kind: 'denied' }), (error) => error.message === DENY_MESSAGE)
  await assert.rejects(settlePlanDecision(service, agent, { kind: 'dismissed' }), (error) => error.message === DISMISS_MESSAGE)
  assert.equal(setCalls, 0)
})

test('settlePlanDecision appends plan/mode when the isolated service is not visible', async () => {
  const appendCalls = []
  const agent = {
    inject() {},
    session: {
      append(type, data) {
        appendCalls.push([type, data])
      },
    },
  }
  await settlePlanDecision(undefined, agent, { kind: 'approved' })
  assert.deepEqual(appendCalls, [['plan/mode', { active: false }]])
})

test('resolvePlanMode prefers the agent context, then ctx.get', () => {
  const isolated = planMode(true)
  const host = planMode(false)
  assert.equal(resolvePlanMode(
    { get: () => host },
    { inject() {}, ctx: { get: () => isolated } },
  ), isolated)
  assert.equal(resolvePlanMode({ get: (name) => name === 'planMode' ? host : undefined }), host)
  assert.equal(resolvePlanMode({ get: () => undefined }), undefined)
})

test('leavePlanMode prefers the public planMode.set API', () => {
  const calls = []
  const set = (agent, active) => {
    calls.push([agent, active])
    return 'queued'
  }
  const agent = { inject() {} }
  leavePlanMode(agent, { get: () => ({ active: true }), set })
  assert.equal(calls[0][0], agent)
  assert.equal(calls[0][1], false)
})
