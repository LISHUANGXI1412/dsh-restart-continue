/**
 * dsh-restart — let an agent restart DSH Desktop and continue the same
 * conversation after the new process boots.
 *
 * Restarting is silent on Windows: a detached helper closes the Electron main
 * process gracefully (the same path as the window close button) and starts the
 * same executable again. The continuation is a durable hand-off file consumed by
 * the next Host boot, so it survives the process replacement.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  STATE_VERSION,
  appendLog,
  bootTime,
  clearState,
  isResumable,
  readState,
  statePath,
  writeState,
} from './lib/state.js'
import { deliverContinuation } from './lib/continuation.js'
import { otherRunningAgents } from './lib/guard.js'
import { canRelaunchSilently, requestAppRelaunch } from './lib/relaunch.js'

export const name = 'dsh-restart-continue'
export const inject = ['tools']

/** How long a scheduled request may wait for the Agent to go idle before it expires. */
const SCHEDULE_MAX_WAIT_MS = 30 * 60 * 1000

/** Delay after boot before the continuation prompt is admitted. */
const CONTINUATION_DELAY_MS = 1500

function json(value) {
  return JSON.stringify(value, null, 2)
}

/**
 * Ask the session store to persist everything appended so far. The restart that
 * follows may terminate the process without the shell's graceful shutdown, so
 * the final assistant message must already be durable.
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - session to flush.
 * @returns {Promise<void>} resolves after the flush settles or times out.
 */
async function flushSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (typeof sessions?.flush !== 'function') return
  let session
  try {
    session = sessions.get?.(sessionId)
  } catch {}
  if (session === undefined) return
  let timer
  try {
    await Promise.race([
      sessions.flush(session),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

/**
 * Best-effort name of the Profile this Host booted, used only to avoid replaying
 * a hand-off into a different Profile. The Desktop Host runs with the Profile
 * directory as its cwd and does not export DSH_PROFILE.
 * @returns {string | undefined} profile name when it can be derived.
 */
function currentProfile() {
  const configured = process.env.DSH_PROFILE?.trim()
  if (configured) return configured
  try {
    return basename(process.cwd())
  } catch {
    return undefined
  }
}

/**
 * Owns the single pending restart request for this Host process.
 */
class RestartScheduler {
  /**
   * @param {object} ctx - plugin context.
   * @param {{ later: Function, log?: Function }} deps - timer helper and logger.
   */
  constructor(ctx, deps) {
    this.ctx = ctx
    this.later = deps.later
    this.log = deps.log ?? appendLog
    this.pending = undefined
    this.disposeStatusListener = undefined
    this.expiryTimer = undefined
  }

  /** @returns {{ silentRelaunch: boolean, desktopShell: boolean, mode: string }} restart capabilities. */
  capabilities() {
    const silentRelaunch = canRelaunchSilently()
    const desktopShell = typeof this.ctx.get('desktopActions')?.requestRestart === 'function'
    return {
      silentRelaunch,
      desktopShell,
      mode: silentRelaunch ? 'silent-app-relaunch' : desktopShell ? 'desktop-confirm' : 'unsupported',
    }
  }

  /** @returns {boolean} whether this Host can restart itself at all. */
  canRestart() {
    return this.capabilities().mode !== 'unsupported'
  }

  /**
   * @param {unknown} callerId - Agent that asked for the restart.
   * @returns {Array<{ id: string, status: string }>} other Agents that are mid-turn.
   */
  runningOthers(callerId) {
    const agents = this.ctx.get('agents')
    let list = []
    try {
      list = agents?.list?.() ?? []
    } catch {}
    return otherRunningAgents(list, callerId)
  }

  /**
   * Persist a request and arm the one-shot idle listener.
   * @param {{ sessionId: string, cwd?: string, prompt?: string, reason?: string }} request - caller intent.
   * @returns {object} the stored record.
   */
  schedule(request) {
    this.cancel()
    const state = {
      version: STATE_VERSION,
      token: randomUUID(),
      sessionId: String(request.sessionId),
      cwd: typeof request.cwd === 'string' ? request.cwd : undefined,
      profile: currentProfile(),
      prompt: typeof request.prompt === 'string' ? request.prompt : undefined,
      reason: typeof request.reason === 'string' ? request.reason : undefined,
      createdAt: Date.now(),
      attempts: 0,
    }
    writeState(state)
    this.pending = state
    this.log({ event: 'restart.scheduled', sessionId: state.sessionId })

    this.disposeStatusListener = this.ctx.on('agent/status', (payload) => {
      if (payload?.status !== 'idle') return
      if (String(payload.agent?.id) !== state.sessionId) return
      void this.fire()
    })

    // Never keep a request alive forever when the Agent never reaches idle.
    this.expiryTimer = this.later(() => {
      if (this.pending?.token !== state.token) return
      this.log({ event: 'restart.expired', sessionId: state.sessionId })
      this.cancel()
    }, SCHEDULE_MAX_WAIT_MS)

    return state
  }

  /** Drop the pending request and its durable record (user cancellation). */
  cancel() {
    this.disposeInMemory()
    if (readState() !== undefined) clearState()
  }

  /** Release listeners and timers without touching the hand-off file (plugin disposal). */
  dispose() {
    this.disposeInMemory()
  }

  disposeInMemory() {
    this.pending = undefined
    if (this.disposeStatusListener !== undefined) {
      this.disposeStatusListener()
      this.disposeStatusListener = undefined
    }
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = undefined
    }
  }

  /**
   * Perform the restart once the Agent is idle.
   * @returns {Promise<void>} resolves after the request is handed off (or rejected).
   */
  async fire() {
    const pending = this.pending
    if (pending === undefined) return
    this.disposeInMemory()

    const stored = readState()
    if (stored === undefined || stored.token !== pending.token) return

    // Re-check at the last moment: another conversation may have started a turn
    // between the tool call and this idle edge.
    const running = this.runningOthers(pending.sessionId)
    if (running.length > 0) {
      this.log({ event: 'restart.blocked', sessionId: pending.sessionId, running: running.map((agent) => agent.id) })
      clearState()
      return
    }

    writeState({ ...stored, turnEndedAt: Date.now() })
    await flushSession(this.ctx, pending.sessionId)

    if (canRelaunchSilently()) {
      try {
        const result = await requestAppRelaunch()
        if (result.ok) {
          this.log({ event: 'relaunch.spawned', sessionId: pending.sessionId, launcher: result.launcher })
        } else {
          this.log({
            event: 'relaunch.failed',
            sessionId: pending.sessionId,
            code: result.code,
            error: result.error ?? 'launcher did not start',
          })
          clearState()
        }
      } catch (error) {
        this.log({
          event: 'relaunch.failed',
          error: error instanceof Error ? error.message : String(error),
        })
        clearState()
      }
      return
    }

    // Non-Windows fallback: the Desktop's own restart request, which is confirmed
    // through the shell's native dialog.
    const actions = this.ctx.get('desktopActions')
    if (typeof actions?.requestRestart !== 'function') {
      this.log({ event: 'restart.unsupported' })
      clearState()
      return
    }
    try {
      await actions.requestRestart()
      this.log({ event: 'restart.requested', sessionId: pending.sessionId })
    } catch (error) {
      this.log({
        event: 'restart.request-failed',
        error: error instanceof Error ? error.message : String(error),
      })
      clearState()
    }
  }
}

/**
 * Compose the Host plugin.
 * @param {object} ctx - plugin context.
 */
export function apply(ctx) {
  const lifetime = new AbortController()
  const timers = new Set()

  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timer.unref?.()
    timers.add(timer)
    return timer
  }

  const scheduler = new RestartScheduler(ctx, { later })

  ctx.tools.register({
    name: 'dsh_restart',
    description:
      'Restart DSH Desktop and resume this same conversation automatically after the new process boots. ' +
      'On Windows this is silent: a detached helper closes the app gracefully and starts it again, so no dialog ' +
      'and no click are involved. The restart is deferred until this turn ends, so the current tool result and ' +
      'final message are never lost; after the new app boots, a continuation prompt is injected into this exact ' +
      'session. It refuses while another conversation is mid-turn, because a restart would interrupt it. ' +
      'action="status" reports capabilities, running conversations, and any pending request; action="cancel" drops ' +
      'a pending request.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['restart', 'status', 'cancel'],
          description: 'restart (default) schedules the restart; status is read-only; cancel drops the pending request.',
        },
        prompt: {
          type: 'string',
          description:
            'What the resumed turn should continue doing. Omit to continue the unfinished work of this conversation.',
        },
        reason: {
          type: 'string',
          description: 'Short human-readable reason recorded in the continuation message and the plugin log.',
        },
      },
    },
    output: textOutput(),
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : 'restart'

      if (action === 'status') {
        const pending = readState()
        return json({
          ok: true,
          action,
          host: {
            pid: process.pid,
            parentPid: process.ppid,
            startedAt: new Date(bootTime()).toISOString(),
            profile: currentProfile() ?? null,
            cwd: process.cwd(),
            dshHome: process.env.DSH_HOME ?? null,
          },
          capabilities: {
            ...scheduler.capabilities(),
            sessionPrompt: typeof ctx.get('sessionController')?.prompt === 'function',
          },
          runningAgents: scheduler.runningOthers(exec?.agent?.id),
          stateFile: statePath(),
          pending: pending ?? null,
        })
      }

      if (action === 'cancel') {
        const pending = readState()
        scheduler.cancel()
        return json({
          ok: true,
          action,
          cancelled: pending !== null && pending !== undefined,
          pending: null,
        })
      }

      const agent = exec?.agent
      if (agent === undefined || agent === null) {
        return json({
          ok: false,
          error: 'dsh_restart must run inside an Agent turn; no calling Agent is available.',
        })
      }
      const capabilities = scheduler.capabilities()
      if (capabilities.mode === 'unsupported') {
        return json({
          ok: false,
          error:
            'This Host cannot restart itself: no silent relaunch is available on this platform and the Desktop shell ' +
            'exposes no restart capability. dsh_restart needs DSH Desktop on Windows.',
        })
      }

      const running = scheduler.runningOthers(agent.id)
      if (running.length > 0) {
        return json({
          ok: false,
          error:
            `Refusing to restart: ${running.length} other conversation(s) are running a turn. ` +
            'A restart replaces the whole app process and would interrupt them.',
          running,
          suggestion:
            'Wait for those turns to finish (or cancel them), then call dsh_restart again. action="status" shows them.',
        })
      }

      const state = scheduler.schedule({
        sessionId: agent.id,
        cwd: agent.session?.header?.cwd,
        prompt: typeof args?.prompt === 'string' ? args.prompt : undefined,
        reason: typeof args?.reason === 'string' ? args.reason : undefined,
      })

      return json({
        ok: true,
        action,
        scheduled: true,
        mode: capabilities.mode,
        sessionId: state.sessionId,
        stateFile: statePath(),
        restartAt: 'when this turn ends (the Agent reaches idle)',
        continuation:
          'After the new process boots, this plugin reopens the session and injects a continuation prompt. ' +
          'Finish the current turn normally instead of waiting for the restart inside the turn.',
        guard:
          'The restart is re-checked at fire time; if another conversation starts a turn meanwhile it is skipped, not forced.',
        note:
          'The request expires in 10 minutes and never replays an older conversation.',
      })
    },
  })

  // A previous Host may have handed off a continuation to this boot.
  const pending = readState()
  if (pending !== undefined) {
    const profile = currentProfile()
    const foreignProfile =
      typeof pending.profile === 'string' && profile !== undefined && pending.profile !== profile
    if (foreignProfile || !isResumable(pending)) {
      clearState()
      appendLog({
        event: 'state.discarded',
        sessionId: pending?.sessionId,
        expired: !foreignProfile,
        foreignProfile,
        expectedProfile: pending?.profile,
        profile,
      })
    } else {
      const accepted = { ...pending, attempts: (pending.attempts ?? 0) + 1, resumedAt: Date.now() }
      try {
        writeState(accepted)
      } catch {}
      appendLog({ event: 'state.accepted', sessionId: accepted.sessionId, attempts: accepted.attempts })
      later(() => {
        void deliverContinuation(ctx, accepted, { signal: lifetime.signal })
      }, CONTINUATION_DELAY_MS)
    }
  }

  ctx.effect(() => () => {
    lifetime.abort()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    scheduler.dispose()
  })
}
