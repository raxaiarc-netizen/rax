import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  AppWindow,
  ChatTeardropDots,
  CursorClick,
  GearSix,
  HandWaving,
  Key,
  Microphone,
  Sparkle,
} from '@phosphor-icons/react'

// ─── First-install guided tour ───
//
// An INTERACTIVE, gated voice walkthrough (no LLM — scripted Kokoro speech)
// that plays the first time the notch lands. Unlike a narrated slideshow, it
// waits for the user to actually DO each thing before moving on, and the real
// UI element pulses so they know where to act:
//
//   · ⌥R hold-to-talk  → keycaps pulse; advances when the key is pressed
//   · the pill tab bar  → the real tab strip pulses; advances when expanded
//   · the Voice tab     → the real tab pulses; advances when selected
//   · hover the notch   → the bar glows; advances when hovered
//   · the settings gear → the gear pulses; advances when settings open
//
// Captions are off for the duration (main suppresses them — the tour's own
// card carries the words). The pill-side gates reach across windows through
// main (window.orb.tourCue → main → pill → main → onTourPillDone); the
// orb-local gates (hover/gear/⌥R) resolve from props/callbacks App feeds in.
//
// Interruptions are first-class: any real use of the orb (a turn, a session
// error, a dismissal, or — for non-gated gestures — taking over) aborts the
// performance WITHOUT marking it done; the step index is persisted on every
// transition, so the next summon resumes where it left off. Skip and natural
// completion mark it done forever.

export interface TourEntrance {
  at: number
  kind: 'hold' | 'land' | 'show' | 'hide'
}

export type TourSpotlight = 'gear' | 'hover' | null

export interface TourApi {
  /** Stop the performance without marking it done (user took over /
   *  dismissal / error) — resumes from the persisted step next summon. */
  abort: () => void
  /** ⌥R was pressed. Returns true if the tour consumed it as the gated
   *  gesture (App then suppresses the real recording); false otherwise. */
  notifyHold: () => boolean
}

interface TourCtx {
  hasRealtimeKey: boolean
}

type GateKind = 'tabbar' | 'voicetab' | 'hover' | 'gear' | 'hold-ptt'

interface TourStep {
  id: string
  /** Spoken via Kokoro — plain spoken English, no symbols or URLs. */
  line: string
  title: string
  hint: string
  icon?: ReactNode
  /** Keycap row instead of an icon — the shortcut steps. */
  keys?: string[]
  /** When set, the tour pulses the target and waits for the user to act. */
  gate?: GateKind
  /** Notch highlight to show while waiting on an orb-local gate. */
  spotlight?: Exclude<TourSpotlight, null>
  skipIf?: (ctx: TourCtx) => boolean
  /** Fires the moment the line finishes (e.g. open the Gemini key page). */
  after?: () => void
  /** Post-line dwell for non-gated (timed / demonstrated) steps. */
  holdMs?: number
}

const STEPS: TourStep[] = [
  {
    id: 'welcome',
    icon: <HandWaving size={20} weight="duotone" />,
    title: 'Welcome to Rax',
    hint: 'A quick, hands-on tour — Skip anytime',
    line:
      "Hey, I'm Rax — your voice sidekick, living right here in the notch. Let me show you around. You can hit Skip below me anytime.",
  },
  {
    id: 'hold-to-talk',
    keys: ['⌥', 'R'],
    title: 'Hold ⌥ R to talk',
    hint: 'Press and hold ⌥ R, then release — try it now',
    gate: 'hold-ptt',
    line:
      "Here's the most important part. To talk to me, press and hold the Option key and R together, then let go when you're done. Go on — give it a try right now.",
  },
  {
    id: 'pill',
    icon: <AppWindow size={20} weight="duotone" />,
    title: 'Your chats live in the pill',
    hint: 'Press the pulsing tab bar to expand it',
    gate: 'tabbar',
    line:
      'See the pill at the bottom of your screen? Press its tab bar to expand it and show your chats. Go ahead, press it now.',
  },
  {
    id: 'voice-tab',
    icon: <ChatTeardropDots size={20} weight="duotone" />,
    title: 'The Voice tab',
    hint: 'Click the pulsing Voice tab',
    gate: 'voicetab',
    line:
      'Now click the Voice tab — every conversation you and I have is saved right there. Tap it to take a look.',
  },
  {
    id: 'toggle',
    keys: ['⌘', '⇧', 'O'],
    title: 'Hide or show Rax',
    hint: 'Command Shift O — works from anywhere',
    line:
      'You can tuck me away whenever you like. Command, Shift, O hides me — and the very same keys bring me right back.',
    holdMs: 1700,
  },
  {
    id: 'gemini-key',
    icon: <Key size={20} weight="duotone" />,
    title: 'Free Gemini API key',
    hint: 'Optional — Google AI Studio is opening',
    skipIf: (ctx) => ctx.hasRealtimeKey,
    after: () => void window.orb.tourOpenKeys().catch(() => {}),
    line:
      "Last thing, and it's completely optional. For the fastest, smartest Rax, add a Gemini or Grok key — and the Gemini one is free. I'm opening Google AI Studio for you right now so you can grab one.",
    holdMs: 1400,
  },
  {
    id: 'hover',
    icon: <CursorClick size={20} weight="duotone" />,
    title: 'Hover up here',
    hint: 'Move your mouse over me ↑',
    gate: 'hover',
    spotlight: 'hover',
    skipIf: (ctx) => ctx.hasRealtimeKey,
    line: 'Once you have your key, move your mouse up here and hover over me.',
  },
  {
    id: 'gear',
    icon: <GearSix size={20} weight="duotone" />,
    title: 'Tap the gear to add it',
    hint: 'Click the glowing settings gear',
    gate: 'gear',
    spotlight: 'gear',
    skipIf: (ctx) => ctx.hasRealtimeKey,
    line:
      "Now tap the settings gear and paste your key in. And that's the whole tour — go have fun. I'll be right here.",
  },
  {
    // Goodbye for the already-has-a-key path (the two key steps skip).
    id: 'outro',
    icon: <Sparkle size={20} weight="duotone" />,
    title: "That's the tour",
    hint: 'Hold ⌥ R anytime to talk',
    skipIf: (ctx) => !ctx.hasRealtimeKey,
    line:
      "And that's everything! Press and hold Option R whenever you want to talk. I'll be right here when you need me.",
  },
]

// Beat between the cameo's touchdown and the first spoken word.
const START_AFTER_LAND_MS = 1100
const START_AFTER_VISIBLE_MS = 1800
const START_AFTER_MOUNT_MS = 2400
// A wedged TTS (lost 'done') must not freeze the tour — the longest line is
// ~14s of audio, so anything past this is a stall.
const LINE_WATCHDOG_MS = 28_000
// Card morph beat before each line so the step visual lands first.
const PRE_LINE_MS = 420
const POST_LINE_MS = 700

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface OnboardingTourProps {
  entrance: TourEntrance | null
  /** Live orb voice state — the tour only starts from a quiet, idle bar. */
  voiceState: string
  settingsOpen: boolean
  rtActive: boolean
  /** Is the cursor over the notch right now (lifted from Notch via App). */
  hovered: boolean
  grokHasKey: boolean
  geminiHasKey: boolean
  /** Drive the bar/mascot: 'talking' while a line plays, 'idle' otherwise. */
  setVoiceState: (s: 'idle' | 'talking') => void
  /** Notch highlight for the hover / gear gates. */
  setSpotlight: (s: TourSpotlight) => void
  /** Mirrored into App state — gates barge-in and click routing. */
  onActiveChange: (active: boolean) => void
  /** App's handle for aborting / feeding the ⌥R gesture into the tour. */
  apiRef: React.MutableRefObject<TourApi | null>
}

export function OnboardingTour({
  entrance,
  voiceState,
  settingsOpen,
  rtActive,
  hovered,
  grokHasKey,
  geminiHasKey,
  setVoiceState,
  setSpotlight,
  onActiveChange,
  apiRef,
}: OnboardingTourProps) {
  const [active, setActive] = useState(false)
  const [stepIdx, setStepIdx] = useState(0)
  const reducedMotion = useReducedMotion()

  // Props mirrored into refs — the async runner and the gate resolvers live
  // across renders and must read live values, not their closure snapshots.
  const voiceStateRef = useRef(voiceState)
  const settingsOpenRef = useRef(settingsOpen)
  const rtActiveRef = useRef(rtActive)
  const hoveredRef = useRef(hovered)
  const hasKeyRef = useRef(grokHasKey || geminiHasKey)
  useEffect(() => {
    voiceStateRef.current = voiceState
    rtActiveRef.current = rtActive
    hasKeyRef.current = grokHasKey || geminiHasKey
  }, [voiceState, rtActive, grokHasKey, geminiHasKey])

  // Tour lifecycle refs.
  const pendingRef = useRef(false)
  const resumeStepRef = useRef(0)
  const startedRef = useRef(false)
  const abortedRef = useRef(false)
  const activeRef = useRef(false)
  const startTimerRef = useRef<number | null>(null)
  // Settles the in-flight speakLine promise on abort.
  const speakSettleRef = useRef<(() => void) | null>(null)
  // The currently-armed interaction gate (kind + its promise resolver).
  const gateRef = useRef<{ kind: GateKind; resolve: () => void } | null>(null)
  // Late-bound abort handle so effects can call it without re-binding on
  // every render (assigned in an effect once `abort` is defined below).
  const abortRef = useRef<(() => void) | null>(null)

  const markActive = useCallback(
    (next: boolean) => {
      activeRef.current = next
      setActive(next)
      onActiveChange(next)
      // Bracket caption suppression around the whole performance.
      window.orb.tourSetActive(next)
      if (!next) window.orb.tourCue(null)
    },
    [onActiveChange],
  )

  // Resolve the armed gate iff it matches `kind`. Safe to call spuriously.
  const settleGate = useCallback((kind: GateKind) => {
    const g = gateRef.current
    if (g && g.kind === kind) {
      gateRef.current = null
      g.resolve()
    }
  }, [])

  // Arm a gate: register the resolver, light up the affordance (pill cue or
  // notch spotlight), and short-circuit if the condition is already true.
  const armGate = useCallback(
    (step: TourStep): Promise<void> =>
      new Promise<void>((resolve) => {
        const kind = step.gate as GateKind
        gateRef.current = { kind, resolve }
        if (step.spotlight) setSpotlight(step.spotlight)
        if (kind === 'tabbar' || kind === 'voicetab') window.orb.tourCue(kind)
        if (kind === 'hover' && hoveredRef.current) settleGate('hover')
        if (kind === 'gear' && settingsOpenRef.current) settleGate('gear')
      }),
    [setSpotlight, settleGate],
  )

  // ─── One line, spoken and awaited ───
  const speakLine = useCallback((text: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      let myId: string | null = null
      let settled = false
      const early = new Set<string>()
      let off: (() => void) | null = null
      let watchdog: number | null = null
      const settle = (): void => {
        if (settled) return
        settled = true
        off?.()
        if (watchdog !== null) clearTimeout(watchdog)
        if (speakSettleRef.current === settle) speakSettleRef.current = null
        resolve()
      }
      off = window.orb.onTtsDone((doneId) => {
        if (myId === null) {
          early.add(doneId)
          return
        }
        if (doneId === myId) settle()
      })
      watchdog = window.setTimeout(settle, LINE_WATCHDOG_MS)
      speakSettleRef.current = settle
      window.orb
        .ttsSpeak(text)
        .then(({ id }) => {
          if (!id || early.has(id)) {
            settle()
            return
          }
          myId = id
        })
        .catch(settle)
    })
  }, [])

  const releaseGate = useCallback(() => {
    const g = gateRef.current
    if (g) {
      gateRef.current = null
      g.resolve()
    }
  }, [])

  const finish = useCallback(
    (how: 'finished' | 'skipped') => {
      if (!activeRef.current) return
      pendingRef.current = false
      setSpotlight(null)
      setVoiceState('idle')
      markActive(false)
      void window.orb.tourDone(how).catch(() => {})
    },
    [markActive, setSpotlight, setVoiceState],
  )

  // ─── The performance ───
  const run = useCallback(
    async (from: number) => {
      startedRef.current = true
      abortedRef.current = false
      markActive(true)
      const ctx = (): TourCtx => ({ hasRealtimeKey: hasKeyRef.current })
      for (let i = Math.max(0, from); i < STEPS.length; i++) {
        if (abortedRef.current) return
        const step = STEPS[i]
        if (step.skipIf?.(ctx())) continue
        setStepIdx(i)
        window.orb.tourStep(i)
        await sleep(PRE_LINE_MS)
        if (abortedRef.current) return
        // Arm the gate BEFORE speaking so an eager user can act during the
        // line (an already-satisfied gate resolves instantly below).
        const gate = step.gate ? armGate(step) : null
        setVoiceState('talking')
        await speakLine(step.line)
        if (abortedRef.current) return
        step.after?.()
        if (gate) {
          // Drop to idle so hover/gear gates have a calm, interactive bar.
          setVoiceState('idle')
          await gate
          if (abortedRef.current) return
          setSpotlight(null)
          window.orb.tourCue(null)
        } else {
          await sleep(step.holdMs ?? POST_LINE_MS)
          if (abortedRef.current) return
        }
      }
      if (abortedRef.current) return
      setVoiceState('idle')
      finish('finished')
    },
    [armGate, finish, markActive, setSpotlight, setVoiceState, speakLine],
  )

  // ─── Start scheduling ───
  const clearStartTimer = useCallback(() => {
    if (startTimerRef.current !== null) {
      clearTimeout(startTimerRef.current)
      startTimerRef.current = null
    }
  }, [])

  const scheduleStart = useCallback(
    (delayMs: number) => {
      if (!pendingRef.current || startedRef.current) return
      clearStartTimer()
      startTimerRef.current = window.setTimeout(() => {
        startTimerRef.current = null
        if (!pendingRef.current || startedRef.current) return
        if (document.visibilityState !== 'visible') return
        // Yield the stage if the user is already busy with the orb.
        if (voiceStateRef.current !== 'idle') return
        if (settingsOpenRef.current || rtActiveRef.current) return
        void run(resumeStepRef.current)
      }, delayMs)
    },
    [clearStartTimer, run],
  )

  useEffect(() => {
    let dead = false
    window.orb
      .tourGet()
      .then((res) => {
        if (dead || !res || !res.pending) return
        pendingRef.current = true
        resumeStepRef.current = Number.isInteger(res.step) ? res.step : 0
        if (document.visibilityState === 'visible') scheduleStart(START_AFTER_MOUNT_MS)
      })
      .catch(() => {})
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') scheduleStart(START_AFTER_VISIBLE_MS)
      else clearStartTimer()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      dead = true
      document.removeEventListener('visibilitychange', onVisibility)
      clearStartTimer()
    }
  }, [scheduleStart, clearStartTimer])

  useEffect(() => {
    if (!entrance) return
    if (entrance.kind === 'land') scheduleStart(START_AFTER_LAND_MS)
    else if (entrance.kind === 'hold' || entrance.kind === 'hide') clearStartTimer()
  }, [entrance, scheduleStart, clearStartTimer])

  // ─── Gate resolvers fed by live props / callbacks ───
  // Hover: lift from Notch via App.
  useEffect(() => {
    hoveredRef.current = hovered
    if (hovered) settleGate('hover')
  }, [hovered, settleGate])

  // Settings open: resolves the gear gate; opening it off-script (any other
  // step) means the user wandered off — abort and let them resume later.
  useEffect(() => {
    settingsOpenRef.current = settingsOpen
    if (!settingsOpen || !activeRef.current) return
    if (gateRef.current?.kind === 'gear') settleGate('gear')
    else abortRef.current?.()
  }, [settingsOpen, settleGate])

  // Pill reported the relayed gesture (expand / Voice-tab select).
  useEffect(
    () =>
      window.orb.onTourPillDone((target) => {
        if (target === 'tabbar' || target === 'voicetab') settleGate(target)
      }),
    [settleGate],
  )

  // ─── Abort / skip / ⌥R handoff ───
  const stopSpeaking = useCallback(() => {
    speakSettleRef.current?.()
    void window.orb.ttsCancel()
  }, [])

  const abort = useCallback(() => {
    clearStartTimer()
    if (!activeRef.current) return
    abortedRef.current = true
    releaseGate()
    stopSpeaking()
    setSpotlight(null)
    setVoiceState('idle')
    markActive(false)
    // No tourDone — the persisted step resumes on the next boot.
  }, [clearStartTimer, markActive, releaseGate, setSpotlight, setVoiceState, stopSpeaking])

  useEffect(() => {
    abortRef.current = abort
  }, [abort])

  const skip = useCallback(() => {
    if (!activeRef.current) return
    abortedRef.current = true
    releaseGate()
    stopSpeaking()
    finish('skipped')
  }, [finish, releaseGate, stopSpeaking])

  const notifyHold = useCallback((): boolean => {
    if (gateRef.current?.kind === 'hold-ptt') {
      settleGate('hold-ptt')
      return true
    }
    return false
  }, [settleGate])

  useEffect(() => {
    apiRef.current = { abort, notifyHold }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, abort, notifyHold])

  // Unmount safety — never leave main speaking into a dead window or with
  // captions still suppressed.
  useEffect(
    () => () => {
      abortedRef.current = true
      speakSettleRef.current?.()
      if (startTimerRef.current !== null) clearTimeout(startTimerRef.current)
      if (activeRef.current) {
        window.orb.tourSetActive(false)
        window.orb.tourCue(null)
      }
    },
    [],
  )

  // ─── The guidance card ───
  const step = STEPS[stepIdx]
  const ctxNow: TourCtx = { hasRealtimeKey: grokHasKey || geminiHasKey }
  const visibleSteps = STEPS.filter((s) => !s.skipIf?.(ctxNow))
  const dotIdx = Math.max(0, visibleSteps.indexOf(step))

  const cardSpring = reducedMotion
    ? { duration: 0.18, ease: 'easeOut' as const }
    : { type: 'spring' as const, stiffness: 380, damping: 32, mass: 0.9 }

  return (
    <div className="tour-anchor">
      <AnimatePresence>
        {active && step ? (
          <motion.div
            key="tour-card"
            className="tour-card"
            role="dialog"
            aria-label="Rax tour"
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.97, transition: { duration: 0.16, ease: 'easeIn' } }}
            transition={cardSpring}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step.id}
                className="tour-step"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6, transition: { duration: 0.12, ease: 'easeIn' } }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                aria-live="polite"
              >
                {step.keys ? (
                  <div className="tour-keys" aria-hidden>
                    {step.keys.map((k, i) => (
                      <kbd key={i} className="tour-key">
                        {k}
                      </kbd>
                    ))}
                  </div>
                ) : (
                  <div className="tour-icon" aria-hidden>
                    {step.icon}
                  </div>
                )}
                <div className="tour-text">
                  <div className="tour-title">{step.title}</div>
                  <div className="tour-hint">{step.hint}</div>
                </div>
                {step.gate ? (
                  <div className="tour-await" aria-hidden title="Waiting for you">
                    <Microphone size={13} weight="fill" />
                  </div>
                ) : null}
              </motion.div>
            </AnimatePresence>
            <div className="tour-foot">
              <div className="tour-dots" aria-hidden>
                {visibleSteps.map((s, i) => (
                  <span key={s.id} className={`tour-dot${i === dotIdx ? ' on' : i < dotIdx ? ' past' : ''}`} />
                ))}
              </div>
              <button type="button" className="tour-skip" onClick={skip}>
                Skip tour
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
