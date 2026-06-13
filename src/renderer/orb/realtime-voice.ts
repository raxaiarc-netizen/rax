import type { TtsEnvelopeFrames } from './Notch'

// ─── Realtime voice client (renderer half) ───
//
// When the user flips a notch realtime toggle (Grok or Gemini), a voice
// session stops being click → record → whisper → claude → Kokoro and becomes
// one continuous speech-to-speech conversation: this class streams raw mic
// PCM up to main (which owns the provider WebSocket) and plays the PCM
// deltas main pushes back down. Turn-taking, VAD and barge-in are all
// server-side; the renderer's job is honest audio I/O plus driving the same
// visual states (listening / thinking / talking) the local pipeline uses, so
// the notch, mascot and waveform need zero changes.
//
// The class is provider-agnostic: both main-process sessions translate their
// protocols onto one renderer-event contract (see GrokRendererEvent), and a
// RealtimeTransport supplies the per-provider IPC surface. Everything below
// the transport — audio graph, captions, state machine — is shared.
//
// Audio path notes:
//   · One AudioContext pinned to 24kHz — Chromium resamples the mic into it
//     and the speakers out of it, so capture chunks and playback buffers are
//     both native 24k PCM16 (both providers' output format) with no manual
//     SRC. (Gemini's input side declares the 24k rate; the API resamples.)
//   · Capture via AudioWorklet (Blob-URL module — no bundler config), with a
//     ScriptProcessor fallback for belt-and-suspenders.
//   · Playback goes straight to ctx.destination: modern Chromium includes
//     that output in the getUserMedia AEC reference, so the orb's own voice
//     doesn't leak into the mic and trip the server VAD mid-sentence.
//   · The waveform/mascot "speaking" animation reads a TtsEnvelopeFrames ref
//     (per-20ms loudness levels). We synthesize that envelope from the very
//     PCM we schedule, normalized against a running peak — same contract the
//     Kokoro path fills from main, no component changes needed.

/** 'idle' only occurs in push-to-talk mode: session live but deaf — waiting
 *  for the user to hold ⌥R. Open-mic sessions rest in 'listening'. */
export type RealtimeClientState = 'idle' | 'listening' | 'thinking' | 'talking'

export interface RealtimeClientCallbacks {
  onStateChange(state: RealtimeClientState): void
  /** Mic analyser for the notch waveform + mascot (null on teardown). */
  onAnalyser(analyser: AnalyserNode | null): void
  /** Non-silent tool started — drives the "thinking" caption. */
  onToolCall(name: string): void
  /** Server VAD interrupted the assistant mid-sentence (barge-in). */
  onInterrupted(): void
  /** A spoken turn finished and its audio fully drained. */
  onTurnDone(): void
  /** Surfaced session error (bad key, quota, …). Session may close after. */
  onError(message: string): void
  /** Socket closed. expected=true for user stops / idle timeout. */
  onClosed(expected: boolean, message?: string): void
}

/** Per-provider IPC surface. Events flow in via handleEvent (App routes the
 *  matching ORB_*_EVENT subscription to the live client). */
export interface RealtimeTransport {
  /** Provider name for user-facing error strings ("Grok", "Gemini"). */
  label: string
  start(): Promise<{ ok: boolean; error?: string }>
  stop(): void
  sendAudio(base64Pcm: string): void
  /** Push-to-talk ⌥R edge — main's session translates it into the provider's
   *  manual turn signals (commit/response.create or activityStart/End). */
  setHold(active: boolean): void
  sendCaption(
    payload: { kind: 'segment'; segment: Record<string, unknown> } | { kind: 'clear'; id: string },
  ): void
}

export const GROK_TRANSPORT: RealtimeTransport = {
  label: 'Grok',
  start: () => window.orb.grokStart(),
  stop: () => void window.orb.grokStop(),
  sendAudio: (b64) => window.orb.grokSendAudio(b64),
  setHold: (active) => window.orb.grokSetHold(active),
  sendCaption: (p) => window.orb.grokSendCaption(p),
}

export const GEMINI_TRANSPORT: RealtimeTransport = {
  label: 'Gemini',
  start: () => window.orb.geminiStart(),
  stop: () => void window.orb.geminiStop(),
  sendAudio: (b64) => window.orb.geminiSendAudio(b64),
  setHold: (active) => window.orb.geminiSetHold(active),
  sendCaption: (p) => window.orb.geminiSendCaption(p),
}

const TARGET_RATE = 24_000
/** 60ms per mic chunk — ~16 IPC messages/sec. */
const CAPTURE_CHUNK_SAMPLES = 1_440
/** 20ms envelope frames (Kokoro uses 30; finer is fine for the same reader). */
const ENVELOPE_FRAME_SAMPLES = 480
const ENVELOPE_FRAME_MS = 20
/** Matches Notch.tsx's TTS_OUTPUT_LATENCY_MS so the synthesized envelope's
 *  timeline cancels the shim the waveform applies for afplay's spawn lag
 *  (Web Audio scheduling has no such lag). */
const ENVELOPE_LATENCY_SHIM_MS = 80
/** Lead-in before the first chunk of a (re)started stream — a small fixed
 *  cushion against network jitter. Measured generation speed is ~3.7×
 *  realtime with zero underruns, so no adaptive growth is needed; a fixed
 *  100ms keeps the start snappy and gapless. */
const PLAYBACK_LEAD_S = 0.1
/** End the session after this much pure silence — an open realtime session
 *  bills by the minute and an abandoned one shouldn't run all afternoon. */
const IDLE_TIMEOUT_MS = 3 * 60 * 1000
const EVAL_INTERVAL_MS = 150
/** Push-to-talk: a hold shorter than this carried no real speech, so no
 *  response is coming (main drops the buffer with the same floor — keep the
 *  two constants equal or the state machine camps in 'thinking'). */
const PTT_MIN_AUDIO_MS = 120
/** Push-to-talk: if the provider never answers a committed turn, stop
 *  showing 'thinking' and return to the deaf resting state. */
const PTT_RESPONSE_TIMEOUT_MS = 12_000
/** Caption pacing fallback when a segment's true end isn't known yet:
 *  ~15-16 chars/sec of comfortable speech, floor for two-word segments. */
const CAPTION_MS_PER_CHAR = 64
const CAPTION_MIN_MS = 1_100

interface PendingCaption {
  text: string
  /** Seconds into the response's audio where this sentence begins. */
  anchorSec: number
}

interface ScheduledCaption {
  id: string
  text: string
  /** Absolute wall-clock ms when this sentence's audio plays. */
  startMs: number
}

// Batches ~60ms of 128-frame quanta per postMessage (transferred, not
// copied). Runs at the context rate, which start() pins to 24kHz.
const CAPTURE_WORKLET_SRC = `
class RaxRealtimeCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this._bufs = []
    this._len = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) {
      this._bufs.push(new Float32Array(ch))
      this._len += ch.length
      if (this._len >= ${CAPTURE_CHUNK_SAMPLES}) {
        const out = new Float32Array(this._len)
        let o = 0
        for (const b of this._bufs) { out.set(b, o); o += b.length }
        this._bufs = []
        this._len = 0
        this.port.postMessage(out, [out.buffer])
      }
    }
    return true
  }
}
registerProcessor('rax-realtime-capture', RaxRealtimeCapture)
`

export class RealtimeVoiceClient {
  private cb: RealtimeClientCallbacks
  private envelopeRef: React.MutableRefObject<TtsEnvelopeFrames | null>
  private transport: RealtimeTransport

  private ctx: AudioContext | null = null
  private mic: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private scriptNode: ScriptProcessorNode | null = null
  private muteTap: GainNode | null = null
  private analyser: AnalyserNode | null = null

  private playGain: GainNode | null = null
  private activeSources = new Set<AudioBufferSourceNode>()
  private nextPlayTime = 0
  /** Only audio that arrives strictly between response_started and
   *  response_done belongs to a live response. A barge-in stops playback,
   *  but the cancelled response keeps emitting deltas for a beat — without
   *  this gate they'd schedule on top of the next answer (stale tail
   *  playing under the new voice), which is the muddy/heavy follow-up. */
  private acceptingAudio = false

  private stopped = false
  private userSpeaking = false
  private responseActive = false
  private toolWaiting = false
  private lastState: RealtimeClientState = 'listening'
  private lastActivityAt = Date.now()
  private suppressChime = false

  // ─── Push-to-talk (⌥R hold) ───
  /** Session-level mode flag — set at construction, never flips mid-session
   *  (changing the setting recreates the whole backend). */
  private ptt = false
  /** ⌥R currently held: the only window in which mic chunks are sent. */
  private holding = false
  /** Milliseconds of mic audio sent during the current hold — mirrors main's
   *  count (IPC is ordered), so both sides agree whether a response is owed. */
  private heldMs = 0
  /** Turn committed on release; show 'thinking' until response_started. */
  private awaitingResponse = false
  private awaitTimer = 0

  private responseSeq = 0
  private envPeak = 0.04
  private evalTimer = 0

  // ─── Caption state (per response) ───
  // The transcript stream + per-delta start_time markers let each sentence
  // be anchored to the second of response audio where it's actually spoken;
  // segments are then emitted to the pill at that exact wall-clock moment.
  private capText = ''
  private capMarkers: Array<{ at: number; t: number }> = []
  private capConsumed = 0
  private capLastT = 0
  /** Wall-clock ms when this response's first audio chunk starts playing. */
  private respAudioStartMs: number | null = null
  private capPending: PendingCaption[] = []
  private capQueue: ScheduledCaption[] = []
  private capTimer = 0
  private capSeq = 0
  private lastCaptionId = ''

  constructor(
    callbacks: RealtimeClientCallbacks,
    envelopeRef: React.MutableRefObject<TtsEnvelopeFrames | null>,
    transport: RealtimeTransport = GROK_TRANSPORT,
    opts: { pushToTalk?: boolean } = {},
  ) {
    this.cb = callbacks
    this.envelopeRef = envelopeRef
    this.transport = transport
    this.ptt = opts.pushToTalk === true
    if (this.ptt) this.lastState = 'idle'
  }

  /** Mic + audio graph + main-side WebSocket. Throws on any failure. */
  async start(): Promise<void> {
    this.stopped = false
    this.lastActivityAt = Date.now()

    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      const e = err as Error
      const denied = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
      throw new Error(denied ? 'Microphone permission denied.' : `Mic error: ${e.message}`)
    }
    // Torn down while getUserMedia was in flight (double-click, dismiss) —
    // release the mic before the OS indicator reads as live with no UI.
    if (this.stopped) {
      for (const t of this.mic.getTracks()) t.stop()
      this.mic = null
      throw new Error('cancelled')
    }

    try {
      this.ctx = new AudioContext({ sampleRate: TARGET_RATE })
      // Activations can come from the global hotkey (no DOM gesture) — make
      // sure the context isn't parked in 'suspended'.
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
      this.sourceNode = this.ctx.createMediaStreamSource(this.mic)

      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.smoothingTimeConstant = 0.6
      this.sourceNode.connect(this.analyser)
      this.cb.onAnalyser(this.analyser)

      // Capture nodes only get pulled when their output reaches the
      // destination — tap them through a zero gain so nothing is audible.
      this.muteTap = this.ctx.createGain()
      this.muteTap.gain.value = 0
      this.muteTap.connect(this.ctx.destination)

      try {
        const blobUrl = URL.createObjectURL(
          new Blob([CAPTURE_WORKLET_SRC], { type: 'application/javascript' }),
        )
        try {
          await this.ctx.audioWorklet.addModule(blobUrl)
        } finally {
          URL.revokeObjectURL(blobUrl)
        }
        this.workletNode = new AudioWorkletNode(this.ctx, 'rax-realtime-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        })
        this.workletNode.port.onmessage = (e: MessageEvent) => {
          this._sendCapture(e.data as Float32Array)
        }
        this.sourceNode.connect(this.workletNode)
        this.workletNode.connect(this.muteTap)
      } catch {
        // Worklet unavailable — ScriptProcessor still works everywhere in
        // Chromium and 85ms granularity is fine for server-side VAD.
        this.scriptNode = this.ctx.createScriptProcessor(2048, 1, 1)
        this.scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
          // The engine reuses the buffer — copy before handing off.
          this._sendCapture(new Float32Array(e.inputBuffer.getChannelData(0)))
        }
        this.sourceNode.connect(this.scriptNode)
        this.scriptNode.connect(this.muteTap)
      }

      // Playback path — direct to the context destination. The earlier
      // MediaStreamDestination → <audio> routing accumulated clock drift
      // across turns within a session (each follow-up started further behind
      // the device clock), which is exactly the "voice gets heavier on
      // follow-ups" symptom. Modern Chromium already includes ctx.destination
      // output in the getUserMedia AEC reference, so echo cancellation still
      // works without the element; the providers also run server-side echo
      // filtering.
      this.playGain = this.ctx.createGain()
      this.playGain.connect(this.ctx.destination)
    } catch (err) {
      this._teardownAudio()
      throw new Error(`Audio setup failed: ${(err as Error).message}`)
    }

    const res = await this.transport.start()
    if (this.stopped) {
      // Torn down while connecting (dismiss / double click) — release.
      this.transport.stop()
      this._teardownAudio()
      throw new Error('cancelled')
    }
    if (!res?.ok) {
      this._teardownAudio()
      throw new Error(res?.error || `Could not start the ${this.transport.label} voice session.`)
    }

    this.lastState = this.ptt ? 'idle' : 'listening'
    this.evalTimer = window.setInterval(() => this._tick(), EVAL_INTERVAL_MS)
  }

  /** End the session. Safe to call repeatedly / before start resolves. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.evalTimer) {
      clearInterval(this.evalTimer)
      this.evalTimer = 0
    }
    this._clearAwaitTimer()
    this._teardownAudio()
    this.transport.stop()
  }

  isStopped(): boolean {
    return this.stopped
  }

  /**
   * Push-to-talk ⌥R edge. While held, mic chunks flow and the orb listens;
   * release commits the turn (main sends the provider's manual turn signals)
   * and the answer follows. A hold while the orb is talking is a barge-in:
   * playback is flushed here and main cancels the in-flight response.
   * No-op in open-mic mode — server VAD owns the turns there.
   */
  setHold(active: boolean): void {
    if (this.stopped || !this.ptt) return
    if (active === this.holding) return
    this.holding = active
    this.lastActivityAt = Date.now()
    if (active) {
      this.heldMs = 0
      this.userSpeaking = true
      this.awaitingResponse = false
      this._clearAwaitTimer()
      // Same local cleanup speech_started performs in open-mic mode: a
      // cancelled response keeps emitting deltas for a beat — gate them out.
      this.acceptingAudio = false
      const wasAudible = this._isPlaying()
      this._flushPlayback()
      this._flushCaptions()
      if (wasAudible) {
        this.suppressChime = true
        this.cb.onInterrupted()
      }
      // Edge BEFORE audio: IPC is ordered, so main opens the hold window
      // before the first chunk of this utterance arrives.
      this.transport.setHold(true)
    } else {
      this.userSpeaking = false
      this.transport.setHold(false)
      if (this.heldMs >= PTT_MIN_AUDIO_MS) {
        // Main committed the buffer — a response is coming. 'thinking' until
        // response_started, with a timeout so a dropped answer can't park
        // the bar there forever.
        this.awaitingResponse = true
        this.awaitTimer = window.setTimeout(() => {
          this.awaitTimer = 0
          this.awaitingResponse = false
          this._evalState()
        }, PTT_RESPONSE_TIMEOUT_MS)
      }
    }
    this._evalState()
  }

  isHolding(): boolean {
    return this.holding
  }

  private _clearAwaitTimer(): void {
    if (this.awaitTimer) {
      clearTimeout(this.awaitTimer)
      this.awaitTimer = 0
    }
  }

  /** Events forwarded from the main-process realtime session. */
  handleEvent(evt: { type: string; [k: string]: unknown }): void {
    if (this.stopped) return
    this.lastActivityAt = Date.now()
    switch (evt.type) {
      case 'ready':
        break
      case 'speech_started': {
        this.userSpeaking = true
        // User talked over the orb (or started a follow-up): cancel local
        // playback AND stop accepting audio until the next response starts,
        // so the cancelled response's trailing deltas don't play under the
        // new answer.
        this.acceptingAudio = false
        const wasAudible = this._isPlaying()
        this._flushPlayback()
        this._flushCaptions()
        if (wasAudible) {
          this.suppressChime = true
          this.cb.onInterrupted()
        }
        this._evalState()
        break
      }
      case 'speech_stopped':
        this.userSpeaking = false
        this._evalState()
        break
      case 'response_started':
        this.responseActive = true
        this.toolWaiting = false
        this.suppressChime = false
        this.awaitingResponse = false
        this._clearAwaitTimer()
        this.responseSeq++
        this.acceptingAudio = true
        // Fresh transcript stream + fresh audio timeline for this response.
        // We do NOT flush here: a follow-up already flushed on speech_started,
        // and a tool-continuation response should butt-join the prior one's
        // audio (the drained-check in _enqueuePcm bridges the tool gap).
        this.capText = ''
        this.capMarkers = []
        this.capConsumed = 0
        this.capLastT = 0
        this.respAudioStartMs = null
        this._evalState()
        break
      case 'audio':
        // Drop audio that doesn't belong to the live response window.
        if (this.acceptingAudio) {
          this._enqueuePcm(String(evt.base64 || ''))
          this._evalState()
        }
        break
      case 'text': {
        const delta = String(evt.delta || '')
        if (!delta) break
        const st = typeof evt.startTime === 'number' && Number.isFinite(evt.startTime) ? evt.startTime : this.capLastT
        this.capMarkers.push({ at: this.capText.length, t: st })
        this.capLastT = st
        this.capText += delta
        this._cutCaptions(false)
        break
      }
      case 'tool_call':
        this.toolWaiting = true
        this.cb.onToolCall(String(evt.name || ''))
        this._evalState()
        break
      case 'response_done':
        this.responseActive = false
        // No more audio belongs to this response. (A tool-continuation
        // response re-opens the gate on its own response_started.)
        this.acceptingAudio = false
        // Whatever transcript tail never hit a sentence boundary still needs
        // a caption — flush it anchored at its real start offset.
        this._cutCaptions(true)
        this._evalState()
        break
      case 'user_transcript':
        break
      case 'error':
        this.awaitingResponse = false
        this._clearAwaitTimer()
        this.cb.onError(String(evt.message || `${this.transport.label} voice error`))
        break
      case 'closed': {
        const expected = !!evt.expected
        const reason = String(evt.reason || '')
        this.stop()
        this.cb.onClosed(expected, reason)
        break
      }
      default:
        break
    }
  }

  /* ── Capture ───────────────────────────────────────────────────────────── */

  private _sendCapture(frame: Float32Array): void {
    if (this.stopped || !frame || frame.length === 0) return
    // Push-to-talk: the mic stays open (the analyser drives the waveform)
    // but nothing leaves the machine outside the ⌥R hold window.
    if (this.ptt) {
      if (!this.holding) return
      this.heldMs += frame.length / (TARGET_RATE / 1000)
    }
    this.transport.sendAudio(floatToPcm16Base64(frame))
  }

  /* ── Playback ──────────────────────────────────────────────────────────── */

  private _enqueuePcm(base64: string): void {
    const ctx = this.ctx
    const gain = this.playGain
    if (!base64 || !ctx || !gain || this.stopped) return

    const f32 = pcm16Base64ToFloat(base64)
    if (f32.length === 0) return

    const buffer = ctx.createBuffer(1, f32.length, TARGET_RATE)
    buffer.getChannelData(0).set(f32)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(gain)
    // Chunks butt-join seamlessly at nextPlayTime while the stream is fed.
    // When the playhead is in the past (first chunk of a turn, or resuming
    // after a tool gap), restart at the live clock + a small fixed lead —
    // never queue behind stale scheduled time.
    const drained = this.nextPlayTime <= ctx.currentTime
    const startAt = drained ? ctx.currentTime + PLAYBACK_LEAD_S : this.nextPlayTime
    try {
      src.start(startAt)
    } catch {
      return
    }
    this.nextPlayTime = startAt + f32.length / TARGET_RATE
    this.activeSources.add(src)
    src.onended = () => this.activeSources.delete(src)

    // First audio of this response — anchor its caption timeline to the
    // wall-clock moment playback actually begins.
    if (this.respAudioStartMs === null) {
      this.respAudioStartMs = Date.now() + (startAt - ctx.currentTime) * 1000
      this._scheduleCaptions()
    }

    this._appendEnvelope(f32, startAt)
  }

  private _flushPlayback(): void {
    for (const src of this.activeSources) {
      try {
        src.stop()
      } catch {}
    }
    this.activeSources.clear()
    this.nextPlayTime = 0
    // A nulled envelope falls back to the quiet baseline in the waveform.
    this.envelopeRef.current = null
  }

  private _isPlaying(): boolean {
    return !!this.ctx && this.nextPlayTime > this.ctx.currentTime + 0.02
  }

  /**
   * Synthesize the speaking-wave envelope from the PCM we just scheduled.
   * Levels are RMS per 20ms frame, normalized against a slowly-decaying
   * running peak (streaming can't peak-normalize the whole utterance the way
   * the Kokoro path does) and shaped with the same 0.7 exponent.
   */
  private _appendEnvelope(f32: Float32Array, startAt: number): void {
    const ctx = this.ctx
    if (!ctx) return
    const startedAtMs =
      Date.now() + (startAt - ctx.currentTime) * 1000 + ENVELOPE_LATENCY_SHIM_MS
    const id = `rt-r${this.responseSeq}`
    let env = this.envelopeRef.current
    if (!env || env.id !== id) {
      env = { id, startedAtMs, frameMs: ENVELOPE_FRAME_MS, levels: [] }
      this.envelopeRef.current = env
    } else {
      // Pad any scheduling gap with silence so frame indexes stay aligned
      // to wall-clock time.
      const expected = Math.round((startedAtMs - env.startedAtMs) / ENVELOPE_FRAME_MS)
      while (env.levels.length < expected) env.levels.push(0)
    }
    for (let off = 0; off < f32.length; off += ENVELOPE_FRAME_SAMPLES) {
      const end = Math.min(off + ENVELOPE_FRAME_SAMPLES, f32.length)
      let sumSq = 0
      for (let i = off; i < end; i++) sumSq += f32[i] * f32[i]
      const rms = Math.sqrt(sumSq / Math.max(1, end - off))
      this.envPeak = Math.max(this.envPeak * 0.999, rms, 0.02)
      const level = Math.round(Math.pow(Math.min(1, rms / this.envPeak), 0.7) * 100) / 100
      env.levels.push(level)
    }
  }

  /* ── Captions ──────────────────────────────────────────────────────────── */
  // The pill expects one tts_segment per spoken sentence, delivered WHEN that
  // sentence starts playing (Kokoro emits at afplay spawn). Transcript deltas
  // carry start_time — seconds into the response audio where the text begins
  // (true timestamps from Grok; synthesized from forwarded-audio position for
  // Gemini) — so each sentence gets an absolute wall-clock slot
  // (respAudioStartMs + anchorSec) and a timer delivers it on cue. This is
  // what keeps captions in phase with the voice instead of sprinting ahead
  // at text-arrival speed.

  /** Cut completed sentences off the transcript tail; `flushTail` takes the
   *  rest too (response finished — no more deltas will extend it). */
  private _cutCaptions(flushTail: boolean): void {
    let guard = 16
    while (guard-- > 0) {
      const tail = this.capText.slice(this.capConsumed)
      if (!tail) break
      const m = /[.!?…]["')\]]*(\s+|$)/.exec(tail)
      let cutLen: number
      if (m) {
        cutLen = m.index + m[0].length
      } else if (flushTail) {
        cutLen = tail.length
      } else {
        break
      }
      const sentence = tail.slice(0, cutLen).trim()
      const anchorSec = this._anchorFor(this.capConsumed)
      this.capConsumed += cutLen
      if (sentence) this.capPending.push({ text: sentence, anchorSec })
      if (!m && flushTail) break
    }
    this._scheduleCaptions()
  }

  /** start_time of the delta in which stream-index `at` falls. */
  private _anchorFor(at: number): number {
    let t = 0
    for (const mk of this.capMarkers) {
      if (mk.at > at) break
      t = mk.t
    }
    return t
  }

  /** Move pending captions to the absolute-time queue (needs the response's
   *  audio start) and arm the delivery timer. */
  private _scheduleCaptions(): void {
    if (this.respAudioStartMs === null) return
    while (this.capPending.length) {
      const p = this.capPending.shift()!
      this.capQueue.push({
        id: `rt-cap-${this.capSeq++}`,
        text: p.text,
        startMs: this.respAudioStartMs + p.anchorSec * 1000,
      })
    }
    this._armCaptionTimer()
  }

  private _armCaptionTimer(): void {
    if (this.capTimer || this.capQueue.length === 0 || this.stopped) return
    const head = this.capQueue[0]
    const delay = Math.max(0, head.startMs - Date.now())
    this.capTimer = window.setTimeout(() => {
      this.capTimer = 0
      const seg = this.capQueue.shift()
      if (seg && !this.stopped) this._emitCaption(seg)
      this._armCaptionTimer()
    }, delay)
  }

  private _emitCaption(seg: ScheduledCaption): void {
    // True duration = gap to the next queued sentence; estimate for the last.
    const next = this.capQueue[0]
    const durMs = next
      ? Math.max(400, next.startMs - seg.startMs)
      : Math.max(CAPTION_MIN_MS, seg.text.length * CAPTION_MS_PER_CHAR)
    const durSec = durMs / 1000
    const chars = seg.text.split('')
    const starts = chars.map((_, i) => (i / chars.length) * durSec)
    const ends = chars.map((_, i) => ((i + 1) / chars.length) * durSec)
    this.lastCaptionId = seg.id
    this.transport.sendCaption({
      kind: 'segment',
      segment: {
        id: seg.id,
        text: seg.text,
        alignment: { chars, starts, ends },
        startedAtMs: seg.startMs,
      },
    })
  }

  /** Drop everything queued and blank the pill (barge-in / teardown). */
  private _flushCaptions(): void {
    if (this.capTimer) {
      clearTimeout(this.capTimer)
      this.capTimer = 0
    }
    this.capPending = []
    this.capQueue = []
    this.capText = ''
    this.capMarkers = []
    this.capConsumed = 0
    if (this.lastCaptionId) {
      this.transport.sendCaption({ kind: 'clear', id: this.lastCaptionId })
      this.lastCaptionId = ''
    }
  }

  /* ── State machine ─────────────────────────────────────────────────────── */

  private _tick(): void {
    if (this.stopped) return
    this._evalState()
    const busy = this.userSpeaking || this.responseActive || this.toolWaiting || this._isPlaying()
    if (busy) {
      this.lastActivityAt = Date.now()
    } else if (Date.now() - this.lastActivityAt > IDLE_TIMEOUT_MS) {
      // Nobody has said anything in a while — park instead of billing an
      // open realtime session all afternoon.
      this.stop()
      this.cb.onClosed(true, 'idle')
    }
  }

  private _evalState(): void {
    if (this.stopped) return
    const playing = this._isPlaying()
    // PTT rests in 'idle' (deaf until the next hold); open mic in 'listening'.
    const resting: RealtimeClientState = this.ptt ? 'idle' : 'listening'
    const next: RealtimeClientState = this.userSpeaking
      ? 'listening'
      : playing
        ? 'talking'
        : this.responseActive || this.toolWaiting || this.awaitingResponse
          ? 'thinking'
          : resting
    if (next !== this.lastState) {
      const prev = this.lastState
      this.lastState = next
      // Natural end of a spoken turn: audio drained with nothing pending.
      if (prev === 'talking' && next === resting && !this.suppressChime) {
        this.cb.onTurnDone()
      }
      this.cb.onStateChange(next)
    }
  }

  /* ── Teardown ──────────────────────────────────────────────────────────── */

  private _teardownAudio(): void {
    this._flushPlayback()
    this._flushCaptions()
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null
        this.workletNode.disconnect()
      } catch {}
      this.workletNode = null
    }
    if (this.scriptNode) {
      try {
        this.scriptNode.onaudioprocess = null
        this.scriptNode.disconnect()
      } catch {}
      this.scriptNode = null
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect()
      } catch {}
      this.sourceNode = null
    }
    if (this.muteTap) {
      try {
        this.muteTap.disconnect()
      } catch {}
      this.muteTap = null
    }
    if (this.playGain) {
      try {
        this.playGain.disconnect()
      } catch {}
      this.playGain = null
    }
    this.acceptingAudio = false
    this.analyser = null
    this.cb.onAnalyser(null)
    if (this.mic) {
      for (const t of this.mic.getTracks()) t.stop()
      this.mic = null
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => {})
    }
    this.ctx = null
  }
}

/* ── PCM codecs ──────────────────────────────────────────────────────────── */

function floatToPcm16Base64(f32: Float32Array): string {
  const buf = new ArrayBuffer(f32.length * 2)
  const dv = new DataView(buf)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  const bytes = new Uint8Array(buf)
  let bin = ''
  const STRIDE = 0x8000
  for (let i = 0; i < bytes.length; i += STRIDE) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + STRIDE) as unknown as number[],
    )
  }
  return btoa(bin)
}

function pcm16Base64ToFloat(base64: string): Float32Array {
  let bin: string
  try {
    bin = atob(base64)
  } catch {
    return new Float32Array(0)
  }
  const n = bin.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)
    if (v >= 0x8000) v -= 0x10000
    out[i] = v / 32768
  }
  return out
}
