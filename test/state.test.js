import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import {
  STATE_MAX_AGE_MS,
  STATE_VERSION,
  bootTime,
  clearState,
  continuationText,
  dshHome,
  isResumable,
  readState,
  statePath,
  writeState,
} from '../lib/state.js'

const previousHome = process.env.DSH_HOME
let home

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-test-'))
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
    token: 'test-token',
    sessionId: 'session-42',
    createdAt: Date.now() - 1000,
    attempts: 0,
    prompt: 'finish the build',
    reason: 'plugin changed',
    ...overrides,
  }
}

test('DSH home follows DSH_HOME', () => {
  assert.equal(dshHome(), home)
  assert.equal(statePath(), path.join(home, 'restart', 'continuation.json'))
})

test('state round-trips and clears', () => {
  clearState()
  const value = record()
  writeState(value)
  assert.deepEqual(readState(), value)
  clearState()
  assert.equal(readState(), undefined)
})

test('state file is replaced atomically', () => {
  writeState(record({ token: 'first' }))
  writeState(record({ token: 'second' }))
  assert.equal(readState().token, 'second')
  const leftovers = fs.readdirSync(path.join(home, 'restart')).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('isResumable accepts a fresh record from an earlier boot', () => {
  const now = Date.now()
  const state = record({ createdAt: now - 5000 })
  assert.equal(isResumable(state, { now, boot: now - 4000 }), true)
})

test('isResumable rejects a record written after this boot', () => {
  const now = Date.now()
  assert.equal(isResumable(record({ createdAt: now + 5000 }), { now, boot: now - 4000 }), false)
})

test('isResumable rejects expired and over-attempted records', () => {
  const now = Date.now()
  const boot = now - 10000
  assert.equal(isResumable(record({ createdAt: now - STATE_MAX_AGE_MS - 1 }), { now, boot }), false)
  assert.equal(isResumable(record({ attempts: 3 }), { now, boot }), false)
})

test('isResumable rejects wrong versions and missing identity', () => {
  const now = Date.now()
  const boot = now - 10000
  assert.equal(isResumable(record({ version: 999 }), { now, boot }), false)
  assert.equal(isResumable(record({ sessionId: '' }), { now, boot }), false)
  assert.equal(isResumable(undefined, { now, boot }), false)
})

test('bootTime is in the past', () => {
  assert.ok(bootTime() <= Date.now())
})

test('continuationText carries identity, reason, and instruction', () => {
  const text = continuationText(record())
  assert.match(text, /\[DSH 自动重启 · 已完成\]/)
  assert.match(text, /session-42/)
  assert.match(text, /plugin changed/)
  assert.match(text, /finish the build/)
})

test('continuationText falls back to a default instruction', () => {
  const text = continuationText(record({ prompt: '   ' }))
  assert.match(text, /继续上一次会话中未完成的工作/)
})
