import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { STATE_VERSION, clearState, readState, writeState } from '../lib/state.js'
import { deliverContinuation } from '../lib/continuation.js'

const previousHome = process.env.DSH_HOME
let home

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-continuation-'))
  process.env.DSH_HOME = home
})

after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})

function record(overrides = {}) {
  return {
    version: STATE_VERSION,
    token: 'token-1',
    sessionId: 'session-42',
    createdAt: Date.now() - 2000,
    attempts: 1,
    prompt: 'keep going',
    ...overrides,
  }
}

function fakeContext(controller) {
  return { get: (name) => (name === 'sessionController' ? controller : undefined) }
}

test('delivers one prompt into the recorded session and consumes the record', async () => {
  const calls = []
  const controller = {
    async prompt(request) {
      calls.push(request)
      return { accepted: true }
    },
  }
  const state = record()
  writeState(state)

  const result = await deliverContinuation(fakeContext(controller), state, {
    waitForService: false,
    retryMs: [0],
    log: () => {},
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'session-42')
  assert.equal(calls[0].mode, 'queue')
  assert.equal(calls[0].content[0].type, 'text')
  assert.match(calls[0].content[0].text, /keep going/)
  assert.equal(readState(), undefined)
})

test('retries transient failures and keeps the record for a later boot', async () => {
  let attempts = 0
  const controller = {
    async prompt() {
      attempts += 1
      throw new Error('session not found yet')
    },
  }
  const state = record()
  writeState(state)

  const result = await deliverContinuation(fakeContext(controller), state, {
    waitForService: false,
    retryMs: [0, 0],
    log: () => {},
  })

  assert.equal(attempts, 2)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'retry-later')
  const stored = readState()
  assert.equal(stored.attempts, 2)
})

test('abandons the record after the attempt budget is exhausted', async () => {
  const controller = {
    async prompt() {
      throw new Error('still failing')
    },
  }
  const state = record({ attempts: 2 })
  writeState(state)

  const result = await deliverContinuation(fakeContext(controller), state, {
    waitForService: false,
    retryMs: [0],
    log: () => {},
  })

  assert.equal(result.reason, 'abandoned')
  assert.equal(readState(), undefined)
})

test('does nothing when the record was replaced or cancelled', async () => {
  const calls = []
  const controller = {
    async prompt(request) {
      calls.push(request)
    },
  }
  const state = record()
  writeState(record({ token: 'another-token' }))

  const result = await deliverContinuation(fakeContext(controller), state, {
    waitForService: false,
    retryMs: [0],
    log: () => {},
  })

  assert.equal(result.reason, 'state-changed')
  assert.equal(calls.length, 0)
  clearState()
})
