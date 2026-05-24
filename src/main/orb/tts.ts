import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { log as _log } from '../logger'
import {
  getLocalTtsConfig,
  synthesizeToTempFile,
  shutdownLocalTts,
  warmupLocalTts,
  type CaptionAlignment,
  type LocalTtsConfig,
  type SynthesizeResult,
} from './local-tts'

export type { CaptionAlignment }

export interface TtsSegmentEvent {
  id: string
  /** Spoken text — exactly what was passed to `speak()`. */
  text: string
  /** Per-character timings (seconds since `startedAtMs`). Shallow-copied so
   *  callers can serialize over IPC without later mutation surprising the
   *  receiver. */
  alignment: CaptionAlignment
  /** `Date.now()` snapshot of when afplay was spawned. The caption pill uses
   *  this to anchor its rAF karaoke loop. */
  startedAtMs: number
}

function log(msg: string): void {
  _log('OrbTTS', msg)
}

/**
 * On-device TTS manager for the orb.
 *
 * Speech is produced by Kokoro-82M (via `kokoro-js`, in-process — no
 * Python, no network) and played via `afplay`. The manager only cares
 * about the `SynthesizeResult` shape (temp file path + `ready`/`finished`
 * promises + per-character alignment for the caption pill). On any synth
 * or playback error the orb stays silent for that utterance and
 * immediately emits `done` so the renderer's queue keeps draining.
 *
 * Pipeline depth is 2 — one utterance playing through afplay plus one
 * "prefetched" sentence whose WAV is being synthesized in the background.
 * When `current`'s afplay closes, the prefetched WAV is usually already on
 * disk and we can spawn afplay on it instantly, closing the inter-sentence
 * audio gap to a few ms of afplay spawn latency.
 *
 * Events:
 *   - 'done'        (id)                 utterance finished or errored out;
 *                                        also fired for any prefetched id
 *                                        that gets abandoned before playback
 *                                        so the renderer's in-flight count
 *                                        stays consistent
 *   - 'segment'     (TtsSegmentEvent)    audio started; payload anchors the
 *                                        caption pill's karaoke timer
 *   - 'alignment'   ({ id, alignment })  per-char timings delivered (fires
 *                                        once with Kokoro)
 *   - 'cancelled'   (id)                 cancel() killed an actively-playing
 *                                        utterance (only — prefetched-but-
 *                                        never-played ids emit 'done', not
 *                                        'cancelled', because the caption pill
 *                                        never saw a 'segment' for them and
 *                                        has nothing to fade)
 */
export class TTSManager extends EventEmitter {
  private current: {
    id: string
    child: ChildProcess
    cleanup?: () => void
    offAlign?: () => void
  } | null = null
  private cfg: LocalTtsConfig = getLocalTtsConfig()
  /** AbortController for the active first-utterance synth (set whenever a
   *  `_speakNow` is in-flight). Prefetched utterances carry their own
   *  AbortController on `nextPending`. */
  private synthAbort: AbortController | null = null
  /** Lookahead slot — synthesizing in the background while `current` plays.
   *  Promoted to `current` when the prior afplay closes. At most one item;
   *  the renderer's 2-slot in-flight cap prevents overflow. */
  private nextPending: {
    id: string
    text: string
    synthPromise: Promise<SynthesizeResult | null>
    abort: AbortController
  } | null = null
  /** Set synchronously in the close-handler of the prior `current` when a
   *  prefetch is being promoted. Reserves the slot during the
   *  `_playPrefetched` async window so a `speak()` arriving between
   *  current's done and the promoted utterance's afplay spawn can't slip
   *  past and start a parallel `_speakNow`. Cleared by `_beginPlayback`
   *  (success) or by `cancel()` / the bail paths in `_playPrefetched`. */
  private promotingId: string | null = null
  private promotingAbort: AbortController | null = null

  constructor() {
    super()
    log(`TTS: kokoro/${this.cfg.dtype} voice=${this.cfg.voice} speed=${this.cfg.speed.toFixed(2)}x`)
    // Kick off the model load in the background. Cold load is ~3-5s; doing
    // it now (when the orb window first opens) hides that behind the
    // user's listening window so the first sentence after the user speaks
    // hits a warm model.
    warmupLocalTts(this.cfg)
  }

  speak(text: string): string {
    const trimmed = text.trim()
    const id = randomUUID()
    if (!trimmed) {
      // No-op path — keep the queue moving.
      setImmediate(() => this.emit('done', id))
      return id
    }

    // Already playing OR mid-promotion OR mid-first-synth — queue this as a
    // prefetch so synthesis runs in parallel with the current utterance's
    // playback. By the time `current`'s afplay closes, the prefetched audio
    // is usually already fully written to disk, and we can spawn afplay on
    // the complete file immediately. The three checks cover:
    //   - `current`: the active afplay.
    //   - `promotingId`: the tight window between a prior current's
    //     close-handler and the promoted utterance's afplay spawn (without
    //     this check the new speak() would slip past into a parallel
    //     `_speakNow` and briefly play two utterances at once).
    //   - `synthAbort`: the first-utterance `_speakNow` is in its synth
    //     phase (synthAbort is set on entry and cleared after `_beginPlayback`
    //     populates `current`). Without this, a back-to-back speak()/speak()
    //     before the first utterance's synth resolved would spawn two
    //     parallel synths and two afplays.
    if (this.current || this.promotingId || this.synthAbort) {
      if (this.nextPending) {
        // Overflow guard — the renderer's 2-slot cap should prevent this. If
        // it ever fires, drop the new one rather than the in-flight prefetch
        // so the existing pipeline stays consistent.
        log(`tts.speak [${id.substring(0, 8)}]: overflow (current/promoting + nextPending both set) — dropping`)
        setImmediate(() => this.emit('done', id))
        return id
      }
      const ac = new AbortController()
      const synthPromise = synthesizeToTempFile(this.cfg, trimmed, ac.signal)
        .catch((err) => {
          if (ac.signal.aborted) return null
          log(`prefetch synth [${id.substring(0, 8)}] failed: ${(err as Error).message}`)
          return null
        })
      this.nextPending = { id, text: trimmed, synthPromise, abort: ac }
      log(`tts-prefetch [${id.substring(0, 8)}] queued (${trimmed.length} chars)`)
      return id
    }

    void this._speakNow(id, trimmed)
    return id
  }

  /** Snapshot the live alignment so IPC serialization doesn't capture later
   *  mutations (the arrays grow as more NDJSON chunks land). */
  private _snapshotAlignment(a: CaptionAlignment): CaptionAlignment {
    return {
      chars: a.chars.slice(),
      starts: a.starts.slice(),
      ends: a.ends.slice(),
    }
  }

  /**
   * First-utterance path: synth → write WAV → spawn afplay. With Kokoro
   * the synth completes in-process (no streaming) before `ready` resolves,
   * so by the time we spawn afplay the file is fully written and the
   * "afplay reads past writer's flushed position" race that haunted the
   * streaming-cloud era can't happen.
   *
   * `synthAbort` stays set across the entire async lifetime (synth +
   * file write + afplay spawn) so `speak()` knows the slot is busy and
   * queues concurrent calls as prefetches instead of starting parallel
   * synth requests. Cleared only once `_beginPlayback` has populated
   * `current`, or on any bailout path.
   */
  private async _speakNow(id: string, text: string): Promise<void> {
    const ac = new AbortController()
    this.synthAbort = ac
    const releaseAbort = (): void => {
      if (this.synthAbort === ac) this.synthAbort = null
    }

    log(`tts-speak [${id.substring(0, 8)}] (${text.length} chars)`)
    let synth: SynthesizeResult
    try {
      synth = await synthesizeToTempFile(this.cfg, text, ac.signal)
    } catch (err) {
      releaseAbort()
      if (ac.signal.aborted) {
        log(`tts-speak [${id.substring(0, 8)}] aborted`)
      } else {
        log(`TTS synth failed: ${(err as Error).message} — staying silent`)
      }
      this.emit('done', id)
      this._promoteIfPending()
      return
    }

    // Wait until the WAV is fully on disk. With Kokoro this resolves the
    // moment fs.writeFile's callback returns — same instant as `finished`.
    try {
      await synth.ready
    } catch (err) {
      releaseAbort()
      synth.cleanup()
      log(`TTS write failed: ${(err as Error).message} — staying silent`)
      this.emit('done', id)
      this._promoteIfPending()
      return
    }

    if (ac.signal.aborted) {
      releaseAbort()
      synth.cleanup()
      this.emit('done', id)
      return
    }

    this._beginPlayback(id, text, synth)
    // _beginPlayback populated `this.current` synchronously — only NOW is it
    // safe to release the abort handle, because the busy check in `speak()`
    // will see `this.current` instead.
    releaseAbort()
  }

  /**
   * Prefetched-utterance path: spawn afplay as soon as the prefetched WAV
   * is on disk. The synth has been running in parallel with the prior
   * utterance's playback, so by promotion time the WAV is almost always
   * already fully written. Result: promotion is effectively instantaneous
   * — the inter-sentence audio gap collapses to a few ms of afplay spawn
   * latency.
   *
   * Caller (`_promoteIfPending`) sets `this.promotingId` / `this.promotingAbort`
   * synchronously BEFORE the first await so a `speak()` arriving in the gap
   * queues correctly instead of starting a parallel `_speakNow`. We re-check
   * `stillOwned()` on each await boundary: if it returns false then `cancel()`
   * ran mid-promotion, the slot is already released, and `cancel()` has
   * already emitted `done` for our id — we just clean up locally.
   */
  private async _playPrefetched(promo: NonNullable<typeof this.nextPending>): Promise<void> {
    const stillOwned = (): boolean => this.promotingId === promo.id
    const releaseOwn = (): void => {
      if (stillOwned()) {
        this.promotingId = null
        this.promotingAbort = null
        this.emit('done', promo.id)
      }
    }
    const synth = await promo.synthPromise
    if (!synth) { releaseOwn(); return }
    if (!stillOwned()) { synth.cleanup(); return }
    try {
      await synth.ready
    } catch (err) {
      synth.cleanup()
      log(`prefetch ready-gate errored: ${(err as Error).message} — staying silent`)
      releaseOwn()
      return
    }
    if (!stillOwned()) { synth.cleanup(); return }
    log(`tts-promote [${promo.id.substring(0, 8)}] (${promo.text.length} chars)`)
    this._beginPlayback(promo.id, promo.text, synth)
    // _beginPlayback clears promotingId on success path.
  }

  /** Promote the lookahead to `current` if one exists. Synchronously claims
   *  the slot via `promotingId` BEFORE the async work begins so a `speak()`
   *  arriving in the meantime queues correctly as the new `nextPending`
   *  instead of starting a parallel `_speakNow`. */
  private _promoteIfPending(): void {
    if (!this.nextPending || this.current || this.promotingId) return
    const promo = this.nextPending
    this.nextPending = null
    this.promotingId = promo.id
    this.promotingAbort = promo.abort
    void this._playPrefetched(promo)
  }

  private _beginPlayback(id: string, text: string, synth: SynthesizeResult): void {
    let child: ChildProcess
    try {
      child = spawn('/usr/bin/afplay', [synth.path], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      log(`Failed to spawn afplay: ${(err as Error).message} — staying silent`)
      synth.cleanup()
      if (this.promotingId === id) {
        this.promotingId = null
        this.promotingAbort = null
      }
      this.emit('done', id)
      this._promoteIfPending()
      return
    }
    const startedAtMs = Date.now()

    // Tell the caption pill we're now audibly speaking this segment. Snapshot
    // the alignment so further IPC serialisation doesn't see later mutation.
    this.emit('segment', {
      id,
      text,
      alignment: this._snapshotAlignment(synth.alignment),
      startedAtMs,
    })

    const offAlign = synth.onAlignmentChange(() => {
      if (!this.current || this.current.id !== id) return
      this.emit('alignment', { id, alignment: this._snapshotAlignment(synth.alignment) })
    })

    this.current = { id, child, cleanup: synth.cleanup, offAlign }
    // Promotion succeeded — release the synchronous-reservation slot.
    if (this.promotingId === id) {
      this.promotingId = null
      this.promotingAbort = null
    }

    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (data: string) => {
      const t = data.trim()
      if (t) log(`afplay stderr: ${t.substring(0, 200)}`)
    })
    synth.finished.catch((err: Error) => {
      log(`TTS WAV write error after playback start: ${err.message}`)
    })
    child.on('close', (code) => {
      offAlign()
      synth.cleanup()
      if (this.current && this.current.id === id) {
        this.current = null
        log(`tts-done [${id.substring(0, 8)}] code=${code}`)
        this.emit('done', id)
        this._promoteIfPending()
      }
    })
    child.on('error', (err) => {
      offAlign()
      log(`afplay process error: ${err.message}`)
      synth.cleanup()
      if (this.current && this.current.id === id) {
        this.current = null
        this.emit('done', id)
        this._promoteIfPending()
      }
    })
  }

  cancel(): void {
    if (this.synthAbort) {
      try { this.synthAbort.abort() } catch {}
      this.synthAbort = null
    }
    // Abandon any pending prefetch FIRST so the close-handler of `current`
    // doesn't see it and promote it.
    if (this.nextPending) {
      const abandonedId = this.nextPending.id
      try { this.nextPending.abort.abort() } catch {}
      this.nextPending = null
      log(`tts-prefetch [${abandonedId.substring(0, 8)}] abandoned`)
      // Renderer tracks this id as in-flight — emit done so its count
      // decrements. We don't emit 'cancelled' because the caption pill never
      // saw a 'segment' for this id and has nothing to fade.
      this.emit('done', abandonedId)
    }
    // Abort any in-flight promotion (between a prior current's afplay close
    // and the promoted utterance's afplay spawn). _playPrefetched checks
    // `promotingId` on every await boundary and bails when it sees the slot
    // was released here.
    if (this.promotingId) {
      const promotingId = this.promotingId
      try { this.promotingAbort?.abort() } catch {}
      this.promotingId = null
      this.promotingAbort = null
      log(`tts-promote [${promotingId.substring(0, 8)}] aborted`)
      this.emit('done', promotingId)
    }
    if (this.current) {
      const cancelledId = this.current.id
      try { this.current.offAlign?.() } catch {}
      try { this.current.child.kill('SIGTERM') } catch {}
      try { this.current.cleanup?.() } catch {}
      this.current = null
      // Tell the caption pill to stop highlighting — without this it would
      // keep ticking the rAF loop against a phantom segment that's no longer
      // producing audio (and the next 'segment' may be seconds away).
      this.emit('cancelled', cancelledId)
    }
  }

  shutdown(): void {
    this.cancel()
    this.removeAllListeners()
    shutdownLocalTts()
  }

  /**
   * Switch the active voice. The new value applies to subsequent synth
   * calls — any in-flight or queued utterance in the OLD voice is
   * cancelled so the user doesn't hear one stray sentence. Currently
   * audible playback (the `current` afplay) is left alone to avoid a
   * mid-word cut. The Kokoro model itself doesn't reload; voices are
   * tiny 256-float embeddings passed per `generate()`.
   *
   * Order of operations matters for the pipeline-depth-2 prefetch
   * machinery — we clear `nextPending` and `promotingId` BEFORE aborting
   * `synthAbort`, because aborting the first-utterance synth triggers
   * `_speakNow`'s catch → `_promoteIfPending()`, which would otherwise
   * pick up the still-set `nextPending` and play one stray sentence in
   * the old voice.
   */
  setVoice(voiceId: string): boolean {
    if (this.cfg.voice === voiceId) return true
    this.cfg = { ...this.cfg, voice: voiceId }
    log(`voice -> ${voiceId} (cancelling any in-flight + queued sentences)`)

    // 1. Abandon the prefetch slot first so the soon-to-fire _promoteIfPending
    //    (from any in-flight _speakNow's catch handler) sees `nextPending` is
    //    null and doesn't promote it.
    if (this.nextPending) {
      const abandonedId = this.nextPending.id
      try { this.nextPending.abort.abort() } catch {}
      this.nextPending = null
      log(`tts-prefetch [${abandonedId.substring(0, 8)}] abandoned (voice change)`)
      // Renderer tracks this id as in-flight — emit 'done' so its count
      // decrements. Caption pill never saw a 'segment' for it so we don't
      // emit 'cancelled'.
      this.emit('done', abandonedId)
    }

    // 2. Abort any in-flight promotion (close-handler → afplay spawn gap).
    //    Without this a sentence already in the promotion window would play
    //    in the old voice. `_playPrefetched` re-checks `stillOwned()` on
    //    each await boundary, so aborting + clearing here bails it cleanly.
    if (this.promotingId) {
      const promotingId = this.promotingId
      try { this.promotingAbort?.abort() } catch {}
      this.promotingId = null
      this.promotingAbort = null
      log(`tts-promote [${promotingId.substring(0, 8)}] aborted (voice change)`)
      this.emit('done', promotingId)
    }

    // 3. Signal abort on any active first-utterance synth. Don't null
    //    `synthAbort` here — let `_speakNow`'s `releaseAbort` own the
    //    null'ing inside its catch handler. That keeps the abort-ownership
    //    invariant clean: whoever set `synthAbort` is the only one who
    //    clears it.
    if (this.synthAbort) {
      try { this.synthAbort.abort() } catch {}
    }
    return true
  }

  /** What voice is the manager currently set to use. Reflects live state,
   *  not the value `getLocalTtsConfig()` would compute right now (those
   *  can diverge in dev when `RAX_TTS_VOICE` is set but the user has
   *  also clicked a different voice in Settings — TTSManager honours the
   *  Settings change live, even though env-override would win on next
   *  launch). The Settings dropdown reads this on mount to render the
   *  truthful current selection. */
  getCurrentVoice(): string {
    return this.cfg.voice
  }
}
