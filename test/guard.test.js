import assert from 'node:assert/strict'
import { test } from 'node:test'

import { otherRunningAgents } from '../lib/guard.js'

test('idle and unrelated agents do not block a restart', () => {
  const agents = [
    { id: 'session-a', status: 'idle' },
    { id: 'session-b', status: 'idle' },
  ]
  assert.deepEqual(otherRunningAgents(agents, 'session-a'), [])
})

test('the caller is never treated as another conversation', () => {
  const agents = [{ id: 'session-a', status: 'running' }]
  assert.deepEqual(otherRunningAgents(agents, 'session-a'), [])
})

test('any other running conversation blocks the restart', () => {
  const agents = [
    { id: 'session-a', status: 'running' },
    { id: 'session-b', status: 'running' },
    { id: 'session-c', status: 'idle' },
  ]
  assert.deepEqual(otherRunningAgents(agents, 'session-a'), [{ id: 'session-b', status: 'running' }])
})

test('missing agent data is tolerated', () => {
  assert.deepEqual(otherRunningAgents(undefined, 'session-a'), [])
  assert.deepEqual(otherRunningAgents([null, undefined], 'session-a'), [])
})
