/**
 * Turn a pending restart record into one continuation prompt.
 *
 * Runs right after a Host boot. The session is resumed through
 * `ctx.sessionController.prompt`, the same admission path a Web client uses,
 * so the model sees a normal user turn with the full durable history.
 */
import { randomUUID } from 'node:crypto'
import {
  STATE_MAX_ATTEMPTS,
  appendLog,
  clearState,
  continuationText,
  readState,
  writeState,
} from './state.js'

const DEFAULT_RETRY_MS = [0, 3000, 8000, 15000]

/**
 * Sleep for a fixed delay while remaining cancellable.
 * @param {number} ms - delay.
 * @param {AbortSignal} [signal] - plugin lifetime.
 * @returns {Promise<boolean>} false when the lifetime ended first.
 */
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve(!signal?.aborted)
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(!signal?.aborted)
    }, ms)
    timer.unref?.()
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Resolve one Host service, waiting for late composition.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} name - service key.
 * @param {number} timeoutMs - upper bound.
 * @param {AbortSignal} [signal] - plugin lifetime.
 * @returns {Promise<any | undefined>} the service, or undefined on timeout.
 */
async function waitForService(ctx, name, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return undefined
    if (ctx.get(name) !== undefined) return ctx.get(name)
    if (Date.now() >= deadline) return undefined
    if (!(await sleep(250, signal))) return undefined
  }
}

/**
 * Deliver the continuation prompt, retrying transient failures in this boot.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} state - the pending record read at boot.
 * @param {object} [options] - test seams.
 * @param {AbortSignal} [options.signal] - plugin lifetime.
 * @param {number[]} [options.retryMs] - delay before each attempt.
 * @param {boolean} [options.waitForService] - whether to await `sessionController` first.
 * @param {Function} [options.log] - diagnostic sink.
 * @returns {Promise<{ ok: boolean, reason?: string, error?: string }>} outcome.
 */
export async function deliverContinuation(ctx, state, options = {}) {
  const {
    signal,
    retryMs = DEFAULT_RETRY_MS,
    waitForService: awaitService = true,
    log = appendLog,
  } = options

  if (awaitService) await waitForService(ctx, 'sessionController', 20000, signal)

  let lastError = ''
  for (let attempt = 0; attempt < retryMs.length; attempt += 1) {
    if (attempt > 0 && !(await sleep(retryMs[attempt], signal))) {
      return { ok: false, reason: 'disposed' }
    }
    if (signal?.aborted) return { ok: false, reason: 'disposed' }

    // Another code path may have consumed or replaced the request meanwhile.
    const latest = readState()
    if (!latest || latest.token !== state.token) {
      return { ok: false, reason: 'state-changed' }
    }

    const controller = ctx.get('sessionController')
    if (controller?.prompt === undefined) {
      lastError = 'sessionController.prompt is unavailable'
      log({ event: 'continuation.service-missing' })
      continue
    }

    try {
      const text = continuationText(latest)
      await controller.prompt(
        {
          requestId: `restart-${randomUUID()}`,
          sessionId: latest.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        AbortSignal.timeout(120000),
      )
      clearState()
      log({ event: 'continuation.sent', sessionId: latest.sessionId, attempt })
      return { ok: true }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      log({
        event: 'continuation.failed',
        sessionId: latest.sessionId,
        attempt,
        error: lastError,
      })
    }
  }

  // Leave a record of the failure for the next boot or for the user to inspect,
  // but stop retrying once this request has exhausted its budget.
  const attempts = (state.attempts ?? 0) + 1
  if (attempts >= STATE_MAX_ATTEMPTS) {
    clearState()
    log({ event: 'continuation.abandoned', sessionId: state.sessionId, attempts, error: lastError })
    return { ok: false, reason: 'abandoned', error: lastError }
  }
  try {
    writeState({ ...state, attempts })
  } catch {}
  log({ event: 'continuation.retry-later', sessionId: state.sessionId, attempts, error: lastError })
  return { ok: false, reason: 'retry-later', error: lastError }
}
