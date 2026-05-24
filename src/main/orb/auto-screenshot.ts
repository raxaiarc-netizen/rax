import {
  captureScreenForOrb,
  isCaptureFailure,
  type CaptureFailure,
  type CaptureResult,
} from './screen-capture'
import { classifyTranscript, type DetectionResult } from './intent-regex'
import type { HaikuVerifier, HaikuVerdict } from './haiku-verifier'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('AutoScreenshot', msg)
}

export type AutoScreenshotMode = 'enabled' | 'regex-only' | 'disabled'

export interface AutoScreenshotDeps {
  mode: AutoScreenshotMode
  haiku: HaikuVerifier
  /** Injectable for tests. Defaults to the real screencapture pipeline. */
  capture?: typeof captureScreenForOrb
}

export interface AutoCaptureAttachment {
  base64: string
  mimeType: 'image/png'
  display: number | 'main'
  cursorMarker: boolean
}

export interface AutoCaptureResult {
  attachment: AutoCaptureAttachment | null
  detection: DetectionResult
  haikuVerdict?: HaikuVerdict
  durationMs: number
  reason: string
}

const HAIKU_TIMEOUT_MS = 800

/**
 * Top-level orchestrator for the orb's auto-attached screenshot pipeline.
 *
 *   1. Classify the transcript (regex catalog).
 *   2. HIGH tier      → screenshot, attach, done.
 *   3. AMBIGUOUS tier → screenshot + Haiku verifier in parallel; attach only
 *                        if Haiku says yes AND the capture succeeded.
 *   4. NONE tier      → no work, no attachment.
 *
 * Failures are non-fatal: a failed capture or Haiku call returns
 * `attachment: null` so the turn proceeds text-only without blocking the
 * user on transient errors.
 */
export async function prepareAutoCapture(
  transcript: string,
  deps: AutoScreenshotDeps,
): Promise<AutoCaptureResult> {
  const t0 = Date.now()
  const detection = classifyTranscript(transcript)

  if (deps.mode === 'disabled') {
    return finish(null, detection, undefined, t0, 'mode disabled')
  }

  if (detection.tier === 'none') {
    return finish(null, detection, undefined, t0, 'no regex hit')
  }

  const capture = deps.capture ?? captureScreenForOrb

  if (detection.tier === 'high') {
    const result = await capture({ display: 'cursor' })
    if (isCaptureFailure(result)) {
      log(`HIGH capture failed (${result.error}): ${result.message}`)
      return finish(null, detection, undefined, t0, `capture ${result.error}`)
    }
    return finish(toAttachment(result), detection, undefined, t0, 'high regex hit')
  }

  // AMBIGUOUS — needs Haiku.
  if (!deps.haiku.enabled || deps.mode === 'regex-only') {
    return finish(null, detection, undefined, t0, 'ambiguous + haiku unavailable')
  }

  const controller = new AbortController()
  const capturePromise = capture({ display: 'cursor' })
  const haikuPromise = withTimeout(
    deps.haiku.verify(transcript, controller.signal),
    HAIKU_TIMEOUT_MS,
    controller,
  )

  const [haikuSettled, captureSettled] = await Promise.allSettled([haikuPromise, capturePromise])

  const verdict: HaikuVerdict | undefined =
    haikuSettled.status === 'fulfilled'
      ? haikuSettled.value
      : undefined
  if (haikuSettled.status === 'rejected') {
    log(`Haiku rejected: ${(haikuSettled.reason as Error)?.message ?? String(haikuSettled.reason)}`)
  }

  if (!verdict || !verdict.should_capture) {
    return finish(
      null,
      detection,
      verdict,
      t0,
      verdict ? `haiku no: ${verdict.reason}` : 'haiku timeout/error',
    )
  }

  if (captureSettled.status !== 'fulfilled') {
    log(`Capture rejected: ${(captureSettled.reason as Error)?.message ?? String(captureSettled.reason)}`)
    return finish(null, detection, verdict, t0, 'haiku yes, capture rejected')
  }
  const captureValue = captureSettled.value
  if (isCaptureFailure(captureValue)) {
    log(`AMBIGUOUS capture failed (${captureValue.error}): ${captureValue.message}`)
    return finish(null, detection, verdict, t0, `haiku yes, capture ${captureValue.error}`)
  }

  return finish(toAttachment(captureValue), detection, verdict, t0, `haiku yes: ${verdict.reason}`)
}

function finish(
  attachment: AutoCaptureAttachment | null,
  detection: DetectionResult,
  haikuVerdict: HaikuVerdict | undefined,
  t0: number,
  reason: string,
): AutoCaptureResult {
  const durationMs = Date.now() - t0
  const decision = attachment ? 'ATTACH' : 'skip'
  log(`${decision} tier=${detection.tier} hits=[${detection.hits.join(',')}] dur=${durationMs}ms — ${reason}`)
  return { attachment, detection, haikuVerdict, durationMs, reason }
}

function toAttachment(c: CaptureResult): AutoCaptureAttachment {
  return {
    base64: c.base64,
    mimeType: c.mimeType,
    display: c.display,
    cursorMarker: c.cursorMarker,
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timeout ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

// Re-exports for callers that only want the orchestrator without reaching into
// the lower-level modules.
export type { CaptureFailure, CaptureResult } from './screen-capture'
export type { DetectionTier, DetectionResult } from './intent-regex'
export type { HaikuVerifier, HaikuVerdict } from './haiku-verifier'
