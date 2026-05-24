import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VoiceOrb, type OrbState } from './VoiceOrb'
import {
  playBargeIn,
  playError,
  playListenCap,
  playListenEnd,
  playListenStart,
  playMishear,
} from './earcons'

declare global {
  interface Window {
    orb: import('../../preload/orb').OrbAPI
  }
}

// ─── Voice agent state machine ───
//
//   idle  ─click─▶ listening ─VAD silence─▶ transcribing ─whisper─▶ thinking
//                                               │ (empty)            │
//                                               ▼                    ▼ (claude streams)
//                                              idle                talking ─TTS done─▶ idle
//
// Voice barge-in: while `thinking` or `talking` (i.e. any time the orb owes
// the user a response), a low-overhead VAD listens for user speech. If
// detected we cancel the in-flight turn / TTS and roll straight into a new
// recording — important when claude takes a few seconds to start streaming
// on heavy turns or tool calls.

type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'talking' | 'error'

const stateToOrb = (s: VoiceState): OrbState => {
  if (s === 'listening' || s === 'transcribing') return 'listening'
  if (s === 'thinking' || s === 'talking') return 'talking'
  return 'idle'
}

const STATE_LABEL: Record<VoiceState, string> = {
  idle: '',
  listening: 'listening',
  transcribing: 'transcribing',
  thinking: 'thinking',
  talking: 'speaking',
  error: 'error',
}

// VAD tuning — normalised 0..1 RMS values.
const VAD_SPEECH_RMS = 0.045
const VAD_SILENCE_RMS = 0.018
const VAD_SILENCE_HOLD_MS = 850
const MIN_SPEECH_MS = 350
const MAX_RECORD_MS = 30_000

// Barge-in VAD (during thinking + TTS) — higher threshold so speaker bleed
// during talking doesn't trip it.
const BARGE_IN_RMS = 0.08
const BARGE_IN_MIN_MS = 220

const ORB_HIT_RADIUS = 78

// Transcript ring buffer — max entries shown.
const MAX_TRANSCRIPT = 30

interface TranscriptEntry {
  id: string
  role: 'user' | 'orb' | 'tool'
  text: string
}

const uid = () => Math.random().toString(36).slice(2, 10)

// ─── Phrase-boundary chunker ───
// We want audible output ASAP — waiting for a sentence terminator means a
// 1.5–3s gap before the user hears anything for an answer like
// "Tab two is running tests right now and tab three just finished editing the
//  auth middleware." The first period only arrives after ~120 chars.
//
// Strategy:
//   1. Sentence terminator (`.`, `!`, `?`, newline) — always flush. Best prosody.
//   2. Clause boundary (`,`, `;`, `:`, em-dash, en-dash) followed by a space —
//      flush if the clause is long enough to sound natural.
//   3. Hard length cap — if we somehow accumulate >MAX_RUNAWAY chars without
//      any terminator, break at the latest whitespace.
//
// FIRST_CHUNK_MIN gates the first cut after firstChunkPendingRef was set; it
// stays small so audio begins as fast as possible at the start of a turn AND
// at the start of every post-tool text segment (the flag is re-armed on each
// non-silent tool_call). NEXT_CHUNK_MIN gates subsequent cuts within the same
// segment — with local Kokoro (~150-250ms synth for short chunks) there's no
// cloud-TTFB amortization to pay for, so this stays low; just enough to absorb
// a burst of staccato sentences ("Sure. Got it. Done.") landing in one tick.
const FIRST_CHUNK_MIN = 48
const NEXT_CHUNK_MIN = 32
const MAX_RUNAWAY = 280

// Max sentences in main's TTS pipeline at once: 1 playing through afplay
// plus 1 prefetched (downloading the MP3 in the background). Pumping the
// next sentence ahead of `done` lets main overlap synthesis with playback,
// closing the prior ~250–500ms TTFB gap at every sentence boundary.
const TTS_INFLIGHT_MAX = 2

function chunkForTts(
  buffer: string,
  isFirstChunk: boolean,
): { complete: string[]; incomplete: string } {
  if (!buffer) return { complete: [], incomplete: '' }
  const complete: string[] = []
  let cur = buffer
  let firstPending = isFirstChunk

  while (cur.length > 0) {
    const minLen = firstPending ? FIRST_CHUNK_MIN : NEXT_CHUNK_MIN
    // First chunk: accept ANY sentence cut for fast TTFA — even "Sure." is
    // worth speaking immediately. Subsequent chunks: require minLen on
    // sentence cuts too so back-to-back short sentences bundle into one
    // longer TTS call instead of each costing a separate afplay spawn.
    const cut = findCut(cur, minLen, /* requireMinForSentence */ !firstPending)
    if (cut < 0) break
    const piece = cur.slice(0, cut).trim()
    cur = cur.slice(cut).replace(/^\s+/, '')
    if (piece) {
      complete.push(piece)
      firstPending = false
    }
  }

  return { complete, incomplete: cur }
}

// V8's Intl.Segmenter (both Node and Chromium) splits common English
// abbreviations as their own "sentence" — "Mr." → ["Mr. ", "Smith said hi."].
// The orb would then speak "Mister." with a hard pause before continuing,
// which sounds awful. We post-filter against this list.
const ABBREV_RE =
  /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|St|Jr|Sr|Lt|Sgt|Capt|Cpl|Pvt|Hon|Rev|vs|etc|cf|i\.e|e\.g|U\.S|U\.K|N\.Y|D\.C|a\.m|p\.m)\.?$/i

function endsInAbbrev(s: string): boolean {
  // Trim trailing whitespace + the terminator itself, then test the last word.
  const trimmed = s.replace(/\s+$/, '')
  return ABBREV_RE.test(trimmed) || /\b[A-Z]\.$/.test(trimmed)
}

// Returns the index (one past the boundary char) where we should cut, or -1
// if no boundary worth taking is in `s` yet.
// `requireMinForSentence`: when true, sentence-terminator cuts must also
// satisfy minLen — used for non-first chunks to bundle short consecutive
// sentences ("Sure. Got it. Done.") into one TTS call.
function findCut(s: string, minLen: number, requireMinForSentence: boolean): number {
  // 1. Sentence terminator. Intl.Segmenter is the gold standard for sentence
  //    detection in general — but its abbreviation handling is weak (it
  //    splits "Mr.", "U.S.", "e.g." as their own sentences). We walk the
  //    segments greedily, merging any that end in a known abbreviation, and
  //    only accept a cut once we have a "real" sentence followed by another.
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (Segmenter) {
    try {
      const seg = new Segmenter('en', { granularity: 'sentence' })
      const segs = Array.from(seg.segment(s))
      if (segs.length >= 2) {
        // Merge until the FIRST cut lands on a non-abbreviation. The runaway
        // case (every segment ends in an abbreviation) means we never cut
        // here — the next layers (newline / clause / runaway) take over.
        // For non-first chunks, skip cuts shorter than minLen so the chunk
        // accumulates enough content to amortize TTFB and avoid a perceived
        // "stop" at every period.
        for (let i = 0; i < segs.length - 1; i++) {
          const cut = segs[i].index + segs[i].segment.length
          if (requireMinForSentence && cut < minLen) continue
          if (!endsInAbbrev(s.slice(0, cut))) return cut
        }
      }
    } catch {}
  } else {
    // Fallback when Intl.Segmenter isn't available (older runtimes).
    const m = /([.!?]+["')\]]*)(\s+|$)/.exec(s)
    if (m && m.index > 0) {
      const cut = m.index + m[1].length + m[2].length
      if (requireMinForSentence && cut < minLen) {
        // fall through to clause/runaway layers
      } else if (!endsInAbbrev(s.slice(0, cut))) {
        return cut
      }
    }
  }

  // 2. Newline / paragraph break — always a clean boundary.
  const nl = /\n+/.exec(s)
  if (nl) return nl.index + nl[0].length

  // 3. Clause boundary, but only if we have enough text to sound natural.
  //    Em-dash → semicolon → colon → comma, in roughly descending naturalness.
  //    Markdown bullets ("- ", "* ") show up as a "- " after a newline, which
  //    we already handled above; here we only care about mid-line punctuation.
  if (s.length >= minLen) {
    const clauseRe = /([—–;:,])(\s+|$)/g
    let m: RegExpExecArray | null
    while ((m = clauseRe.exec(s)) !== null) {
      const end = m.index + m[1].length + m[2].length
      if (end >= minLen) return end
    }
  }

  // 4. Runaway protection — break at last whitespace if we're way past the
  //    cap with no punctuation in sight (rare, but possible in code blocks).
  if (s.length >= MAX_RUNAWAY) {
    const lastSpace = s.lastIndexOf(' ', MAX_RUNAWAY)
    if (lastSpace > minLen) return lastSpace + 1
  }

  return -1
}

export default function App() {
  const [state, setState] = useState<VoiceState>('idle')
  const stateRef = useRef<VoiceState>('idle')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [showTranscript, setShowTranscript] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [labelKey, setLabelKey] = useState(0) // forces label re-animation on every state change
  // Latest tool name shown as a live caption while the orb is "thinking" — fixes
  // the otherwise-opaque thinking state on heavy turns (10s+).
  const [currentTool, setCurrentTool] = useState<string | null>(null)
  // Trigger for the one-shot rim flash that plays when the auto-screenshot
  // pipeline attaches an image to the outgoing turn. Reset back to null after
  // the flash window so a back-to-back attachment within the same ms still
  // re-arms the effect.
  const [flashAt, setFlashAt] = useState<number | null>(null)

  // Recording refs
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderStreamRef = useRef<MediaStream | null>(null)
  const recorderChunksRef = useRef<Blob[]>([])
  const recorderMimeRef = useRef<string>('audio/webm;codecs=opus')
  const recordCancelledRef = useRef(false)
  const recordCappedRef = useRef(false)
  // Hold-to-speak (Option+R) — when true, VAD silence/cap stops are
  // disabled; only the explicit ORB_HOLD_END from main ends the recording.
  const holdModeRef = useRef(false)

  // VAD refs (during listening AND barge-in)
  const vadCtxRef = useRef<AudioContext | null>(null)
  const vadAnalyserRef = useRef<AnalyserNode | null>(null)
  const vadRafRef = useRef<number>(0)
  const vadStartedSpeakingAtRef = useRef<number | null>(null)
  const vadLastVoiceAtRef = useRef<number>(0)
  const vadStartedAtRef = useRef<number>(0)

  // Shared between the recorder/VAD and the VoiceOrb canvas — opening a
  // separate getUserMedia inside the canvas would cause two "Microphone in
  // use" indicators and could pick a different input device.
  const [vizAnalyser, setVizAnalyser] = useState<AnalyserNode | null>(null)

  // Barge-in refs
  const bargeStreamRef = useRef<MediaStream | null>(null)
  const bargeCtxRef = useRef<AudioContext | null>(null)
  const bargeAnalyserRef = useRef<AnalyserNode | null>(null)
  const bargeRafRef = useRef<number>(0)
  const bargeFirstVoiceAtRef = useRef<number | null>(null)

  // Orb response streaming refs
  const inFlightOrbIdRef = useRef<string | null>(null)
  // Bumped every time we wipe the TTS queue (task_complete from a finished
  // turn, errors, barge-in). Tool-narration requests captured a snapshot of
  // this counter when they fired; if the value moved before the LLM
  // responded, the narration belongs to a turn the user no longer cares
  // about and gets dropped instead of speaking into a fresh recording.
  const narrationGenRef = useRef(0)
  const ttsBufferRef = useRef<string>('')
  // Number of sentences currently held by main (synthesizing, prefetching, or
  // playing). Capped at TTS_INFLIGHT_MAX so we always have at most one playing
  // + one prefetching. Mutated synchronously inside pumpTts before the async
  // ttsSpeak IPC fires; decremented in onTtsDone when main emits 'done' for
  // any utterance (real or abandoned-prefetch). cancelAllSpeech resets to 0.
  // The `Math.max(0, …)` floor below survives any late-arriving done that
  // races a cancel.
  const ttsInFlightCountRef = useRef(0)
  const ttsQueueRef = useRef<string[]>([])
  const turnEndedRef = useRef(true)
  // Track whether we've already emitted ANY chunk for this turn — the first
  // phrase uses a lower minimum so audible output starts as soon as possible.
  const firstChunkPendingRef = useRef(true)

  // ─── Pre-warm: nothing to do for native TTS, but kick off the orb backend ───

  // ─── Pump the TTS queue: speak the next sentence whenever the previous finishes ───
  // Up to TTS_INFLIGHT_MAX sentences may be in main at once — one playing
  // through afplay plus one being synthesized in the background. The loop
  // fills available slots in a single call so a burst of streamed sentences
  // (e.g. three text_chunks landing back-to-back) all hit main right away,
  // letting main overlap synthesis with playback. Result: the inter-sentence
  // gap drops from ~250–500ms (per-request ElevenLabs TTFB) to near-zero.
  const pumpTts = useCallback(() => {
    while (ttsInFlightCountRef.current < TTS_INFLIGHT_MAX) {
      const next = ttsQueueRef.current.shift()
      if (!next) {
        if (turnEndedRef.current && ttsInFlightCountRef.current === 0) {
          setState((prev) => (prev === 'talking' || prev === 'thinking' ? 'idle' : prev))
        }
        return
      }
      // Increment SYNCHRONOUSLY so the next loop iteration (and any
      // concurrent pumpTts in the same tick) sees the slot consumed before
      // ttsSpeak's IPC even resolves.
      ttsInFlightCountRef.current++
      setState('talking')
      window.orb.ttsSpeak(next).catch(() => {
        // Speak request failed before reaching main — refund the slot and
        // try the next sentence so we don't stall the queue.
        ttsInFlightCountRef.current = Math.max(0, ttsInFlightCountRef.current - 1)
        pumpTts()
      })
    }
  }, [])

  const appendTtsText = useCallback(
    (chunk: string) => {
      ttsBufferRef.current += chunk
      const { complete, incomplete } = chunkForTts(
        ttsBufferRef.current,
        firstChunkPendingRef.current,
      )
      ttsBufferRef.current = incomplete
      if (complete.length) {
        firstChunkPendingRef.current = false
        for (const s of complete) ttsQueueRef.current.push(s)
      }
      pumpTts()
    },
    [pumpTts],
  )

  const flushPendingTts = useCallback(() => {
    const tail = ttsBufferRef.current.trim()
    ttsBufferRef.current = ''
    if (tail) {
      ttsQueueRef.current.push(tail)
      firstChunkPendingRef.current = false
    }
    pumpTts()
  }, [pumpTts])

  const cancelAllSpeech = useCallback(() => {
    ttsQueueRef.current = []
    ttsBufferRef.current = ''
    ttsInFlightCountRef.current = 0
    firstChunkPendingRef.current = true
    narrationGenRef.current++
    void window.orb.ttsCancel()
  }, [])

  // TTS done events drive the queue forward. Main emits 'done' for every id
  // it accepted — including prefetched ids that get abandoned via cancel —
  // so a simple decrement-and-pump keeps the renderer's view of in-flight
  // count consistent without needing to track individual ids. The
  // `Math.max(0, …)` floor protects against a late-arriving done that races
  // a cancelAllSpeech zeroing.
  useEffect(() => {
    return window.orb.onTtsDone(() => {
      ttsInFlightCountRef.current = Math.max(0, ttsInFlightCountRef.current - 1)
      pumpTts()
    })
  }, [pumpTts])

  // ─── Add a transcript entry, ring-buffered ───
  const pushTranscript = useCallback((role: TranscriptEntry['role'], text: string) => {
    if (!text.trim()) return
    setTranscript((prev) => {
      const next = [...prev, { id: uid(), role, text }]
      return next.length > MAX_TRANSCRIPT ? next.slice(-MAX_TRANSCRIPT) : next
    })
  }, [])

  // ─── Backend events ───
  useEffect(() => {
    const off = window.orb.onEvent((rawEvent) => {
      const evt = rawEvent as { type: string; [k: string]: unknown }
      switch (evt.type) {
        case 'orb_user_turn': {
          const text = String(evt.text || '')
          if (text) pushTranscript('user', text)
          turnEndedRef.current = false
          firstChunkPendingRef.current = true
          inFlightOrbIdRef.current = uid()
          // Pre-create an empty orb entry so streaming has somewhere to land.
          setTranscript((prev) => {
            const next = [...prev, { id: inFlightOrbIdRef.current!, role: 'orb' as const, text: '' }]
            return next.length > MAX_TRANSCRIPT ? next.slice(-MAX_TRANSCRIPT) : next
          })
          break
        }
        case 'orb_user_attachment': {
          // Auto-screenshot fired before the user-turn event. Trigger the rim
          // flash and clear it ~320ms later so an immediate follow-up turn
          // with another attachment can re-arm the effect cleanly.
          setFlashAt(Date.now())
          setTimeout(() => setFlashAt(null), 320)
          break
        }
        case 'text_chunk': {
          const text = String((evt as { text?: string }).text || '')
          if (!text) break
          // Append to in-flight orb transcript
          if (inFlightOrbIdRef.current) {
            const id = inFlightOrbIdRef.current
            setTranscript((prev) =>
              prev.map((m) => (m.id === id ? { ...m, text: m.text + text } : m)),
            )
          }
          appendTtsText(text)
          break
        }
        case 'tool_call': {
          const toolName = String((evt as { toolName?: string }).toolName || '')
          if (!toolName || /^(Read|Glob|Grep|LS|TodoRead|TodoWrite)$/.test(toolName)) break
          // Non-silent tool call: speak whatever short tail is still in the
          // buffer instead of waiting for task_complete, and re-arm the
          // first-chunk threshold so the next text segment gets the same
          // fast TTFA as the very first sentence of the turn. Narration
          // itself is produced inline by claude (see ORB_SYSTEM_PROMPT's
          // NARRATION section) — no separate IPC call needed.
          flushPendingTts()
          firstChunkPendingRef.current = true
          const friendly = toolName.startsWith('mcp__rax-orb__')
            ? toolName.replace('mcp__rax-orb__', '').replace(/^rax_/, '').replace(/_/g, ' ')
            : toolName.toLowerCase()
          pushTranscript('tool', `running ${friendly}`)
          setCurrentTool(friendly)
          break
        }
        case 'task_complete': {
          turnEndedRef.current = true
          inFlightOrbIdRef.current = null
          flushPendingTts()
          // Only transition to idle once main is fully drained — both the
          // local queue AND main's pipeline (current + prefetched) need to
          // be empty, otherwise the orb would flash idle while there's still
          // unspoken audio in flight.
          if (ttsInFlightCountRef.current === 0 && ttsQueueRef.current.length === 0) {
            setState((prev) => (prev === 'thinking' || prev === 'talking' ? 'idle' : prev))
          }
          break
        }
        case 'error': {
          const message = String((evt as { message?: string }).message || 'Unknown error')
          setErrorText(message)
          inFlightOrbIdRef.current = null
          turnEndedRef.current = true
          // Silence any in-flight / queued TTS so the orb stops mid-thought
          // instead of finishing a sentence after a session error.
          cancelAllSpeech()
          playError()
          setState('error')
          break
        }
        case 'orb_session_dead': {
          setErrorText('Voice agent session ended. Click the orb to retry.')
          turnEndedRef.current = true
          inFlightOrbIdRef.current = null
          cancelAllSpeech()
          playError()
          setState('error')
          break
        }
      }
    })

    const offForceListen = window.orb.onForceListen(() => {
      const s = stateRef.current
      if (s === 'idle' || s === 'error') {
        void startRecording()
      } else if (s === 'thinking' || s === 'talking') {
        // Push-to-talk pressed mid-response — treat as an explicit barge-in
        // so the user can interrupt without waiting for VAD threshold.
        triggerBargeIn()
      }
      // Pressed during 'listening' / 'transcribing' — already capturing,
      // no-op.
    })

    const offHoldStart = window.orb.onHoldStart(() => {
      const s = stateRef.current
      if (s === 'idle' || s === 'error') {
        holdModeRef.current = true
        void startRecording()
      } else if (s === 'thinking' || s === 'talking') {
        // Barge-in into hold mode: cancel current TTS / turn, then begin
        // a new hold-mode recording. Mirrors triggerBargeIn but with the
        // holdModeRef flag set first so VAD won't auto-stop us.
        playBargeIn()
        stopBargeIn()
        cancelAllSpeech()
        void window.orb.cancelTurn()
        holdModeRef.current = true
        void startRecording()
      } else if (s === 'listening') {
        // Already recording (e.g. user clicked then pressed Option+R) —
        // promote to hold mode so VAD silence won't end it early.
        holdModeRef.current = true
      }
      // 'transcribing' — too late to change duration, drop.
    })

    const offHoldEnd = window.orb.onHoldEnd(() => {
      if (!holdModeRef.current) return
      // stopRecording clears holdModeRef itself; finalizeRecording then
      // transcribes + submits whatever we captured.
      if (stateRef.current === 'listening') {
        stopRecording(false)
      } else {
        holdModeRef.current = false
      }
    })

    const offDismiss = window.orb.onDismissed(() => {
      // Window hidden by host — clean up everything mid-flight so we don't
      // keep recording / speaking / billing tokens.
      stopRecording(true)
      cancelAllSpeech()
      stopBargeIn()
      // If a claude turn was still streaming, stop it.
      void window.orb.cancelTurn()
    })

    // Tell main "renderer is ready" so any push-to-talk hotkey that fired
    // before mount can be flushed now.
    window.orb.rendererReady()

    return () => {
      off()
      offForceListen()
      offHoldStart()
      offHoldEnd()
      offDismiss()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendTtsText, flushPendingTts, cancelAllSpeech, pushTranscript])

  // ─── Animate the state label on every transition (and on each tool change
  //     during thinking, so the caption re-animates per tool). ───
  useEffect(() => {
    setLabelKey((k) => k + 1)
  }, [state, currentTool])

  // Clear the tool caption whenever we leave the thinking state — by then
  // we're either talking (TTS playing) or done.
  useEffect(() => {
    if (state !== 'thinking') setCurrentTool(null)
  }, [state])

  // Mirror state into a ref + push a busy signal to main. Main uses busy to
  // suppress its own auto-hide-on-blur logic so a tab opened by the orb
  // doesn't accidentally cancel the orb's in-flight turn. Also push the raw
  // voice state to main so the caption-pill window can drive its visibility
  // off real speaking state (thinking/talking → visible) rather than racing
  // a fixed-duration hide timer against TTS overhang.
  useEffect(() => {
    stateRef.current = state
    const busy = state !== 'idle' && state !== 'error'
    window.orb.setBusy(busy)
    window.orb.setVoiceState(state)
  }, [state])

  // ─── Click-through plumbing ───
  // Empty pixels around the orb pass clicks through to the desktop. When the
  // cursor enters the orb's circular hit zone we capture; when it leaves we
  // go click-through again.
  const isCapturingRef = useRef(false)
  useEffect(() => {
    const updateCapture = (clientX: number, clientY: number) => {
      const cx = window.innerWidth / 2
      const cy = window.innerHeight / 2
      const dist = Math.hypot(clientX - cx, clientY - cy)
      const overOrb = dist <= ORB_HIT_RADIUS
      if (overOrb && !isCapturingRef.current) {
        isCapturingRef.current = true
        window.orb.setIgnoreMouseEvents(false)
      } else if (!overOrb && isCapturingRef.current) {
        isCapturingRef.current = false
        window.orb.setIgnoreMouseEvents(true, { forward: true })
      }
    }
    const onMove = (e: MouseEvent) => updateCapture(e.clientX, e.clientY)
    const onLeave = () => {
      if (isCapturingRef.current) {
        isCapturingRef.current = false
        window.orb.setIgnoreMouseEvents(true, { forward: true })
      }
    }
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  // ─── Recording ───

  const stopRecording = useCallback((cancel: boolean) => {
    if (vadRafRef.current) {
      cancelAnimationFrame(vadRafRef.current)
      vadRafRef.current = 0
    }
    if (vadCtxRef.current && vadCtxRef.current.state !== 'closed') {
      vadCtxRef.current.close().catch(() => {})
      vadCtxRef.current = null
    }
    vadAnalyserRef.current = null
    setVizAnalyser(null)

    if (!cancel) {
      // Distinct cue for max-record cap: the user kept talking past 30s, we
      // cut them off and want to flag that. Otherwise the gentle listen-end.
      if (recordCappedRef.current) playListenCap()
      else playListenEnd()
    }
    recordCappedRef.current = false
    holdModeRef.current = false

    recordCancelledRef.current = cancel
    const recorder = recorderRef.current
    if (recorder && recorder.state === 'recording') {
      try { recorder.stop() } catch {}
    } else {
      recorderStreamRef.current?.getTracks().forEach((t) => t.stop())
      recorderStreamRef.current = null
      if (cancel) setState('idle')
    }
  }, [])

  const finalizeRecording = useCallback(async () => {
    setState('transcribing')
    try {
      const chunks = recorderChunksRef.current
      if (!chunks.length) {
        setState('idle')
        return
      }
      const blob = new Blob(chunks, { type: recorderMimeRef.current })
      const wavBase64 = await blobToWavBase64(blob)
      const result = await window.orb.transcribeAudio(wavBase64)
      if (result.error) {
        setErrorText(result.error)
        setState('error')
        return
      }
      const text = (result.transcript || '').trim()
      if (!text) {
        // Empty transcript = whisper saw silence or a known hallucination.
        // Give the user an audible cue so they know the mic worked but
        // nothing was registered.
        playMishear()
        setState('idle')
        return
      }
      setState('thinking')
      const submit = await window.orb.submitTurn(text)
      if (!submit.ok) {
        setErrorText(submit.error || 'Failed to submit turn')
        setState('error')
      }
    } catch (err) {
      const e = err as Error
      setErrorText(e.message || 'Voice failed')
      setState('error')
    }
  }, [])

  const startRecording = useCallback(async () => {
    setErrorText(null)
    cancelAllSpeech()
    stopBargeIn()
    recorderChunksRef.current = []
    recordCancelledRef.current = false

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      const e = err as Error
      const denied = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
      setErrorText(denied ? 'Microphone permission denied.' : `Mic error: ${e.message}`)
      setState('error')
      return
    }
    recorderStreamRef.current = stream

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    recorderMimeRef.current = mime

    const recorder = new MediaRecorder(stream, { mimeType: mime })
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recorderChunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      recorderStreamRef.current = null
      if (recordCancelledRef.current) {
        setState('idle')
        return
      }
      void finalizeRecording()
    }
    recorder.onerror = () => {
      stream.getTracks().forEach((t) => t.stop())
      recorderStreamRef.current = null
      setErrorText('Recording failed.')
      setState('error')
    }
    recorderRef.current = recorder
    recorder.start()
    setState('listening')
    playListenStart()

    // VAD setup
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctor()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.6
    ctx.createMediaStreamSource(stream).connect(analyser)
    vadCtxRef.current = ctx
    vadAnalyserRef.current = analyser
    // Share the same analyser with the VoiceOrb canvas — opening a second
    // getUserMedia just for the visualisation would double the OS mic
    // indicator and could bind to a different input device.
    setVizAnalyser(analyser)
    vadStartedAtRef.current = performance.now()
    vadStartedSpeakingAtRef.current = null
    vadLastVoiceAtRef.current = 0
    recordCappedRef.current = false

    // Adaptive VAD: sample ~200ms of ambient and lift the speech/silence
    // thresholds by the measured floor, so the detector still fires in
    // cafés / open offices instead of treating background chatter as
    // speech. The constants stay as floors — quiet rooms keep the original
    // (more sensitive) defaults.
    const CALIBRATION_MS = 200
    let calibrating = true
    const calibrationStartedAt = performance.now()
    let calibrationSumRms = 0
    let calibrationN = 0
    let speechThreshold = VAD_SPEECH_RMS
    let silenceThreshold = VAD_SILENCE_RMS

    const data = new Uint8Array(analyser.fftSize)
    const tick = () => {
      const a = vadAnalyserRef.current
      if (!a) return
      a.getByteTimeDomainData(data)
      let sumSq = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sumSq += v * v
      }
      const rms = Math.sqrt(sumSq / data.length)
      const now = performance.now()
      if (calibrating) {
        calibrationSumRms += rms
        calibrationN += 1
        if (now - calibrationStartedAt >= CALIBRATION_MS) {
          const noiseFloor = calibrationN > 0 ? calibrationSumRms / calibrationN : 0
          speechThreshold = Math.max(VAD_SPEECH_RMS, noiseFloor + 0.02)
          silenceThreshold = Math.max(VAD_SILENCE_RMS, noiseFloor + 0.005)
          calibrating = false
          // Reset so the calibration window doesn't eat into MAX_RECORD_MS.
          vadStartedAtRef.current = now
        }
        vadRafRef.current = requestAnimationFrame(tick)
        return
      }
      const sinceStart = now - vadStartedAtRef.current
      if (rms > speechThreshold) {
        if (vadStartedSpeakingAtRef.current === null) {
          vadStartedSpeakingAtRef.current = now
        }
        vadLastVoiceAtRef.current = now
      }
      const heardEnough =
        vadStartedSpeakingAtRef.current !== null &&
        now - vadStartedSpeakingAtRef.current > MIN_SPEECH_MS
      const silenceMs = vadLastVoiceAtRef.current ? now - vadLastVoiceAtRef.current : 0
      const silenceLongEnough = heardEnough && silenceMs > VAD_SILENCE_HOLD_MS && rms < silenceThreshold
      const tooLong = sinceStart > MAX_RECORD_MS
      // Hold-to-speak: the key release is authoritative; ignore VAD
      // silence + the soft cap so the user controls duration. Continue
      // running the tick so the orb canvas keeps animating from the analyser.
      if ((silenceLongEnough || tooLong) && !holdModeRef.current) {
        if (tooLong) recordCappedRef.current = true
        stopRecording(false)
        return
      }
      vadRafRef.current = requestAnimationFrame(tick)
    }
    vadRafRef.current = requestAnimationFrame(tick)
  }, [cancelAllSpeech, finalizeRecording, stopRecording])

  // ─── Voice barge-in ───
  // While the orb is thinking or talking, run a mic VAD with a higher
  // threshold (so speaker bleed during talking doesn't trip it). When the
  // user actually speaks we cancel the in-flight turn + TTS and roll
  // straight into a new listening session — covers the long pause before
  // claude starts streaming, not just the speaking phase.
  const stopBargeIn = useCallback(() => {
    if (bargeRafRef.current) {
      cancelAnimationFrame(bargeRafRef.current)
      bargeRafRef.current = 0
    }
    if (bargeCtxRef.current && bargeCtxRef.current.state !== 'closed') {
      bargeCtxRef.current.close().catch(() => {})
      bargeCtxRef.current = null
    }
    bargeAnalyserRef.current = null
    if (bargeStreamRef.current) {
      bargeStreamRef.current.getTracks().forEach((t) => t.stop())
      bargeStreamRef.current = null
    }
    bargeFirstVoiceAtRef.current = null
  }, [])

  const triggerBargeIn = useCallback(() => {
    playBargeIn()
    stopBargeIn()
    cancelAllSpeech()
    void window.orb.cancelTurn()
    void startRecording()
  }, [stopBargeIn, cancelAllSpeech, startRecording])

  // Stable boolean so the thinking → talking transition doesn't tear down
  // and rebuild the mic mid-turn (would briefly disable barge-in).
  const bargeInActive = state === 'talking' || state === 'thinking'
  useEffect(() => {
    if (!bargeInActive) {
      stopBargeIn()
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        bargeStreamRef.current = stream
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new Ctor()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.55
        ctx.createMediaStreamSource(stream).connect(analyser)
        bargeCtxRef.current = ctx
        bargeAnalyserRef.current = analyser
        bargeFirstVoiceAtRef.current = null

        const data = new Uint8Array(analyser.fftSize)
        const tick = () => {
          const a = bargeAnalyserRef.current
          if (!a) return
          a.getByteTimeDomainData(data)
          let sumSq = 0
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128
            sumSq += v * v
          }
          const rms = Math.sqrt(sumSq / data.length)
          const now = performance.now()
          if (rms > BARGE_IN_RMS) {
            if (bargeFirstVoiceAtRef.current === null) {
              bargeFirstVoiceAtRef.current = now
            }
            if (now - bargeFirstVoiceAtRef.current >= BARGE_IN_MIN_MS) {
              triggerBargeIn()
              return
            }
          } else {
            bargeFirstVoiceAtRef.current = null
          }
          bargeRafRef.current = requestAnimationFrame(tick)
        }
        bargeRafRef.current = requestAnimationFrame(tick)
      } catch {
        // Mic perm denied or device gone — barge-in disabled, click still works.
      }
    })()
    return () => {
      cancelled = true
      stopBargeIn()
    }
  }, [bargeInActive, stopBargeIn, triggerBargeIn])

  // ─── Click + keyboard ───

  const onOrbClick = useCallback(() => {
    if (state === 'idle' || state === 'error') {
      void startRecording()
    } else if (state === 'listening') {
      stopRecording(false)
    } else if (state === 'talking') {
      cancelAllSpeech()
      setState('idle')
    } else if (state === 'thinking') {
      void window.orb.cancelTurn()
      cancelAllSpeech()
      setState('idle')
    }
  }, [state, startRecording, stopRecording, cancelAllSpeech])

  // Drag with click-vs-drag detection AND rAF throttle for the IPC.
  const onOrbMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const startCursorX = e.screenX
      const startCursorY = e.screenY
      const startWindowX = window.screenX
      const startWindowY = window.screenY
      let dragged = false
      let pendingX: number | null = null
      let pendingY: number | null = null
      let rafId: number | null = null

      const flush = () => {
        rafId = null
        if (pendingX !== null && pendingY !== null) {
          window.orb.setBounds(pendingX, pendingY)
          pendingX = null
          pendingY = null
        }
      }

      const onMove = (m: MouseEvent) => {
        const dCursorX = m.screenX - startCursorX
        const dCursorY = m.screenY - startCursorY
        // 7px (was 4) — trackpad sensitivity makes 4px easy to cross during a
        // tap, so the orb misclassified taps as drags. 7px is roughly one
        // physical mm on a Retina display and avoids the false-positive.
        if (!dragged && Math.hypot(dCursorX, dCursorY) > 7) dragged = true
        if (dragged) {
          pendingX = startWindowX + dCursorX
          pendingY = startWindowY + dCursorY
          if (rafId === null) rafId = requestAnimationFrame(flush)
        }
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
          flush()
        }
        if (!dragged) onOrbClick()
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [onOrbClick],
  )

  // Long-press the orb (650ms) to reset the conversation.
  const onOrbContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      void window.orb.resetSession()
      setTranscript([])
      cancelAllSpeech()
      setState('idle')
      setErrorText(null)
    },
    [cancelAllSpeech],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        onOrbClick()
      } else if (e.key === 'Escape') {
        cancelAllSpeech()
        if (state === 'listening') stopRecording(true)
        if (state === 'thinking') void window.orb.cancelTurn()
        void window.orb.hide()
      } else if (e.key === 'Tab' && !e.metaKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault()
        setShowTranscript((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault()
        void window.orb.resetSession()
        setTranscript([])
        cancelAllSpeech()
        setState('idle')
        setErrorText(null)
      }
    }
    // Backup hold-release detector. globalShortcut on macOS consumes the
    // chord keydown so the renderer never sees Alt+R going down — but the
    // OS still delivers the keyup of Alt or R to the focused window. If the
    // main-process before-input-event listener misses it (focus race, OS
    // event filtering on unmatched keyups), this DOM listener catches it.
    // The matching ORB_HOLD_END from main is idempotent thanks to the
    // holdModeRef guard.
    const onKeyUp = (e: KeyboardEvent) => {
      if (!holdModeRef.current) return
      if (e.code === 'KeyR' || e.code === 'AltLeft' || e.code === 'AltRight') {
        if (stateRef.current === 'listening') {
          stopRecording(false)
        } else {
          holdModeRef.current = false
        }
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [state, onOrbClick, stopRecording, cancelAllSpeech])

  useEffect(
    () => () => {
      stopRecording(true)
      cancelAllSpeech()
      stopBargeIn()
    },
    [stopRecording, cancelAllSpeech, stopBargeIn],
  )

  // While thinking with an active tool, replace the opaque "thinking" text
  // with the live tool name. The persistent class skips the auto fade-out so
  // the caption stays visible for the full duration of long tool calls.
  const showingTool = state === 'thinking' && !!currentTool
  const label = showingTool ? `running ${currentTool}` : STATE_LABEL[state]
  const orbState = stateToOrb(state)
  const transcriptVisible = showTranscript && transcript.length > 0

  return (
    <div className="orb-page">
      {errorText && (
        <div className="orb-overlay orb-error" role="alert">
          <span>{errorText}</span>
          <button type="button" onClick={() => setErrorText(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <div
        className="orb-tap"
        role="button"
        tabIndex={0}
        aria-label="Voice orb — click to talk, hold Option+R for push-to-talk, drag to move, right-click to reset"
        onMouseDown={onOrbMouseDown}
        onContextMenu={onOrbContextMenu}
      >
        <VoiceOrb state={orbState} size={100} analyser={vizAnalyser} flashAt={flashAt} />
      </div>

      {label && (
        <div
          key={labelKey}
          className={`orb-overlay state-label${showingTool ? ' persistent' : ''}`}
        >
          {label}
        </div>
      )}

      {transcriptVisible && (
        <div className="orb-transcript" aria-live="polite">
          {transcript.map((t) => (
            <TranscriptTurn key={t.id} entry={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function TranscriptTurn({ entry }: { entry: TranscriptEntry }) {
  const roleLabel = useMemo(() => {
    if (entry.role === 'user') return 'You'
    if (entry.role === 'orb') return 'Orb'
    return 'Tool'
  }, [entry.role])
  return (
    <div className="turn">
      <div className={`role ${entry.role}`}>{roleLabel}</div>
      <div>{entry.text}</div>
    </div>
  )
}

// ─── WebM/Opus → 16 kHz mono WAV ───

async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new AudioContext()
  const decoded = await audioCtx.decodeAudioData(arrayBuffer)
  audioCtx.close()
  const mono = mixToMono(decoded)
  if (rmsLevel(mono) < 0.002) {
    throw new Error('No voice detected')
  }
  const resampled = resampleLinear(mono, decoded.sampleRate, 16000)
  const normalized = normalizePcm(resampled)
  const wavBuffer = encodeWav(normalized, 16000)
  return bufferToBase64(wavBuffer)
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer
  if (numberOfChannels <= 1) return buffer.getChannelData(0)
  const mono = new Float32Array(length)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channel = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) mono[i] += channel[i]
  }
  const inv = 1 / numberOfChannels
  for (let i = 0; i < length; i++) mono[i] *= inv
  return mono
}

function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input
  const ratio = inRate / outRate
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = pos - i0
    output[i] = input[i0] * (1 - t) + input[i1] * t
  }
  return output
}

function normalizePcm(samples: Float32Array): Float32Array {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  if (peak < 1e-4 || peak > 0.95) return samples
  const gain = Math.min(0.95 / peak, 8)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain
  return out
}

function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
  return Math.sqrt(sumSq / samples.length)
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length
  const buffer = new ArrayBuffer(44 + numSamples * 2)
  const view = new DataView(buffer)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + numSamples * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, numSamples * 2, true)
  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    offset += 2
  }
  return buffer
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
