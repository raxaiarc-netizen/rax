import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

declare global {
  interface Window {
    captionPill: import('../../preload/caption-pill').CaptionPillAPI
  }
}

// ─── Tuning ───
// Grace window after voice state leaves thinking/talking before fading out.
// Long enough to finish reading the last word, short enough to feel tight.
const POST_SPEAK_GRACE_MS = 1400
// CSS fade-out duration. Must match the `.cp-pill:not(.is-visible)` transition.
const FADE_OUT_MS = 320
// Sliding-window sizes for long sentences. Single-line layout means CSS can
// only fit ~10–14 words at typical Poppins glyph widths; we keep the window
// small enough that the active word stays clear of the trailing-edge ellipsis
// while still showing enough upcoming words for the user to read ahead.
const WORDS_BEFORE_ACTIVE = 3
const WORDS_AFTER_ACTIVE = 9
// Hold the highlight on the final word for a beat after its end-time so the
// last syllable doesn't go un-highlighted mid-decay.
const FINAL_HOLD_SEC = 0.45

type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'talking' | 'error'

interface Alignment {
  chars: string[]
  starts: number[]
  ends: number[]
}

interface Segment {
  id: string
  text: string
  alignment: Alignment
  startedAtMs: number
}

/**
 * Word boundaries within a segment's text. Stable for the lifetime of a
 * segment — only the per-character alignment grows as ElevenLabs streams
 * NDJSON chunks. We cache this once per segment so the rAF tick doesn't
 * re-walk the regex scan at 60 fps.
 */
interface WordBounds {
  text: string
  /** Index of the first character of this word within segment.text. */
  charStart: number
  /** Inclusive index of the last character. */
  charEnd: number
}

const isSpeakingState = (s: VoiceState): boolean => s === 'thinking' || s === 'talking'

/**
 * Walk `text` into word boundaries (whitespace-separated; punctuation stays
 * attached). Pure function of `text` — does NOT touch alignment. Called once
 * per new segment; the result is cached for the rest of the segment's life.
 *
 * The FULL segment text is rendered from the first frame so the user sees the
 * whole sentence immediately. As alignment data streams in, the karaoke tick
 * progressively finds later active words without rebuilding this list.
 */
function buildWordBounds(text: string): WordBounds[] {
  const words: WordBounds[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++
    if (i >= n) break
    const start = i
    while (i < n && !/\s/.test(text[i])) i++
    const end = i - 1
    words.push({ text: text.slice(start, end + 1), charStart: start, charEnd: end })
  }
  return words
}

/**
 * The "current" word is the latest one whose start-time has been passed.
 * Using start-time (instead of strict start≤elapsed<end) keeps the highlight
 * sticky through inter-word silence so it never flickers off between words.
 *
 * We look up timings on the fly from the segment's live alignment rather than
 * baking them into the word list, so alignment growth is picked up the next
 * frame without rebuilding anything. Words whose first character lies past
 * the aligned range are "upcoming" and halt the scan — preserving the sticky
 * highlight behavior of the prior implementation.
 */
function findActiveWordIdx(
  words: WordBounds[],
  alignment: Alignment,
  elapsedSec: number,
): number {
  let active = -1
  const aligned = alignment.starts.length
  for (let i = 0; i < words.length; i++) {
    const charIdx = words[i].charStart
    if (charIdx >= aligned) break
    if (alignment.starts[charIdx] <= elapsedSec) active = i
    else break
  }
  return active
}

// Shared with pill + fullscreen via localStorage (same Electron origin);
// the `storage` event picks up live toggles from Settings.
function readCaptionsEnabled(): boolean {
  try {
    const raw = localStorage.getItem('rax-settings')
    if (!raw) return true
    const parsed = JSON.parse(raw)
    return typeof parsed.voiceCaptionsEnabled === 'boolean' ? parsed.voiceCaptionsEnabled : true
  } catch {
    return true
  }
}

export default function App() {
  const [captionsEnabled, setCaptionsEnabled] = useState<boolean>(readCaptionsEnabled)
  const [segment, setSegment] = useState<Segment | null>(null)
  const [words, setWords] = useState<WordBounds[]>([])
  const [activeWordIdx, setActiveWordIdx] = useState<number>(-1)
  const [visible, setVisible] = useState<boolean>(false)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')

  // Refs that the rAF tick reads — mutated synchronously inside event handlers
  // so the loop never sees stale data between renders. segmentRef carries the
  // live alignment (which grows as NDJSON chunks land); wordsRef caches the
  // segment's stable word boundaries so the tick doesn't re-walk the regex
  // scan every frame.
  const segmentRef = useRef<Segment | null>(null)
  const wordsRef = useRef<WordBounds[]>([])

  const graceTimerRef = useRef<number | null>(null)
  const clearTimerRef = useRef<number | null>(null)
  const rafRef = useRef<number>(0)

  const cancelTimers = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current)
      graceTimerRef.current = null
    }
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current)
      clearTimerRef.current = null
    }
  }, [])

  const stopRaf = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [])

  /**
   * Start (or restart) the karaoke loop. Reads segmentRef + wordsRef each
   * frame so alignment growth picks up new char timings without rebuilding
   * the word list or restarting the loop.
   */
  const startKaraoke = useCallback(() => {
    stopRaf()
    const tick = (): void => {
      const seg = segmentRef.current
      const ws = wordsRef.current
      // Defensive: with no segment or no words, there's nothing to highlight.
      // The zero-words case is only reachable for whitespace-only text (which
      // never reaches the pill in practice), but guarding here keeps the loop
      // from spinning forever on the unaligned-tail branch below.
      if (!seg || ws.length === 0) {
        rafRef.current = 0
        return
      }
      const elapsed = (Date.now() - seg.startedAtMs) / 1000
      setActiveWordIdx(findActiveWordIdx(ws, seg.alignment, elapsed))
      // Stop when (a) the final word's last char has timing AND (b) we're
      // past its end + a small hold. If alignment hasn't reached the last
      // word yet, audio is still streaming — keep ticking. tts_alignment
      // re-arms us via startKaraoke if we exit before the tail lands.
      const lastCharIdx = ws[ws.length - 1].charEnd
      const fullyAligned = lastCharIdx < seg.alignment.ends.length
      if (!fullyAligned) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const lastEndTime = seg.alignment.ends[lastCharIdx]
      if (elapsed < lastEndTime + FINAL_HOLD_SEC) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = 0
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [stopRaf])

  const beginFade = useCallback(() => {
    setVisible(false)
    stopRaf()
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    clearTimerRef.current = window.setTimeout(() => {
      clearTimerRef.current = null
      setSegment(null)
      setWords([])
      segmentRef.current = null
      wordsRef.current = []
      setActiveWordIdx(-1)
    }, FADE_OUT_MS)
  }, [stopRaf])

  const hideNow = useCallback(() => {
    cancelTimers()
    beginFade()
  }, [beginFade, cancelTimers])

  // ─── Orb / TTS event subscription ───
  useEffect(() => {
    const off = window.captionPill.onEvent((rawEvent) => {
      if (!captionsEnabled) return
      const evt = rawEvent as { type: string; [k: string]: unknown }
      switch (evt.type) {
        case 'tts_segment': {
          // New utterance is starting (afplay just spawned). Replace whatever
          // we had, anchor the rAF clock, and switch the pill to this segment.
          // Word bounds are built here ONCE (text is immutable for the
          // segment's lifetime) and cached for the rAF loop; subsequent
          // alignment chunks only carry timing growth, not new words.
          const next: Segment = {
            id: String(evt.id || ''),
            text: String(evt.text || ''),
            alignment: (evt.alignment as Alignment) || { chars: [], starts: [], ends: [] },
            startedAtMs: Number(evt.startedAtMs) || Date.now(),
          }
          const nextWords = buildWordBounds(next.text)
          cancelTimers()
          // Set refs synchronously before startKaraoke so the first tick sees
          // the new segment, not the prior one's residue.
          segmentRef.current = next
          wordsRef.current = nextWords
          setSegment(next)
          setWords(nextWords)
          setActiveWordIdx(-1)
          setVisible(true)
          startKaraoke()
          break
        }
        case 'tts_alignment': {
          // More alignment chars landed for the current segment. Mutate the
          // ref in place — the rAF tick reads alignment off segmentRef each
          // frame, so no React re-render is needed for the karaoke loop to
          // pick up the new timings. Skipping setSegment here avoids a render
          // per NDJSON chunk (which can fire ~10×/sentence).
          const id = String(evt.id || '')
          if (!segmentRef.current || segmentRef.current.id !== id) break
          const incoming = (evt.alignment as Alignment) || segmentRef.current.alignment
          segmentRef.current = { ...segmentRef.current, alignment: incoming }
          // Restart the loop only if it stopped (e.g. we passed the final-hold
          // window before the new alignment told us about further words).
          if (!rafRef.current) startKaraoke()
          break
        }
        case 'tts_cancelled': {
          const id = String(evt.id || '')
          if (segmentRef.current && segmentRef.current.id === id) {
            beginFade()
          }
          break
        }
        case 'orb_user_turn': {
          // New user input — drop any held-over segment so the pill doesn't
          // keep showing the previous response while the user is talking.
          if (segmentRef.current) beginFade()
          break
        }
        case 'orb_voice_state': {
          setVoiceState(String(evt.state || 'idle') as VoiceState)
          break
        }
        case 'orb_dismissed':
        case 'error':
        case 'orb_session_dead': {
          hideNow()
          break
        }
        // Note: text_chunk and task_complete are intentionally ignored. Those
        // fire when CLAUDE streams text / finishes generating; the pill is now
        // synced to ACTUAL TTS playback (tts_segment), not the upstream text
        // stream — that's the only way the highlight tracks what the user is
        // hearing right now.
      }
    })
    return off
  }, [captionsEnabled, cancelTimers, beginFade, hideNow, startKaraoke])

  // Voice-state-driven hide. The segment itself drives the show; voice state
  // drives the post-segment fade (when the orb's TTS queue empties and the
  // turn ends, voice state goes to 'idle' — we hold for the grace then fade).
  useEffect(() => {
    if (!segmentRef.current) return
    if (isSpeakingState(voiceState)) {
      cancelTimers()
      setVisible(true)
      return
    }
    if (voiceState === 'listening' || voiceState === 'transcribing') {
      // New turn starting — no grace.
      hideNow()
      return
    }
    // 'idle' or 'error' — start the grace timer.
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current)
    graceTimerRef.current = window.setTimeout(() => {
      graceTimerRef.current = null
      beginFade()
    }, POST_SPEAK_GRACE_MS)
    return () => {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current)
        graceTimerRef.current = null
      }
    }
  }, [voiceState, cancelTimers, hideNow, beginFade])

  // Live-toggle from Settings
  useEffect(() => {
    if (!captionsEnabled) hideNow()
  }, [captionsEnabled, hideNow])

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === 'rax-settings' || e.key === null) {
        setCaptionsEnabled(readCaptionsEnabled())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    return () => {
      stopRaf()
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current)
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [stopRaf])

  // Sliding window: long sentences (longer than ~24 words) need to scroll so
  // the active word stays in view. We always include WORDS_BEFORE_ACTIVE
  // words of context on the left so the active highlight isn't pinned to
  // the leading edge. Reads the cached `words` state (built once per segment
  // in the tts_segment handler) rather than re-walking text here.
  const { startIdx, displayWords, hasMoreBefore, hasMoreAfter } = useMemo(() => {
    if (words.length === 0) {
      return { startIdx: 0, displayWords: [] as WordBounds[], hasMoreBefore: false, hasMoreAfter: false }
    }
    const windowSize = WORDS_BEFORE_ACTIVE + WORDS_AFTER_ACTIVE
    if (words.length <= windowSize || activeWordIdx < 0) {
      return { startIdx: 0, displayWords: words, hasMoreBefore: false, hasMoreAfter: false }
    }
    let start = Math.max(0, activeWordIdx - WORDS_BEFORE_ACTIVE)
    let end = start + windowSize
    if (end > words.length) {
      end = words.length
      start = Math.max(0, end - windowSize)
    }
    return {
      startIdx: start,
      displayWords: words.slice(start, end),
      hasMoreBefore: start > 0,
      hasMoreAfter: end < words.length,
    }
  }, [words, activeWordIdx])

  // Nothing to render until we have a real segment from TTS.
  if (!captionsEnabled || !segment) {
    return <div className="cp-page" />
  }

  // If alignment hasn't arrived yet (first 100ms of a freshly-started
  // segment), fall back to showing the segment text as plain "upcoming" run
  // so the user sees something during the bootstrap window.
  if (displayWords.length === 0) {
    return (
      <div className="cp-page">
        <div className={`cp-pill${visible ? ' is-visible' : ''}`} aria-live="polite">
          <div className="cp-text">
            <span className="cp-word cp-word--upcoming">{segment.text}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="cp-page">
      <div className={`cp-pill${visible ? ' is-visible' : ''}`} aria-live="polite">
        <div className="cp-text">
          {hasMoreBefore && <span className="cp-word cp-word--spoken cp-ellipsis">…&nbsp;</span>}
          {displayWords.map((w, i) => {
            const globalIdx = startIdx + i
            const cls =
              globalIdx < activeWordIdx
                ? 'cp-word cp-word--spoken'
                : globalIdx === activeWordIdx
                  ? 'cp-word cp-word--active'
                  : 'cp-word cp-word--upcoming'
            // The trailing space sits OUTSIDE the span so CSS rendering boxes
            // don't apply the active-word glow to the whitespace gap.
            const isLast = i === displayWords.length - 1
            return (
              <span key={globalIdx}>
                <span className={cls}>{w.text}</span>
                {!isLast && ' '}
              </span>
            )
          })}
          {hasMoreAfter && <span className="cp-word cp-word--upcoming cp-ellipsis">&nbsp;…</span>}
        </div>
      </div>
    </div>
  )
}
