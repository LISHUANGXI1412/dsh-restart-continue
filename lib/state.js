/**
 * Durable restart hand-off state.
 *
 * The Host process that schedules a restart writes one JSON record before it
 * exits. The next Host boot reads it and turns it into a continuation prompt.
 * Everything here is synchronous small-file IO: it runs at most once per boot.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Bump when the on-disk shape changes incompatibly. */
export const STATE_VERSION = 1

/** A request older than this is stale and must not revive an old conversation. */
export const STATE_MAX_AGE_MS = 10 * 60 * 1000

/** Boot attempts allowed inside one request before we stop trying. */
export const STATE_MAX_ATTEMPTS = 3

/** Resolve the DSH data directory; the desktop Host sets DSH_HOME explicitly. */
export function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured && configured.length > 0 ? configured : path.join(os.homedir(), '.dsh')
}

export function stateDir() {
  return path.join(dshHome(), 'restart')
}

export function statePath() {
  return path.join(stateDir(), 'continuation.json')
}

export function logPath() {
  return path.join(stateDir(), 'log.jsonl')
}

/**
 * Read the pending record.
 * @param {string} [file] - override for tests.
 * @returns {object | undefined} parsed record, or undefined when absent/invalid.
 */
export function readState(file = statePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Replace the pending record atomically.
 * @param {object} state - complete record.
 * @param {string} [file] - override for tests.
 */
export function writeState(state, file = statePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state, null, 2))
  fs.renameSync(temp, file)
}

/**
 * Remove the pending record; absence is not an error.
 * @param {string} [file] - override for tests.
 */
export function clearState(file = statePath()) {
  try {
    fs.unlinkSync(file)
  } catch {}
}

/**
 * Append one diagnostic line. Logging must never break the restart path.
 * @param {object} entry - fields merged into the line.
 * @param {string} [file] - override for tests.
 */
export function appendLog(entry, file = logPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
  } catch {}
}

/** Wall-clock time at which this process started. */
export function bootTime() {
  return Date.now() - Math.round(process.uptime() * 1000)
}

/**
 * Whether a record belongs to a restart this boot can serve.
 * @param {object | undefined} state - candidate record.
 * @param {{ now?: number, boot?: number }} [clock] - injectable clock for tests.
 * @returns {boolean} true when the record is fresh and predates this boot.
 */
export function isResumable(state, clock = {}) {
  const now = clock.now ?? Date.now()
  const boot = clock.boot ?? bootTime()
  if (!state || typeof state !== 'object') return false
  if (state.version !== STATE_VERSION) return false
  if (typeof state.sessionId !== 'string' || state.sessionId.length === 0) return false
  if (typeof state.createdAt !== 'number' || !Number.isFinite(state.createdAt)) return false
  // The request must have been written by an earlier process: a record that
  // appears after this boot cannot describe a restart this boot is finishing.
  if (state.createdAt > boot) return false
  if (now - state.createdAt > STATE_MAX_AGE_MS) return false
  if ((state.attempts ?? 0) >= STATE_MAX_ATTEMPTS) return false
  return true
}

/**
 * Build the user-visible continuation text injected into the resumed session.
 * @param {object} state - pending record.
 * @returns {string} prompt text.
 */
export function continuationText(state) {
  const when = new Date(state.turnEndedAt ?? state.createdAt)
  const stamp = Number.isNaN(when.getTime()) ? 'unknown time' : when.toLocaleString('zh-CN')
  const reason = typeof state.reason === 'string' && state.reason.trim().length > 0 ? `重启原因：${state.reason.trim()}\n` : ''
  const instruction =
    typeof state.prompt === 'string' && state.prompt.trim().length > 0
      ? state.prompt.trim()
      : '继续上一次会话中未完成的工作。'
  return [
    '[DSH 自动重启 · 已完成]',
    `宿主进程已于 ${stamp} 重启，当前会话（${state.sessionId}）已恢复，之前的对话上下文仍然可用。`,
    reason + `继续指令：${instruction}`,
    '请直接从上次停下的位置继续，不要重复已完成的步骤或重新开始任务；先用一句话说明接下来要做什么，然后继续执行。',
  ].join('\n')
}
