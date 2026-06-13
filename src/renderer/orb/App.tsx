import { useCallback, useEffect, useRef, useState } from 'react'
import { Notch, type TtsEnvelopeFrames } from './Notch'
import { NotchSettings } from './NotchSettings'
import { OnboardingTour, type TourApi, type TourSpotlight } from './Onboarding'
import { RealtimeVoiceClient, GROK_TRANSPORT, GEMINI_TRANSPORT } from './realtime-voice'
import { DEFAULT_KOKORO_VOICE } from '../../shared/kokoro-voices'
import { DEFAULT_MASCOT_COLOR_ID } from '../../shared/mascot-colors'
import {
  playBargeIn,
  playError,
  playListenCap,
  playListenEnd,
  playListenStart,
  playMishear,
  playTurnDone,
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

// VAD tuning — normalised 0..1 RMS values.
const VAD_SPEECH_RMS = 0.045
const VAD_SILENCE_RMS = 0.018
// How long a silence must last before the turn ends. 600ms (down from 850)
// is affordable because speculative transcription (below) eats the Whisper
// cost INSIDE this window — the hold itself is now the only post-speech
// wait, so it can't hide other latency and earns a tighter value.
const VAD_SILENCE_HOLD_MS = 600
// Kick off Whisper THIS far into a candidate silence, on the audio captured
// so far. If the silence holds, the transcript is ready (or nearly so) the
// moment the turn ends — the "transcribing" phase collapses to ~0ms. If the
// user resumes talking instead, the speculative run is discarded. The only
// audio a surviving speculation misses is trailing silence, so accuracy is
// unaffected.
const SPECULATIVE_TRANSCRIBE_MS = 250
const MIN_SPEECH_MS = 350
const MAX_RECORD_MS = 30_000
// Nothing said: close quietly with the mishear cue instead of trapping the
// user until the 30s cap (which then reads as "you talked too long" — wrong
// for an accidental activation). Hold-to-speak ignores this; the key release
// is authoritative there.
const NO_SPEECH_TIMEOUT_MS = 7_000

// Barge-in VAD (during thinking + TTS) — higher threshold so speaker bleed
// during talking doesn't trip it.
const BARGE_IN_RMS = 0.08
const BARGE_IN_MIN_MS = 220

// Everything captured by the barge mic from the moment voice first crosses
// the threshold, so the user's interruption reaches Whisper with its onset
// intact (see the pre-roll recorder in the barge-in effect). Handed to
// startRecording when the barge-in confirms.
interface BargeHandoff {
  stream: MediaStream
  recorder: MediaRecorder | null
  chunks: Blob[]
  ctx: AudioContext | null
  analyser: AnalyserNode | null
  voiceAt: number | null
}

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

// One Segmenter for the app's lifetime — findCut runs on every streamed
// token batch, and constructing a fresh Intl.Segmenter (locale lookup +
// ICU setup) per call is the hot path's only allocation of note.
const sentenceSegmenter: Intl.Segmenter | null = (() => {
  try {
    const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
    return Segmenter ? new Segmenter('en', { granularity: 'sentence' }) : null
  } catch {
    return null
  }
})()

// The system prompt asks for plain spoken English, but models still leak
// markdown (especially the non-Claude ones routed through the proxy).
// Kokoro reads "**bold**" as "asterisk asterisk…" territory and URLs as
// letter soup, so strip formatting down to the words before synthesis.
// The sanitized text also feeds the caption pill via tts_segment, so the
// subtitles clean up for free.
function sanitizeForSpeech(text: string): string {
  return (
    text
      // Fence markers (content between them still reads — dropping it would
      // silently swallow words; claude is prompted not to emit blocks at all).
      .replace(/```[a-zA-Z0-9_-]*/g, ' ')
      // Images & links → their label text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Inline code, bold, underscores-as-bold.
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      // A bold span split across two streamed pieces leaves an unpaired
      // marker behind — drop it (single * stays: it can be real math).
      .replace(/\*\*/g, ' ')
      .replace(/`/g, '')
      // Bullet / heading / quote markers at line starts.
      .replace(/^[ \t]*[-*•][ \t]+/gm, '')
      .replace(/^#{1,6}[ \t]+/gm, '')
      .replace(/^>[ \t]+/gm, '')
      // Bare URLs are unreadable aloud.
      .replace(/https?:\/\/\S+/g, 'the link')
      .replace(/[ \t]{2,}/g, ' ')
  )
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
  if (sentenceSegmenter) {
    try {
      const segs = Array.from(sentenceSegmenter.segment(s))
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

// ─── Live-captions setting (shared localStorage) ───
// Same `rax-settings` key the fullscreen Settings and the caption pill use —
// all windows share one Electron origin. Merge-writes so the other settings
// in the blob survive; the pill's `storage` listener picks the flip up live,
// and the fullscreen themeStore reconciles from the same key on next boot.
const RAX_SETTINGS_KEY = 'rax-settings'

function readCaptionsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(RAX_SETTINGS_KEY)
    if (!raw) return true
    const parsed = JSON.parse(raw)
    return typeof parsed.voiceCaptionsEnabled === 'boolean' ? parsed.voiceCaptionsEnabled : true
  } catch {
    return true
  }
}

function writeCaptionsEnabled(enabled: boolean): void {
  try {
    const raw = localStorage.getItem(RAX_SETTINGS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    parsed.voiceCaptionsEnabled = enabled
    localStorage.setItem(RAX_SETTINGS_KEY, JSON.stringify(parsed))
  } catch {}
}

export default function App() {
  const [state, setState] = useState<VoiceState>('idle')
  const stateRef = useRef<VoiceState>('idle')
  const [errorText, setErrorText] = useState<string | null>(null)
  // Latest tool name shown as a live caption while the orb is "thinking" — fixes
  // the otherwise-opaque thinking state on heavy turns (10s+).
  const [currentTool, setCurrentTool] = useState<string | null>(null)
  // Trigger for the one-shot rim flash that plays when the auto-screenshot
  // pipeline attaches an image to the outgoing turn. Reset back to null after
  // the flash window so a back-to-back attachment within the same ms still
  // re-arms the effect.
  const [flashAt, setFlashAt] = useState<number | null>(null)
  // Whether the display under the island has a hardware notch. Main detects
  // it (menu-bar inset heuristic) and pushes on create/recenter; the island
  // shrinks its center dead-zone and parked width on notchless displays so
  // it reads as a compact pill instead of a fake notch with a hollow middle.
  const [notched, setNotched] = useState(true)

  useEffect(() => {
    return window.orb.onDisplayProfile((profile) => {
      setNotched(profile.notched)
    })
  }, [])

  // Mascot visor colorway — main pushes the persisted choice on renderer-
  // ready and live on every Settings change. Default (Rax blue) until the
  // first push lands.
  const [mascotColor, setMascotColor] = useState<string | undefined>(undefined)
  useEffect(() => {
    return window.orb.onMascotColor((payload) => {
      setMascotColor(payload.colorId)
    })
  }, [])

  // ─── Intro-cameo entrance choreography ───
  // Main pushes 'hold' before an intro-led summon (keep the seat empty —
  // the big center-screen mascot is performing) and 'land' when the cameo
  // merges into the bar. Cleared on dismiss so a later plain summon
  // tumbles as usual.
  const [introEntrance, setIntroEntrance] = useState<{
    at: number
    kind: 'hold' | 'land' | 'show' | 'hide'
  } | null>(null)
  useEffect(() => {
    const offEntrance = window.orb.onEntrance((p) =>
      setIntroEntrance({ at: performance.now(), kind: p.kind }),
    )
    const offDismiss = window.orb.onDismissed(() => setIntroEntrance(null))
    return () => {
      offEntrance()
      offDismiss()
    }
  }, [])

  // The mascot's seat (window-relative rect of the parked bar's mascot) —
  // pushed to main so the intro cameo knows exactly where to fly, tagged
  // with the display profile the geometry reflects (main discards seats
  // measured for the wrong profile — parked width differs ~52px). Measured
  // immediately on mount (initial={false} renders the bar at rest), then
  // settle-delayed after every display-profile push so a re-summon on a
  // different display always yields a fresh, post-spring measure. Precision
  // past ~30px doesn't matter: touchdown happens BEHIND the opaque bar.
  const seatMeasuredOnceRef = useRef(false)
  useEffect(() => {
    const measure = () => {
      const el = document.querySelector('.notch-mascot')
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.width < 4) return
      window.orb.pushMascotSeat({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        notched,
      })
    }
    const timers: number[] = []
    // The bar re-springs to the new parked width over ~170ms when the
    // profile flips — measure only after it settles, or main would fly the
    // cameo to a mid-animation x.
    const settleMeasure = () => {
      timers.push(window.setTimeout(measure, 380))
    }
    if (!seatMeasuredOnceRef.current) {
      seatMeasuredOnceRef.current = true
      measure()
    }
    settleMeasure()
    const offProfile = window.orb.onDisplayProfile(settleMeasure)
    window.addEventListener('resize', measure)
    return () => {
      timers.forEach((t) => clearTimeout(t))
      offProfile()
      window.removeEventListener('resize', measure)
    }
  }, [notched])

  // ─── Realtime voice backends (Grok / Gemini) ───
  // Main owns the truth (<userData>/grok-voice.json + gemini-voice.json —
  // the API keys never reach this window); we mirror the public shapes for
  // the settings panel and the activation routing. When either is `enabled`,
  // clicking the notch opens a CONTINUOUS speech-to-speech session
  // (server-side VAD + barge-in) instead of the record → whisper → claude →
  // Kokoro pipeline. Default stays the local pipeline; both are pure opt-in
  // and mutually exclusive (main flips the other off).
  const [grokCfg, setGrokCfg] = useState<{
    enabled: boolean
    voice: string
    hasKey: boolean
    keyTail: string
    pushToTalk?: boolean
  }>({ enabled: false, voice: 'ara', hasKey: false, keyTail: '', pushToTalk: false })
  const grokCfgRef = useRef(grokCfg)
  useEffect(() => {
    grokCfgRef.current = grokCfg
  }, [grokCfg])
  useEffect(() => {
    let dead = false
    window.orb
      .getGrokConfig()
      .then((cfg) => {
        if (!dead && cfg) setGrokCfg(cfg)
      })
      .catch(() => {})
    const off = window.orb.onGrokConfig((cfg) => setGrokCfg(cfg))
    return () => {
      dead = true
      off()
    }
  }, [])

  const [geminiCfg, setGeminiCfg] = useState<{
    enabled: boolean
    voice: string
    hasKey: boolean
    keyTail: string
    screenShare?: boolean
    pushToTalk?: boolean
  }>({
    enabled: false,
    voice: 'Aoede',
    hasKey: false,
    keyTail: '',
    screenShare: false,
    pushToTalk: false,
  })
  const geminiCfgRef = useRef(geminiCfg)
  useEffect(() => {
    geminiCfgRef.current = geminiCfg
  }, [geminiCfg])
  useEffect(() => {
    let dead = false
    window.orb
      .getGeminiConfig()
      .then((cfg) => {
        if (!dead && cfg) setGeminiCfg(cfg)
      })
      .catch(() => {})
    const off = window.orb.onGeminiConfig((cfg) => setGeminiCfg(cfg))
    return () => {
      dead = true
      off()
    }
  }, [])

  // Live session handle. A ref (not state) drives the audio machinery; the
  // boolean mirrors into state for the bits of UI that depend on it.
  const rtClientRef = useRef<RealtimeVoiceClient | null>(null)
  const [rtActive, setRtActive] = useState(false)
  const rtActiveRef = useRef(false)
  // ⌥R is physically down right now (realtime push-to-talk). Tracked outside
  // the client because the key can go down BEFORE the session exists — the
  // hold then starts a session, and startRealtimeSession re-applies the hold
  // once the client is live (if the key is still down by then).
  const rtHoldDownRef = useRef(false)

  // ─── Inline settings panel (gear on the bar) ───
  // The island's own voice-agent controls: voice, live captions, colorway.
  // Values hydrate when the panel opens — main's handlers are the on-disk
  // truth for voice/color; captions live in the shared localStorage blob.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [voiceId, setVoiceId] = useState<string>(DEFAULT_KOKORO_VOICE)
  const [captionsEnabled, setCaptionsEnabled] = useState(true)

  const toggleSettings = useCallback((openNext: boolean) => {
    // The tour watches settingsOpen itself: opening it on the gear step
    // resolves that step (and finishes the tour); opening it on any other
    // step makes the tour bow out. So nothing tour-specific is needed here.
    setSettingsOpen(openNext)
    if (openNext) {
      setCaptionsEnabled(readCaptionsEnabled())
      window.orb
        .getVoice()
        .then((res) => {
          if (res?.voice) setVoiceId(res.voice)
        })
        .catch(() => {})
    }
  }, [])

  const handleVoiceChange = useCallback((id: string) => {
    // Optimistic — the panel is ephemeral and re-hydrates from main on every
    // open, so a failed write self-corrects next time.
    setVoiceId(id)
    void window.orb.setVoice(id).catch(() => {})
  }, [])

  const handleCaptionsChange = useCallback((enabled: boolean) => {
    setCaptionsEnabled(enabled)
    writeCaptionsEnabled(enabled)
  }, [])

  const handleColorChange = useCallback((id: string) => {
    // Optimistic for instant swatch + visor feedback; main persists and
    // pushes the confirmed value back through onMascotColor.
    setMascotColor(id)
    void window.orb.setMascotColor(id).catch(() => {})
  }, [])

  // Realtime settings write-through — optimistic, then reconciled with the
  // confirmed public config (main also rebuilds the orb backend on change,
  // and pushes the OTHER backend's config when it flips it off — the
  // optimistic mirror below just keeps both toggles from reading "on" for
  // the round-trip frame).
  const handleGrokToggle = useCallback((enabled: boolean) => {
    setGrokCfg((prev) => ({ ...prev, enabled }))
    if (enabled) setGeminiCfg((prev) => ({ ...prev, enabled: false }))
    void window.orb
      .setGrokConfig({ enabled })
      .then((res) => {
        if (res?.config) setGrokCfg(res.config)
      })
      .catch(() => {})
  }, [])

  const handleGrokVoiceChange = useCallback((voice: string) => {
    setGrokCfg((prev) => ({ ...prev, voice }))
    void window.orb
      .setGrokConfig({ voice })
      .then((res) => {
        if (res?.config) setGrokCfg(res.config)
      })
      .catch(() => {})
  }, [])

  const handleGrokKeySave = useCallback((apiKey: string) => {
    void window.orb
      .setGrokConfig({ apiKey })
      .then((res) => {
        if (res?.config) setGrokCfg(res.config)
      })
      .catch(() => {})
  }, [])

  // Connect-time setting (server VAD vs manual turns) — main rebuilds the
  // backend on flip, which also ends any live session; the next activation
  // opens in the new mode.
  const handleGrokPttToggle = useCallback((pushToTalk: boolean) => {
    setGrokCfg((prev) => ({ ...prev, pushToTalk }))
    void window.orb
      .setGrokConfig({ pushToTalk })
      .then((res) => {
        if (res?.config) setGrokCfg(res.config)
      })
      .catch(() => {})
  }, [])

  const handleGeminiToggle = useCallback((enabled: boolean) => {
    setGeminiCfg((prev) => ({ ...prev, enabled }))
    if (enabled) setGrokCfg((prev) => ({ ...prev, enabled: false }))
    void window.orb
      .setGeminiConfig({ enabled })
      .then((res) => {
        if (res?.config) setGeminiCfg(res.config)
      })
      .catch(() => {})
  }, [])

  const handleGeminiVoiceChange = useCallback((voice: string) => {
    setGeminiCfg((prev) => ({ ...prev, voice }))
    void window.orb
      .setGeminiConfig({ voice })
      .then((res) => {
        if (res?.config) setGeminiCfg(res.config)
      })
      .catch(() => {})
  }, [])

  const handleGeminiKeySave = useCallback((apiKey: string) => {
    void window.orb
      .setGeminiConfig({ apiKey })
      .then((res) => {
        if (res?.config) setGeminiCfg(res.config)
      })
      .catch(() => {})
  }, [])

  // Connect-time setting, same contract as the Grok one above.
  const handleGeminiPttToggle = useCallback((pushToTalk: boolean) => {
    setGeminiCfg((prev) => ({ ...prev, pushToTalk }))
    void window.orb
      .setGeminiConfig({ pushToTalk })
      .then((res) => {
        if (res?.config) setGeminiCfg(res.config)
      })
      .catch(() => {})
  }, [])

  // Live toggle — the main-side session reads this per frame tick, so it
  // takes effect mid-conversation without a reconnect.
  const handleGeminiScreenShareToggle = useCallback((screenShare: boolean) => {
    setGeminiCfg((prev) => ({ ...prev, screenShare }))
    void window.orb
      .setGeminiConfig({ screenShare })
      .then((res) => {
        if (res?.config) setGeminiCfg(res.config)
      })
      .catch(() => {})
  }, [])

  // ─── Agents-dock toggle (button beside the gear) ───
  // Visibility truth lives in main and is pushed on renderer-ready plus
  // every flip — from this button, the tray menu, Rax's own rax_set_dock
  // tool, or the auto-show on crew dispatch — so the notch toggle never
  // goes stale. Defaults false: the dock is hidden by default at start.
  const [dockVisible, setDockVisible] = useState(false)
  useEffect(() => {
    return window.orb.onDockVisible((payload) => {
      setDockVisible(payload.visible)
    })
  }, [])
  const handleDockToggle = useCallback(() => {
    window.orb
      .toggleDock()
      .then((res) => {
        if (res && typeof res.visible === 'boolean') setDockVisible(res.visible)
      })
      .catch(() => {})
  }, [])

  // ─── First-install tour ───
  // The scripted voice walkthrough (Onboarding.tsx) that plays once, the
  // first time the notch lands. While it runs: barge-in stands down, a notch
  // click dismisses the performance instead of opening the mic, and every
  // real use of the orb (⌥R, force-listen, a turn, an error, a dismissal)
  // aborts it — the persisted step resumes it on the next boot.
  const [tourActive, setTourActive] = useState(false)
  const tourActiveRef = useRef(false)
  const tourApiRef = useRef<TourApi | null>(null)
  const [tourSpotlight, setTourSpotlight] = useState<TourSpotlight>(null)
  // Cursor-over-notch, lifted from Notch so the tour's hover gate can await it.
  const [notchHovered, setNotchHovered] = useState(false)
  const handleTourActiveChange = useCallback((next: boolean) => {
    tourActiveRef.current = next
    setTourActive(next)
    if (!next) setTourSpotlight(null)
  }, [])

  // A turn starting (user or autonomous recap) reclaims the bar — the wave
  // and status word need the wings back.
  useEffect(() => {
    if (settingsOpen && state !== 'idle' && state !== 'error') setSettingsOpen(false)
  }, [settingsOpen, state])

  // The notch window is non-focusable by default — like the hardware notch,
  // it must never be "selected" or swallow keystrokes meant for another app.
  // The settings panel is the one exception: its API-key inputs need real
  // keyboard focus, so borrow focusability for exactly its lifetime.
  useEffect(() => {
    window.orb.setFocusable(settingsOpen)
  }, [settingsOpen])

  // Loudness timeline of the utterance currently playing through afplay,
  // pushed by main at playback start. A ref, not state — the waveform reads
  // it inside its own rAF; re-rendering React per utterance buys nothing.
  // Never cleared: a stale envelope self-disarms (its time window is in the
  // past, so the wave falls back to the quiet baseline until fresh levels
  // for the next utterance arrive).
  const ttsEnvelopeRef = useRef<TtsEnvelopeFrames | null>(null)
  useEffect(() => {
    return window.orb.onTtsLevels((payload) => {
      ttsEnvelopeRef.current = payload
    })
  }, [])

  // Recording refs
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderStreamRef = useRef<MediaStream | null>(null)
  const recorderChunksRef = useRef<Blob[]>([])
  const recorderMimeRef = useRef<string>('audio/webm;codecs=opus')
  const recordCancelledRef = useRef(false)
  const recordCappedRef = useRef(false)
  // Listening ended with zero detected speech — close with the gentle
  // mishear cue instead of transcribing 7s of room tone.
  const recordNoSpeechRef = useRef(false)
  // Re-entrancy guard: a second startRecording while getUserMedia is in
  // flight (double-click, hotkey + click race) would orphan the first
  // stream — mic indicator stuck on with no recorder attached to it.
  const recordStartingRef = useRef(false)
  // Recording-session generation. Bumped by everything that invalidates an
  // in-flight finalizeRecording (dismiss, reset, cancel-click, a new
  // recording). finalizeRecording snapshots it before its awaits and bails
  // when it moved — otherwise a dismissed orb still submits the turn and
  // thinks/speaks invisibly with the mic indicator on.
  const recordGenRef = useRef(0)
  // Hold-to-speak (Option+R) — when true, VAD silence/cap stops are
  // disabled; only the explicit ORB_HOLD_END from main ends the recording.
  const holdModeRef = useRef(false)
  // In-flight speculative transcription, started mid-silence-hold on the
  // audio captured so far. Nulled the instant any new voice lands (the
  // utterance grew past the snapshot) and on every new recording.
  // finalizeRecording adopts it when it survives; the promise resolves null
  // on any failure so finalize falls back to the full transcription path.
  const specRef = useRef<{
    promise: Promise<{ error: string | null; transcript: string | null } | null>
  } | null>(null)

  // VAD refs (during listening AND barge-in)
  const vadCtxRef = useRef<AudioContext | null>(null)
  const vadAnalyserRef = useRef<AnalyserNode | null>(null)
  const vadRafRef = useRef<number>(0)
  const vadStartedSpeakingAtRef = useRef<number | null>(null)
  const vadLastVoiceAtRef = useRef<number>(0)
  const vadStartedAtRef = useRef<number>(0)

  // Shared between the recorder/VAD and the island's waveform — opening a
  // separate getUserMedia inside the visualisation would cause two
  // "Microphone in use" indicators and could pick a different input device.
  const [vizAnalyser, setVizAnalyser] = useState<AnalyserNode | null>(null)

  // Barge-in refs
  const bargeStreamRef = useRef<MediaStream | null>(null)
  const bargeCtxRef = useRef<AudioContext | null>(null)
  const bargeAnalyserRef = useRef<AnalyserNode | null>(null)
  const bargeRafRef = useRef<number>(0)
  const bargeFirstVoiceAtRef = useRef<number | null>(null)

  // Orb response streaming refs.
  // Turn-generation gate: cancelGenRef bumps every time we wipe the TTS
  // queue (cancel-click, barge-in, errors, dismiss); activeTurnGenRef
  // snapshots it when a turn starts. A mismatch means the chunks now
  // arriving belong to a turn the user already killed — the CLI's graceful
  // interrupt can keep streaming for several seconds after cancelTurn, and
  // without this gate those stragglers re-queue TTS and the orb audibly
  // resurrects after the user clicked it quiet.
  const cancelGenRef = useRef(0)
  const activeTurnGenRef = useRef(0)
  // Snapshot of cancelGen taken right before submitTurn. orb_user_turn for a
  // submitted (non-autonomous) turn adopts the gate ONLY if cancelGen still
  // matches — a cancel landing in the submit window (after submitTurn, before
  // the session goes busy) no-ops in main, and unconditional adoption would
  // reopen the gate for the very turn the user just killed.
  const pendingSubmitGenRef = useRef(0)
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
  // Armed by task_complete; consumed by pumpTts when the last sentence
  // drains so the turn-done chime plays at the moment speech actually ends.
  // Cancels/errors disarm it so interruptions stay silent.
  const doneChimeArmedRef = useRef(false)
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
    // Never speak over an active recording: if the user is mid-utterance
    // (listening) or we're transcribing it, any queued sentence is a stale
    // straggler that slipped past a cancel — speaking it would talk over
    // the user's own turn. Idle stays allowed: autonomous recap turns
    // legitimately start speech from idle.
    if (stateRef.current === 'listening' || stateRef.current === 'transcribing') return
    while (ttsInFlightCountRef.current < TTS_INFLIGHT_MAX) {
      const next = ttsQueueRef.current.shift()
      if (!next) {
        // While the first-install tour runs, IT owns the voice state — its
        // lines go through ttsSpeak directly (not this queue), so the
        // every-done drain below would wash the tour's 'talking' back to
        // idle between lines and make the bar breathe mid-walkthrough.
        if (turnEndedRef.current && ttsInFlightCountRef.current === 0 && !tourActiveRef.current) {
          // Natural end of a spoken turn (not a cancel — those zero the
          // armed flag first): play the soft "finished" chime exactly once.
          if (doneChimeArmedRef.current && stateRef.current === 'talking') {
            doneChimeArmedRef.current = false
            playTurnDone()
          }
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
        for (const s of complete) {
          const clean = sanitizeForSpeech(s).trim()
          if (clean) ttsQueueRef.current.push(clean)
        }
      }
      pumpTts()
    },
    [pumpTts],
  )

  const flushPendingTts = useCallback(() => {
    const tail = sanitizeForSpeech(ttsBufferRef.current).trim()
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
    doneChimeArmedRef.current = false
    // The cancelled turn is over as far as the renderer is concerned —
    // without this a gated-out task_complete would leave turnEnded false.
    turnEndedRef.current = true
    cancelGenRef.current++
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

  // ─── Backend events ───
  useEffect(() => {
    const off = window.orb.onEvent((rawEvent) => {
      // Realtime mode (Grok/Gemini): the session drives audio + states
      // through its own ORB_*_EVENT channel; the normalized stream below
      // still flows (voice tab, pill) but must not touch the Kokoro TTS
      // pipeline — a text_chunk queued here would have the local voice talk
      // over the realtime one, and orb_user_turn's cancel-gate could kill
      // live realtime responses.
      if (rtActiveRef.current) return
      const evt = rawEvent as { type: string; [k: string]: unknown }
      switch (evt.type) {
        case 'orb_user_turn': {
          // A real turn (user or autonomous recap) takes the stage — the
          // tour yields and resumes from its persisted step next boot.
          if (tourActiveRef.current) tourApiRef.current?.abort()
          // Adopt the current cancel generation — chunks from any turn the
          // user killed before this one stay gated out below. For submitted
          // turns, a cancelGen that moved past the pre-submit snapshot means
          // the user cancelled inside the submit window, where main's
          // cancelTurn no-ops against a not-yet-busy session: keep the gate
          // closed and re-issue the cancel now that the turn really exists.
          const autonomous = Boolean((evt as { autonomous?: boolean }).autonomous)
          if (!autonomous && cancelGenRef.current !== pendingSubmitGenRef.current) {
            void window.orb.cancelTurn()
            break
          }
          activeTurnGenRef.current = cancelGenRef.current
          turnEndedRef.current = false
          firstChunkPendingRef.current = true
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
          // Stale turn (cancelled via click / barge-in / dismiss) — the CLI's
          // graceful interrupt keeps streaming for a few seconds; drop it.
          if (cancelGenRef.current !== activeTurnGenRef.current) break
          const text = String((evt as { text?: string }).text || '')
          if (!text) break
          appendTtsText(text)
          break
        }
        case 'tool_call': {
          if (cancelGenRef.current !== activeTurnGenRef.current) break
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
          setCurrentTool(friendly)
          break
        }
        case 'task_complete': {
          if (cancelGenRef.current !== activeTurnGenRef.current) break
          turnEndedRef.current = true
          // Arm the turn-done chime — pumpTts plays it when the last queued
          // sentence drains, i.e. when speech audibly ends rather than now.
          doneChimeArmedRef.current = true
          flushPendingTts()
          // Only transition to idle once main is fully drained — both the
          // local queue AND main's pipeline (current + prefetched) need to
          // be empty, otherwise the orb would flash idle while there's still
          // unspoken audio in flight.
          if (ttsInFlightCountRef.current === 0 && ttsQueueRef.current.length === 0) {
            doneChimeArmedRef.current = false
            setState((prev) => (prev === 'thinking' || prev === 'talking' ? 'idle' : prev))
          }
          break
        }
        case 'error': {
          if (tourActiveRef.current) tourApiRef.current?.abort()
          const message = String((evt as { message?: string }).message || 'Unknown error')
          setErrorText(message)
          turnEndedRef.current = true
          // A session error can land mid-recording (e.g. the backend dies
          // while the user is talking) — tear the mic down too, or the
          // recorder keeps running under the red bar and the retry click
          // bounces off the re-entrancy guard.
          if (recorderRef.current && recorderRef.current.state === 'recording') {
            recordGenRef.current++
            stopRecording(true)
          }
          // Silence any in-flight / queued TTS so the orb stops mid-thought
          // instead of finishing a sentence after a session error.
          cancelAllSpeech()
          playError()
          setState('error')
          break
        }
        case 'orb_session_dead': {
          if (tourActiveRef.current) tourApiRef.current?.abort()
          setErrorText('Voice agent session ended. Click the orb to retry.')
          turnEndedRef.current = true
          if (recorderRef.current && recorderRef.current.state === 'recording') {
            recordGenRef.current++
            stopRecording(true)
          }
          cancelAllSpeech()
          playError()
          setState('error')
          break
        }
      }
    })

    const offForceListen = window.orb.onForceListen(() => {
      // Mid-tour push-to-talk is the user taking the wheel — stop the
      // performance and honour the gesture below.
      if (tourActiveRef.current) tourApiRef.current?.abort()
      // Realtime mode: the hotkey opens a continuous session; once one is
      // live the open mic + server VAD already cover "listen to me now".
      if (
        (grokCfgRef.current.enabled && grokCfgRef.current.hasKey) ||
        (geminiCfgRef.current.enabled && geminiCfgRef.current.hasKey)
      ) {
        if (!rtActiveRef.current && (stateRef.current === 'idle' || stateRef.current === 'error')) {
          void startRealtimeSession()
        }
        return
      }
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
      // The tour literally teaches ⌥R. If it's currently waiting on that very
      // gesture, let it consume the press (advance the step) and SUPPRESS the
      // real recording — otherwise the tour would derail into a live turn.
      // A press during any other tour step means the user is taking over, so
      // abort and fall through to the normal hold behavior.
      if (tourActiveRef.current) {
        if (tourApiRef.current?.notifyHold()) return
        tourApiRef.current?.abort()
      }
      // Realtime mode. Open mic: hold-to-speak maps to "make sure a session
      // is live" — turn boundaries belong to the server VAD. Push-to-talk:
      // the hold edge IS the turn boundary — forward it to the live client
      // (setHold no-ops in open-mic sessions).
      if (
        (grokCfgRef.current.enabled && grokCfgRef.current.hasKey) ||
        (geminiCfgRef.current.enabled && geminiCfgRef.current.hasKey)
      ) {
        rtHoldDownRef.current = true
        if (!rtActiveRef.current && (stateRef.current === 'idle' || stateRef.current === 'error')) {
          void startRealtimeSession()
        } else {
          rtClientRef.current?.setHold(true)
        }
        return
      }
      const s = stateRef.current
      if (s === 'idle' || s === 'error') {
        holdModeRef.current = true
        void startRecording()
      } else if (s === 'thinking' || s === 'talking') {
        // Barge-in into hold mode: cancel current TTS / turn, then begin
        // a new hold-mode recording. Mirrors triggerBargeIn but with the
        // holdModeRef flag set first so VAD won't auto-stop us. Quiet start —
        // the barge tick is the acknowledgement; stacking the listen-start
        // pair on top reads as two different cues for one gesture.
        playBargeIn()
        stopBargeIn()
        cancelAllSpeech()
        void window.orb.cancelTurn()
        holdModeRef.current = true
        void startRecording({ quiet: true })
      } else if (s === 'listening') {
        // Already recording (e.g. user clicked then pressed Option+R) —
        // promote to hold mode so VAD silence won't end it early.
        holdModeRef.current = true
      }
      // 'transcribing' — too late to change duration, drop.
    })

    const offHoldEnd = window.orb.onHoldEnd(() => {
      rtHoldDownRef.current = false
      // Realtime mode. Open mic: key release doesn't end anything — server
      // VAD owns turns (setHold no-ops). Push-to-talk: release commits the
      // turn and the orb answers.
      if (rtActiveRef.current) {
        rtClientRef.current?.setHold(false)
        return
      }
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
      // A dismissal mid-tour parks the performance (no done flag) — the
      // persisted step resumes it on the next boot's entrance.
      if (tourActiveRef.current) tourApiRef.current?.abort()
      rtHoldDownRef.current = false
      // Window hidden by host — clean up everything mid-flight so we don't
      // keep recording / speaking / billing tokens. The generation bump
      // invalidates any finalizeRecording that already passed the recorder
      // stage (state === 'transcribing'): without it, the transcription
      // resolving seconds from now would submit the turn anyway and the
      // hidden orb would think and speak invisibly.
      recordGenRef.current++
      stopRecording(true)
      cancelAllSpeech()
      stopBargeIn()
      // A hidden bar must never keep a live (billed) realtime session open.
      endRealtimeSession({ quiet: true })
      // A hidden bar must not re-summon with the settings panel hanging open.
      setSettingsOpen(false)
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
  }, [appendTtsText, flushPendingTts, cancelAllSpeech])

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
    // pumpTts refuses to run during listening/transcribing; anything queued
    // in that window (an autonomous recap streaming while the user talks)
    // would otherwise strand in ttsQueueRef until a stale replay. Resume the
    // pump as soon as the gate lifts.
    if (state !== 'listening' && state !== 'transcribing' && ttsQueueRef.current.length > 0) {
      pumpTts()
    }
  }, [state, pumpTts])

  // ─── Click-through plumbing ───
  // The window is a wide transparent strip; only the notch itself should grab
  // the pointer. We measure the live bounding box of `.notch-shell` on every
  // mousemove (forwarded to us even while click-through) and capture when the
  // cursor is inside it — including the few px of growth as the island opens,
  // so the hover→expand→hover handoff never drops. A small pad keeps capture
  // from chattering right at the rounded edge.
  const isCapturingRef = useRef(false)
  useEffect(() => {
    const HIT_PAD = 6
    const updateCapture = (clientX: number, clientY: number) => {
      // The error toast is interactive too (its dismiss ×) — without it in
      // the hit test the window stays click-through over the toast and the
      // button can never be pressed. Same for the tour card (Skip button).
      const targets = document.querySelectorAll('.notch-shell, .orb-error, .tour-card')
      let inside = false
      for (const el of targets) {
        const rect = el.getBoundingClientRect()
        if (
          clientX >= rect.left - HIT_PAD &&
          clientX <= rect.right + HIT_PAD &&
          clientY >= rect.top - HIT_PAD &&
          clientY <= rect.bottom + HIT_PAD
        ) {
          inside = true
          break
        }
      }
      if (inside && !isCapturingRef.current) {
        isCapturingRef.current = true
        window.orb.setIgnoreMouseEvents(false)
      } else if (!inside && isCapturingRef.current) {
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
    } else if (recordNoSpeechRef.current) {
      // Cancelled because nothing was said — "didn't catch that", not silence.
      playMishear()
    }
    recordCappedRef.current = false
    recordNoSpeechRef.current = false
    holdModeRef.current = false

    recordCancelledRef.current = cancel
    const recorder = recorderRef.current
    if (recorder && recorder.state === 'recording') {
      try { recorder.stop() } catch {}
    } else {
      recorderStreamRef.current?.getTracks().forEach((t) => t.stop())
      recorderStreamRef.current = null
      // Cancels triggered while the error state owns the bar must not wash
      // it back to idle.
      if (cancel) setState((prev) => (prev === 'error' ? prev : 'idle'))
    }
  }, [])

  // Start transcribing the audio captured SO FAR, while the recorder keeps
  // rolling through the tail of the silence hold. requestData() flushes the
  // recorder's buffer; the property handler (ondataavailable) pushes the
  // flushed chunk into recorderChunksRef first, then our one-shot listener
  // snapshots the array. The snapshot is a valid standalone webm — chunk 0
  // carries the container header and MediaRecorder streams are decodable at
  // any chunk boundary.
  const startSpeculativeTranscription = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== 'recording') return
    const gen = recordGenRef.current
    const onData = () => {
      recorder.removeEventListener('dataavailable', onData)
      if (gen !== recordGenRef.current || recorder !== recorderRef.current) return
      const snapshot = recorderChunksRef.current.slice()
      if (!snapshot.length) return
      const blob = new Blob(snapshot, { type: recorderMimeRef.current })
      const mySpec = {
        // Resolve null on ANY failure (partial-webm decode hiccup, whisper
        // error) — finalizeRecording then just runs the full path it would
        // have run anyway. Speculation can make things faster, never break.
        promise: blobToWavBase64(blob)
          .then((wav) => window.orb.transcribeAudio(wav))
          .catch(() => null),
      }
      specRef.current = mySpec
      // Semantic endpointing: if the transcript lands while we're STILL in
      // the silence hold, the user hasn't resumed, and the sentence reads
      // complete (terminal punctuation), end the turn right now instead of
      // waiting out the rest of the hold. Identity check against specRef
      // guarantees no voice arrived after the snapshot; everything else is
      // the exact stop the hold would have triggered moments later.
      void mySpec.promise.then((result) => {
        if (!result || result.error) return
        if (specRef.current !== mySpec) return
        if (gen !== recordGenRef.current) return
        if (holdModeRef.current) return
        if (recorderRef.current !== recorder || recorder.state !== 'recording') return
        const t = (result.transcript || '').trim()
        if (/[.!?…]["')\]]*$/.test(t)) stopRecording(false)
      })
    }
    recorder.addEventListener('dataavailable', onData)
    try {
      recorder.requestData()
    } catch {
      recorder.removeEventListener('dataavailable', onData)
    }
  }, [stopRecording])

  const finalizeRecording = useCallback(async () => {
    // Anything that invalidates this turn while we await (dismiss, reset,
    // cancel-click, a fresh recording) bumps the generation; bail without
    // touching state — the bumper already decided what the UI shows.
    const gen = recordGenRef.current
    setState('transcribing')
    // Adopt the speculative transcription if one survived to this point —
    // no voice landed after its snapshot, so the only audio it's missing is
    // the silence hold. Usually it's already resolved, collapsing the
    // transcribing phase to ~0ms.
    const spec = specRef.current
    specRef.current = null
    try {
      let result: { error: string | null; transcript: string | null } | null = null
      if (spec) {
        result = await spec.promise
        if (gen !== recordGenRef.current) return
      }
      if (!result) {
        const chunks = recorderChunksRef.current
        if (!chunks.length) {
          setState('idle')
          return
        }
        const blob = new Blob(chunks, { type: recorderMimeRef.current })
        const wavBase64 = await blobToWavBase64(blob)
        if (gen !== recordGenRef.current) return
        result = await window.orb.transcribeAudio(wavBase64)
        if (gen !== recordGenRef.current) return
      }
      if (result.error) {
        playError()
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
      // Gate snapshot for the submit window — see pendingSubmitGenRef.
      pendingSubmitGenRef.current = cancelGenRef.current
      const submit = await window.orb.submitTurn(text)
      if (gen !== recordGenRef.current) return
      if (!submit.ok) {
        playError()
        setErrorText(submit.error || 'Failed to submit turn')
        setState('error')
      }
    } catch (err) {
      if (gen !== recordGenRef.current) return
      const e = err as Error
      if (/no voice detected/i.test(e.message || '')) {
        // Same user behavior as an empty transcript — the room was quiet.
        // The gentle mishear, not the red error state.
        playMishear()
        setState('idle')
        return
      }
      playError()
      setErrorText(e.message || 'Voice failed')
      setState('error')
    }
  }, [])

  const startRecording = useCallback(async (opts?: { quiet?: boolean; handoff?: BargeHandoff }) => {
    // Re-entrancy guard: a second call while getUserMedia is still in
    // flight (double-click, hotkey+click race) would orphan the first
    // stream — mic indicator stuck on with nothing attached to it.
    if (recordStartingRef.current) return
    if (recorderRef.current && recorderRef.current.state === 'recording') return
    recordStartingRef.current = true
    // Invalidate any finalizeRecording still awaiting from a prior session,
    // and keep our own generation so a dismiss/reset arriving while we await
    // getUserMedia below invalidates THIS start too.
    recordGenRef.current++
    const myGen = recordGenRef.current
    setErrorText(null)
    cancelAllSpeech()
    stopBargeIn()
    const handoff = opts?.handoff ?? null
    // On barge-in handoff the pre-roll chunks already hold the speech onset.
    recorderChunksRef.current = handoff ? handoff.chunks : []
    recordCancelledRef.current = false
    recordNoSpeechRef.current = false
    // A speculation from a previous session must never leak into this one.
    specRef.current = null

    let stream: MediaStream
    if (handoff) {
      stream = handoff.stream
      // The barge mic runs AGC-off so speaker bleed can't pump toward its
      // threshold; recordings want the tuned AGC-on capture Whisper is used
      // to. Best-effort — not every device accepts live re-constraining.
      for (const t of stream.getAudioTracks()) {
        t.applyConstraints({ autoGainControl: true }).catch(() => {})
      }
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (err) {
        recordStartingRef.current = false
        const e = err as Error
        const denied = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
        playError()
        setErrorText(denied ? 'Microphone permission denied.' : `Mic error: ${e.message}`)
        setState('error')
        return
      }
    }
    // Dismiss / reset / a competing start fired while getUserMedia was in
    // flight — this session is already dead. Release the mic before the OS
    // indicator ever reads as "live with no UI".
    if (myGen !== recordGenRef.current) {
      stream.getTracks().forEach((t) => t.stop())
      recordStartingRef.current = false
      return
    }

    // Definite-assignment assertion: the catch below returns, so any code
    // past the try block has analyser assigned.
    let analyser!: AnalyserNode
    try {
      recorderStreamRef.current = stream

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      recorderMimeRef.current = mime

      // Adopt the barge pre-roll recorder when it's already rolling — a fresh
      // recorder on the same stream would lose everything captured during the
      // barge confirmation window (the first words of the interruption).
      const recorder =
        handoff?.recorder && handoff.recorder.state === 'recording'
          ? handoff.recorder
          : new MediaRecorder(stream, { mimeType: mime })
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recorderChunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        recorderStreamRef.current = null
        if (recordCancelledRef.current) {
          // A cancel triggered by an error event must not wash the red
          // state back to idle.
          setState((prev) => (prev === 'error' ? prev : 'idle'))
          return
        }
        void finalizeRecording()
      }
      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop())
        recorderStreamRef.current = null
        playError()
        setErrorText('Recording failed.')
        setState('error')
      }
      recorderRef.current = recorder
      if (recorder.state !== 'recording') recorder.start()

      // VAD setup. On handoff, reuse the barge pipeline's analyser — its
      // context is already warm on this very stream.
      let ctx: AudioContext
      if (handoff?.ctx && handoff.analyser && handoff.ctx.state !== 'closed') {
        ctx = handoff.ctx
        analyser = handoff.analyser
      } else {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        ctx = new Ctor()
        analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.6
        ctx.createMediaStreamSource(stream).connect(analyser)
      }
      vadCtxRef.current = ctx
      vadAnalyserRef.current = analyser
    } catch {
      // Recorder/AudioContext construction failed — realistic when the
      // device vanished between acquire and start (e.g. USB mic unplugged
      // mid barge-handoff). Without this, recordStartingRef would stick
      // true forever and the dead stream would hold the mic indicator on.
      stream.getTracks().forEach((t) => t.stop())
      recorderStreamRef.current = null
      recorderRef.current = null
      recordStartingRef.current = false
      playError()
      setErrorText('Recording failed.')
      setState('error')
      return
    }
    setState('listening')
    // Quiet starts: barge-in already acknowledged with its own tick —
    // stacking the listen-start pair on top reads as two cues for one act.
    if (!opts?.quiet) playListenStart()
    // Share the same analyser with the island's waveform — opening a second
    // getUserMedia just for the visualisation would double the OS mic
    // indicator and could bind to a different input device.
    setVizAnalyser(analyser)
    vadStartedAtRef.current = performance.now()
    // On handoff the user is ALREADY mid-word: credit the real onset so
    // MIN_SPEECH_MS counts from actual speech, not from pipeline swap time.
    vadStartedSpeakingAtRef.current = handoff ? (handoff.voiceAt ?? performance.now()) : null
    vadLastVoiceAtRef.current = handoff ? performance.now() : 0
    recordCappedRef.current = false
    recordStartingRef.current = false

    // Adaptive VAD: sample ~200ms of ambient and lift the speech/silence
    // thresholds by the measured floor, so the detector still fires in
    // cafés / open offices instead of treating background chatter as
    // speech. The constants stay as floors — quiet rooms keep the original
    // (more sensitive) defaults. The floor is a low percentile, not the
    // mean, so a user who starts talking instantly doesn't poison it; two
    // consecutive loud frames abort calibration and count as speech onset.
    // Skipped entirely on handoff — the user is already speaking.
    const CALIBRATION_MS = 200
    let calibrating = !handoff
    const calibrationStartedAt = performance.now()
    const calibrationFrames: number[] = []
    let calibrationLoudRun = 0
    let speechThreshold = VAD_SPEECH_RMS
    let silenceThreshold = VAD_SILENCE_RMS
    const finalizeCalibration = (now: number) => {
      if (calibrationFrames.length >= 3) {
        const sorted = [...calibrationFrames].sort((a, b) => a - b)
        const floor = sorted[Math.floor(sorted.length * 0.2)]
        speechThreshold = Math.max(VAD_SPEECH_RMS, floor + 0.02)
        silenceThreshold = Math.max(VAD_SILENCE_RMS, floor + 0.005)
      }
      calibrating = false
      // Reset so the calibration window doesn't eat into MAX_RECORD_MS.
      vadStartedAtRef.current = now
    }

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
        if (rms > VAD_SPEECH_RMS) {
          calibrationLoudRun += 1
        } else {
          calibrationLoudRun = 0
          calibrationFrames.push(rms)
        }
        if (calibrationLoudRun >= 2) {
          // The user started talking inside the calibration window —
          // finalize from the quiet frames only and fall through so this
          // very frame registers as speech onset.
          finalizeCalibration(now)
        } else {
          if (now - calibrationStartedAt >= CALIBRATION_MS) finalizeCalibration(now)
          vadRafRef.current = requestAnimationFrame(tick)
          return
        }
      }
      const sinceStart = now - vadStartedAtRef.current
      if (rms > speechThreshold) {
        if (vadStartedSpeakingAtRef.current === null) {
          vadStartedSpeakingAtRef.current = now
        }
        vadLastVoiceAtRef.current = now
        // New voice — any in-flight speculative transcription is now a
        // prefix of a longer utterance. Drop it; a fresh one starts at the
        // next candidate silence.
        specRef.current = null
      }
      // Nothing said: close quietly with the mishear cue instead of trapping
      // the user until the 30s cap (which would then read as "talked too
      // long" — wrong for an accidental activation).
      if (
        vadStartedSpeakingAtRef.current === null &&
        sinceStart > NO_SPEECH_TIMEOUT_MS &&
        !holdModeRef.current
      ) {
        recordNoSpeechRef.current = true
        stopRecording(true)
        return
      }
      const heardEnough =
        vadStartedSpeakingAtRef.current !== null &&
        now - vadStartedSpeakingAtRef.current > MIN_SPEECH_MS
      const silenceMs = vadLastVoiceAtRef.current ? now - vadLastVoiceAtRef.current : 0
      // Speculative transcription: a few hundred ms into a candidate
      // silence, start Whisper on the audio-so-far so it runs DURING the
      // rest of the hold instead of after it. Skipped in hold mode — the
      // user controls duration there and mid-utterance pauses are routine,
      // so speculation would mostly be wasted runs.
      if (
        heardEnough &&
        !specRef.current &&
        !holdModeRef.current &&
        silenceMs > SPECULATIVE_TRANSCRIBE_MS &&
        rms < silenceThreshold
      ) {
        startSpeculativeTranscription()
      }
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
  }, [cancelAllSpeech, finalizeRecording, stopRecording, startSpeculativeTranscription])

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

  const triggerBargeIn = useCallback((handoff?: BargeHandoff) => {
    playBargeIn()
    stopBargeIn()
    cancelAllSpeech()
    void window.orb.cancelTurn()
    // Quiet: the barge tick above is the acknowledgement.
    void startRecording({ quiet: true, handoff })
  }, [stopBargeIn, cancelAllSpeech, startRecording])

  // ─── Realtime session lifecycle (Grok / Gemini) ───
  // One continuous conversation per activation: click opens it, click again
  // (or Esc / dismiss / idle timeout / socket loss) closes it. While active,
  // the RealtimeVoiceClient owns mic + playback and drives the same visual
  // states the local pipeline uses; everything Kokoro/whisper stays cold.
  // The backend is whichever settings toggle is on (mutually exclusive).

  const endRealtimeSession = useCallback((opts?: { quiet?: boolean }) => {
    const client = rtClientRef.current
    if (!client && !rtActiveRef.current) return
    rtClientRef.current = null
    client?.stop()
    rtActiveRef.current = false
    setRtActive(false)
    setVizAnalyser(null)
    setCurrentTool(null)
    if (!opts?.quiet) playListenEnd()
    setState((prev) => (prev === 'error' ? prev : 'idle'))
  }, [])

  const startRealtimeSession = useCallback(async () => {
    if (rtClientRef.current) return
    setErrorText(null)
    // Silence any tail from the default pipeline before going live.
    cancelAllSpeech()
    stopBargeIn()
    const backend = geminiCfgRef.current.enabled ? 'gemini' : 'grok'
    const label = backend === 'gemini' ? 'Gemini' : 'Grok'
    const keyName = backend === 'gemini' ? 'Google AI' : 'xAI'
    const cfg = backend === 'gemini' ? geminiCfgRef.current : grokCfgRef.current
    if (!cfg.hasKey) {
      playError()
      setErrorText(`${label} voice needs ${backend === 'gemini' ? 'a' : 'an'} ${keyName} API key — add one in the notch voice settings (gear).`)
      setState('error')
      return
    }
    const client = new RealtimeVoiceClient(
      {
        onStateChange: (s) => {
          if (rtClientRef.current === client) setState(s)
        },
        onAnalyser: (a) => {
          if (rtClientRef.current === client || a === null) setVizAnalyser(a)
        },
        onToolCall: (name) => {
          if (rtClientRef.current !== client) return
          setCurrentTool(name.replace(/^rax_/, '').replace(/_/g, ' ').toLowerCase())
        },
        onInterrupted: () => playBargeIn(),
        onTurnDone: () => {
          if (rtClientRef.current === client) playTurnDone()
        },
        onError: (message) => {
          if (rtClientRef.current === client) setErrorText(message)
        },
        onClosed: (expected, reason) => {
          if (rtClientRef.current !== client) return
          rtClientRef.current = null
          rtActiveRef.current = false
          setRtActive(false)
          setVizAnalyser(null)
          setCurrentTool(null)
          if (expected) {
            playListenEnd()
            setState((prev) => (prev === 'error' ? prev : 'idle'))
          } else {
            playError()
            setErrorText(
              reason && /key|auth|401|403/i.test(reason)
                ? `${label} rejected the connection — check your ${keyName} API key in the notch settings.`
                : `${label} voice session ended unexpectedly. Click to reconnect.`,
            )
            setState('error')
          }
        },
      },
      ttsEnvelopeRef,
      backend === 'gemini' ? GEMINI_TRANSPORT : GROK_TRANSPORT,
      { pushToTalk: cfg.pushToTalk === true },
    )
    rtClientRef.current = client
    rtActiveRef.current = true
    setRtActive(true)
    // Instant feedback — the mic analyser animates the wave as soon as
    // getUserMedia lands; the listen-start earcon marks "actually live".
    setState('listening')
    try {
      await client.start()
      if (rtClientRef.current !== client) return
      playListenStart()
      if (cfg.pushToTalk === true) {
        if (rtHoldDownRef.current) {
          // The hold that summoned this session is still physically down —
          // begin the turn now that the socket is live (speech during the
          // connect window is lost; the listen-start earcon marks "go").
          client.setHold(true)
        } else {
          // Key released (or never down — click activation) — rest deaf
          // until the next hold instead of camping in 'listening'.
          setState('idle')
        }
      }
    } catch (err) {
      if (rtClientRef.current !== client) return
      rtClientRef.current = null
      rtActiveRef.current = false
      setRtActive(false)
      setVizAnalyser(null)
      const message = (err as Error).message
      if (message !== 'cancelled') {
        playError()
        setErrorText(message)
        setState('error')
      } else {
        setState((prev) => (prev === 'error' ? prev : 'idle'))
      }
    }
  }, [cancelAllSpeech, stopBargeIn])

  // Realtime events (audio deltas, VAD signals, tool calls) → the live
  // client. Routed through the ref so the subscription never re-binds. Both
  // channels feed the same handler: only one backend ever has a live session
  // (the toggles are exclusive), so the idle channel simply stays silent.
  useEffect(() => {
    const offGrok = window.orb.onGrokEvent((evt) => {
      rtClientRef.current?.handleEvent(evt as { type: string; [k: string]: unknown })
    })
    const offGemini = window.orb.onGeminiEvent((evt) => {
      rtClientRef.current?.handleEvent(evt as { type: string; [k: string]: unknown })
    })
    return () => {
      offGrok()
      offGemini()
    }
  }, [])

  // Stable boolean so the thinking → talking transition doesn't tear down
  // and rebuild the mic mid-turn (would briefly disable barge-in).
  // 'transcribing' is included as PREWARM only — getUserMedia + the audio
  // graph spin up while Whisper runs, so the detector is already live the
  // instant thinking begins (previously that spin-up left the first
  // ~100-300ms of thinking uncovered). The trigger itself stays gated to
  // thinking/talking below. Realtime mode opts out entirely: its mic is
  // already open and barge-in belongs to the server VAD — a second local
  // getUserMedia would only double the mic indicator and fight over the
  // device.
  // The tour opts out too: its scripted speech holds 'talking' for long
  // stretches and room noise must not cancel the walkthrough mid-line.
  const bargeInActive =
    !rtActive &&
    !tourActive &&
    (state === 'talking' || state === 'thinking' || state === 'transcribing')
  useEffect(() => {
    if (!bargeInActive) {
      stopBargeIn()
      return
    }
    let cancelled = false
    // Pre-roll recorder: starts on the FIRST frame that crosses the barge
    // threshold, so when the 220ms confirmation passes, everything the user
    // said is already captured and handed to the recording session. webm
    // chunks are only decodable from the header chunk, so false alarms
    // discard the whole recorder rather than trimming a ring buffer.
    let preRec: MediaRecorder | null = null
    let preChunks: Blob[] = []
    const discardPreRoll = () => {
      if (preRec) {
        try { if (preRec.state !== 'inactive') preRec.stop() } catch {}
        preRec = null
      }
      preChunks = []
    }
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
          // Prewarm-only while transcribing: keep the graph hot but never
          // arm on trailing speech from the utterance we just captured.
          const canTrigger = stateRef.current === 'thinking' || stateRef.current === 'talking'
          if (!canTrigger) {
            bargeFirstVoiceAtRef.current = null
            discardPreRoll()
            bargeRafRef.current = requestAnimationFrame(tick)
            return
          }
          if (rms > BARGE_IN_RMS) {
            if (bargeFirstVoiceAtRef.current === null) {
              bargeFirstVoiceAtRef.current = now
              // Voice onset — start capturing immediately so the words said
              // during the confirmation window aren't lost. Each recorder
              // gets its OWN chunk array: a discarded false-alarm recorder
              // delivers its final dataavailable asynchronously, and letting
              // it append to a shared array would splice a stale webm header
              // into the next pre-roll.
              try {
                const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                  ? 'audio/webm;codecs=opus'
                  : 'audio/webm'
                preRec = new MediaRecorder(stream, { mimeType: mime })
                const myChunks: Blob[] = []
                preChunks = myChunks
                preRec.ondataavailable = (e) => {
                  if (e.data.size > 0) myChunks.push(e.data)
                }
                preRec.start(100)
              } catch {
                preRec = null
              }
            }
            if (now - bargeFirstVoiceAtRef.current >= BARGE_IN_MIN_MS) {
              // Confirmed. Transfer ownership of the whole pipeline to the
              // recording session BEFORE any stopBargeIn can run (it's
              // called inside triggerBargeIn → startRecording and again by
              // this effect's cleanup when state flips to 'listening') —
              // otherwise the handed-off tracks get stopped mid-recording.
              const handoff: BargeHandoff = {
                stream,
                recorder: preRec,
                chunks: preChunks,
                ctx: bargeCtxRef.current,
                analyser: bargeAnalyserRef.current,
                voiceAt: bargeFirstVoiceAtRef.current,
              }
              preRec = null
              preChunks = []
              bargeStreamRef.current = null
              bargeCtxRef.current = null
              bargeAnalyserRef.current = null
              triggerBargeIn(handoff)
              return
            }
          } else {
            bargeFirstVoiceAtRef.current = null
            // False alarm (cough, door slam) — drop whatever we grabbed.
            discardPreRoll()
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
      discardPreRoll()
      stopBargeIn()
    }
  }, [bargeInActive, stopBargeIn, triggerBargeIn])

  // ─── Click + keyboard ───

  const onOrbClick = useCallback(() => {
    // Mid-tour, a click on the bar means "okay, got it" — dismiss the
    // performance quietly. The next click talks as usual.
    if (tourActiveRef.current) {
      tourApiRef.current?.abort()
      return
    }
    // Realtime mode (Grok/Gemini): the notch is a session toggle — open a
    // continuous realtime conversation, or close the one that's live.
    // Mid-response interruption is by voice (server VAD barge-in), so every
    // click during a session means "we're done".
    if (grokCfgRef.current.enabled || geminiCfgRef.current.enabled) {
      if (rtActiveRef.current) {
        endRealtimeSession()
      } else if (state === 'idle' || state === 'error') {
        void startRealtimeSession()
      } else {
        // Busy without an active client shouldn't happen in realtime mode —
        // degrade to a clean park.
        endRealtimeSession()
      }
      return
    }
    if (state === 'idle' || state === 'error') {
      void startRecording()
    } else if (state === 'listening') {
      stopRecording(false)
    } else if (state === 'transcribing') {
      // Previously the one state where a tap was silently swallowed. Click
      // means "stop what you're doing" in every other busy state — honor it
      // here too: invalidate the in-flight transcription and park.
      recordGenRef.current++
      playBargeIn()
      setState('idle')
    } else if (state === 'talking' || state === 'thinking') {
      // One meaning across both busy states: stop this turn. cancelTurn is
      // required even while talking — the turn is usually still streaming,
      // and without it the next text_chunk re-queues TTS and the orb
      // audibly resurrects right after the user clicked it quiet.
      void window.orb.cancelTurn()
      cancelAllSpeech()
      setState('idle')
    }
  }, [state, startRecording, stopRecording, cancelAllSpeech])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // NOTE: no Space-to-talk here. The window is non-focusable outside the
      // settings panel, and an accidentally-key notch turning Space into
      // push-to-talk while the user typed elsewhere was a real failure mode.
      // Voice is summoned by click or the global shortcuts only.
      if (e.key === 'Escape') {
        // First Esc closes the settings panel; the next one hides the orb.
        if (settingsOpen) {
          setSettingsOpen(false)
          return
        }
        cancelAllSpeech()
        endRealtimeSession({ quiet: true })
        const rtSelected = grokCfgRef.current.enabled || geminiCfgRef.current.enabled
        if (state === 'listening' && !rtSelected) stopRecording(true)
        if (state === 'thinking' && !rtSelected) void window.orb.cancelTurn()
        void window.orb.hide()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault()
        recordGenRef.current++
        endRealtimeSession({ quiet: true })
        void window.orb.resetSession()
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
      if (e.code === 'KeyR' || e.code === 'AltLeft' || e.code === 'AltRight') {
        // Realtime push-to-talk: same missed-release safety net — the
        // client-side setHold is idempotent with main's ORB_HOLD_END.
        if (rtHoldDownRef.current && rtActiveRef.current) {
          rtHoldDownRef.current = false
          rtClientRef.current?.setHold(false)
          return
        }
        if (!holdModeRef.current) return
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
  }, [state, settingsOpen, stopRecording, cancelAllSpeech, endRealtimeSession])

  useEffect(
    () => () => {
      stopRecording(true)
      cancelAllSpeech()
      stopBargeIn()
      endRealtimeSession({ quiet: true })
    },
    [stopRecording, cancelAllSpeech, stopBargeIn, endRealtimeSession],
  )

  // ─── Live caption fed into the island's left wing ───
  // Quiet metadata, not a headline: just the tool name with a trailing
  // ellipsis while thinking ("Screenshot…"). Streamed response text lives in
  // the bottom caption pill; error detail lives in the toast below the bar.
  const caption =
    state === 'thinking' && currentTool
      ? `${currentTool.charAt(0).toUpperCase()}${currentTool.slice(1)}…`
      : null

  return (
    <div className="orb-page">
      {errorText && (
        <div className={`orb-overlay orb-error${settingsOpen ? ' below-settings' : ''}`} role="alert">
          <span>{errorText}</span>
          <button type="button" onClick={() => setErrorText(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <OnboardingTour
        entrance={introEntrance}
        voiceState={state}
        settingsOpen={settingsOpen}
        rtActive={rtActive}
        hovered={notchHovered}
        grokHasKey={grokCfg.hasKey}
        geminiHasKey={geminiCfg.hasKey}
        setVoiceState={setState}
        setSpotlight={setTourSpotlight}
        onActiveChange={handleTourActiveChange}
        apiRef={tourApiRef}
      />

      <Notch
        state={state}
        caption={caption}
        analyser={vizAnalyser}
        ttsEnvelope={ttsEnvelopeRef}
        flashAt={flashAt}
        notched={notched}
        mascotColor={mascotColor}
        onActivate={onOrbClick}
        settingsOpen={settingsOpen}
        onSettingsToggle={toggleSettings}
        dockVisible={dockVisible}
        onDockToggle={handleDockToggle}
        settingsRows={6 + (grokCfg.enabled ? 3 : 0) + (geminiCfg.enabled ? 4 : 0)}
        introEntrance={introEntrance}
        tourSpotlight={tourSpotlight}
        onHoverChange={setNotchHovered}
        settingsPanel={
          <NotchSettings
            voiceId={voiceId}
            onVoiceChange={handleVoiceChange}
            onVoicePreview={(id) => window.orb.previewVoice(id)}
            captionsEnabled={captionsEnabled}
            onCaptionsChange={handleCaptionsChange}
            colorId={mascotColor ?? DEFAULT_MASCOT_COLOR_ID}
            onColorChange={handleColorChange}
            grokEnabled={grokCfg.enabled}
            grokHasKey={grokCfg.hasKey}
            grokKeyTail={grokCfg.keyTail}
            grokVoice={grokCfg.voice}
            grokPushToTalk={grokCfg.pushToTalk === true}
            onGrokToggle={handleGrokToggle}
            onGrokVoiceChange={handleGrokVoiceChange}
            onGrokKeySave={handleGrokKeySave}
            onGrokPushToTalkToggle={handleGrokPttToggle}
            geminiEnabled={geminiCfg.enabled}
            geminiHasKey={geminiCfg.hasKey}
            geminiKeyTail={geminiCfg.keyTail}
            geminiVoice={geminiCfg.voice}
            geminiScreenShare={geminiCfg.screenShare === true}
            geminiPushToTalk={geminiCfg.pushToTalk === true}
            onGeminiToggle={handleGeminiToggle}
            onGeminiVoiceChange={handleGeminiVoiceChange}
            onGeminiKeySave={handleGeminiKeySave}
            onGeminiScreenShareToggle={handleGeminiScreenShareToggle}
            onGeminiPushToTalkToggle={handleGeminiPttToggle}
          />
        }
      />
    </div>
  )
}


// ─── WebM/Opus → 16 kHz mono WAV ───

async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer)
  } finally {
    // Close on the failure path too — a decode error here used to leak a
    // live AudioContext (and its audio render thread) per failed attempt.
    audioCtx.close().catch(() => {})
  }
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
