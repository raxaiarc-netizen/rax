import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { GearSix, SidebarSimple, X } from '@phosphor-icons/react'
import { Mascot } from './Mascot'

// ─── Rax island ───
//
// A minimal Dynamic-Island-style voice surface, flush with the hardware
// notch. The design language is "a wave and a mascot":
//
//   · parked       invisible black bar; the little robot idles beside the
//                  notch — breathing, blinking, watching the cursor
//   · listening    live mic waveform (left wing); mascot leans in with eyes
//                  swelling to your voice, "Listening" beside him
//   · transcribing teal think-sweep left, mascot squints and reads
//   · thinking     purple think-sweep left — a crest of height and light
//                  traveling across the bars; "Thinking"/tool caption beside
//                  the mascot while a scanner light sweeps his visor
//   · speaking     voice-tracking waveform left; mascot bouncing to the real
//                  loudness of his own voice, "Speaking" beside him
//   · error        visor flushes red with a head-shake; the toast below the
//                  bar carries the message; the bar re-parks after a beat
//   · settings     hovering the idle bar reveals a gear on the mascot's
//                  other side; tapping it expands the island into an inline
//                  voice-agent panel — voice / live captions / colorway —
//                  HeyClicky-style, on the bar's own black glass
//
// A short status word rides beside the MASCOT — the character and his label
// read as one unit in the right wing, the wave keeps the left wing as the
// audio heartbeat. The full streamed response still lives in the bottom
// caption pill. One accent per state on the wave; the mascot carries state
// through BEHAVIOR (see Mascot.tsx). The bar widens to one fixed open
// width; everything else is composure.

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'talking'
  | 'error'

/** Entrance beat for the mascot when the notch window appears. `at` is a
 *  performance.now() stamp — each new value (re)plays its `kind`:
 *  'tumble' = the default backflip drop-in; 'hold' = stay off-stage (the
 *  intro cameo's big mascot is mid-flight elsewhere); 'land' = thud into
 *  the seat now (the cameo just merged into the bar). */
export interface MascotEntrance {
  at: number
  kind: 'tumble' | 'hold' | 'land'
}

type RGB = [number, number, number]

// One accent per state, deliberately quiet. Speaking is monochrome white —
// the island's own voice doesn't need a color.
const ACCENTS: Record<VoiceState, RGB> = {
  idle: [125, 125, 138],
  listening: [100, 210, 255], // systemTeal
  transcribing: [100, 210, 255],
  thinking: [191, 90, 242], // systemPurple
  talking: [235, 235, 245],
  error: [255, 69, 58], // systemRed
}

/** Loudness timeline of the utterance afplay is playing, pushed by main at
 *  playback start. `levels[i]` covers the `frameMs` ms of audio beginning at
 *  `startedAtMs + i*frameMs` (Date.now() domain). */
export interface TtsEnvelopeFrames {
  id: string
  startedAtMs: number
  frameMs: number
  levels: number[]
}

interface NotchProps {
  state: VoiceState
  /** Quiet caption while thinking — e.g. "Screenshot". */
  caption?: string | null
  analyser?: AnalyserNode | null
  /** Real loudness timeline for the speaking wave — read inside the
   *  waveform's rAF, hence a ref. */
  ttsEnvelope?: React.MutableRefObject<TtsEnvelopeFrames | null>
  /** One-shot white flash when an auto-screenshot is attached. */
  flashAt?: number | null
  /** Display under the island has a hardware notch (pushed by main). */
  notched?: boolean
  /** Mascot visor colorway id (shared/mascot-colors.ts) — pushed by main. */
  mascotColor?: string
  onActivate: () => void
  /** Inline settings mode — the bar expands into a panel (HeyClicky-style)
   *  with the voice agent's controls. Owned by App: Esc handling and the
   *  close-on-busy rule live beside the rest of the keyboard logic. */
  settingsOpen?: boolean
  onSettingsToggle?: (open: boolean) => void
  /** Panel content (App composes <NotchSettings> with live values). */
  settingsPanel?: React.ReactNode
  /** Agents-dock visibility (pushed by main) + toggle — the second button
   *  in the hover cluster beside the gear. */
  dockVisible?: boolean
  onDockToggle?: () => void
  /** Control-row count in the settings panel (App knows — e.g. the Grok /
   *  Gemini voice sections add rows when enabled). Sizes the open panel. */
  settingsRows?: number
  /** Entrance/exit choreography pushes relayed by App (ORB_ENTRANCE):
   *  'hold' parks the mascot off-stage while the intro cameo plays; 'show'
   *  is the bar-cue (main just made the window visible — start the bar
   *  entrance); 'land' releases him into his seat; 'hide' is a dismissal
   *  (contract into the notch before the window hides). null = plain
   *  summons (tumble). */
  introEntrance?: { at: number; kind: 'hold' | 'land' | 'show' | 'hide' } | null
  /** First-install tour highlight. 'gear' pins the bar open with the hover
   *  cluster showing and a pulse on the settings gear ("tap the gear");
   *  'hover' leaves the bar PARKED but glowing, inviting the user to hover
   *  (so the hover itself is the gesture the tour waits on). */
  tourSpotlight?: 'gear' | 'hover' | null
  /** Lift hover state up to App so the tour's hover gate can await it. */
  onHoverChange?: (hovered: boolean) => void
}

// Geometry per display kind. On notched MacBooks the bar's center is dead
// space, so wing content stays NOTCH clearance apart while open and the
// parked bar must span the hardware cutout. On notchless displays there's
// nothing to clear — a small gap keeps the two wings reading as one island
// instead of a hollow fake notch, and the parked bar shrinks to a pill that
// covers less of the menu bar.
const GEOMETRY = {
  // The wings stay symmetric (the hardware cutout must remain centered), so
  // openWidth is sized by the busier RIGHT wing: mascot (34px) + gap + a
  // short status word, mirrored on the left where the wave floats alone.
  // parkedWidth gives the right wing ~38px so the 34px mascot sits beside
  // the cutout with breathing room. settingsWidth is the inline settings
  // panel: wide enough for label + control rows below the header strip.
  notched: { clearance: 180, parkedWidth: 288, openWidth: 472, settingsWidth: 480 },
  plain: { clearance: 56, parkedWidth: 184, openWidth: 320, settingsWidth: 384 },
} as const

// Settings-mode bar height: 38px header strip (which keeps clearing the
// hardware cutout) + 38px per control row (34px row + spacing share). The
// hardware notch is only ~32-37px tall, so everything below the header is
// clear glass. Row count comes from App (the Grok/Gemini sections add rows
// when enabled), defaulting to the classic three.
const SETTINGS_ROW_HEIGHT = 38
const settingsHeightFor = (rows: number): number => 38 + rows * SETTINGS_ROW_HEIGHT

// Collapse lag so micro state flips don't shiver the bar.
const COLLAPSE_DELAY_MS = 420

// Hover intent — incidental cursor travel along the top edge shouldn't
// balloon the bar; a deliberate ~150ms dwell still feels immediate.
const HOVER_INTENT_MS = 140

// After this long in error, re-park: the red breathing dot + the toast keep
// carrying the state, instead of a full-width island looming indefinitely.
const ERROR_PARK_MS = 4000

// Apple-feel spring — quick settle, no visible overshoot.
const SPRING = { type: 'spring', stiffness: 460, damping: 38, mass: 0.8 } as const
// prefers-reduced-motion: same geometry, plain quick fade-style tween.
const REDUCED_TWEEN = { duration: 0.18, ease: 'easeOut' } as const

export function Notch({
  state,
  caption,
  analyser,
  ttsEnvelope,
  flashAt,
  notched = true,
  mascotColor,
  onActivate,
  settingsOpen = false,
  onSettingsToggle,
  settingsPanel,
  dockVisible = true,
  onDockToggle,
  settingsRows = 3,
  introEntrance = null,
  tourSpotlight = null,
  onHoverChange,
}: NotchProps) {
  const settingsHeight = settingsHeightFor(settingsRows)
  const [hovered, setHovered] = useState(false)
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const collapseTimer = useRef<number | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const reducedMotion = useReducedMotion()

  // Error parking — after a beat the bar returns to the parked profile; the
  // dot keeps breathing red and the toast persists until acted on.
  const [errorParked, setErrorParked] = useState(false)
  useEffect(() => {
    if (state !== 'error') {
      setErrorParked(false)
      return
    }
    const t = window.setTimeout(() => setErrorParked(true), ERROR_PARK_MS)
    return () => clearTimeout(t)
  }, [state])

  const active = state !== 'idle' && !(state === 'error' && errorParked)

  // Only the gear spotlight pins the bar open; the hover invite deliberately
  // leaves it parked so the user's hover is a real, visible expand.
  const tourPin = tourSpotlight === 'gear'

  useEffect(() => {
    openRef.current = open
  }, [open])

  // Lift hover up to App (drives the tour's hover gate). Effect — not inline
  // in the handlers — so it also covers the visibility-driven reset below.
  useEffect(() => {
    onHoverChange?.(hovered)
  }, [hovered, onHoverChange])

  // Entrance choreography — the bar expands out of the notch (center-out
  // clip reveal) and the mascot arrives after it. The window stays mounted
  // across ⇧⌘O hides, so "the notch appeared" is the visibility flip
  // (hidden → visible) or the intro's explicit 'show' push, plus the very
  // first mount when the window is already showing. Which mascot beat plays
  // depends on whether the intro cameo is running: a 'hold' push parks the
  // seat empty (the big center-screen mascot is mid-flight); its 'land'
  // push thuds him in. Plain summons tumble.
  const [entering, setEntering] = useState(false)
  const [entrance, setEntrance] = useState<MascotEntrance | null>(null)
  const introArmedRef = useRef(false)
  // While a cameo holds the seat — or after a dismissal contraction — the
  // bar parks at the entrance's collapsed pose (center-clipped, see
  // .pre-entrance) so a window surfacing ahead of its 'show' cue, or the
  // stale buffer frame the compositor re-presents on the next show, never
  // flashes a full-width bar.
  const [preHold, setPreHold] = useState(false)
  // Dismissal contraction in flight (.exiting drives the notch-exit clip).
  const [exiting, setExiting] = useState(false)
  // Touchdown sympathy: the mascot's entrance impact nudges the whole bar
  // down a couple px — the landing CAUSES something, which is what makes it
  // read as weight instead of decoration. Cleared by its own animationend.
  const [thudding, setThudding] = useState(false)

  const enter = useCallback(() => {
    setPreHold(false)
    setExiting(false)
    setEntering(true)
    setEntrance({
      at: performance.now(),
      kind: introArmedRef.current ? 'hold' : 'tumble',
    })
  }, [])

  useEffect(() => {
    if (!introEntrance) return
    if (introEntrance.kind === 'hold') {
      // Arm the next show AND re-park immediately: a first-load window that
      // was painted while hidden reports document 'visible', so the
      // mount-time enter() below may already have tumbled him into the seat
      // before this push arrived. The cameo's big mascot is mid-show — the
      // seat must read empty whenever the window truly appears.
      introArmedRef.current = true
      setPreHold(true)
      setEntrance({ at: introEntrance.at, kind: 'hold' })
    } else if (introEntrance.kind === 'show') {
      // Bar-cue: main just made the window visible. The visibility flip
      // below usually fires enter() too (harmless double — the entrance
      // restarts ms apart), but on a painted-hidden first-load window that
      // flip never comes; this push is the authoritative cue.
      enter()
    } else if (introEntrance.kind === 'hide') {
      // Dismissal contraction — shrink back into the notch BEFORE main
      // hides the window (240ms later), so the window's last painted
      // frame (which the compositor re-presents on the next show) is the
      // collapsed pose the next entrance starts from. Without this every
      // re-summon flashed the stale full-width bar, then collapsed and
      // re-expanded — "expands twice".
      setOpen(false)
      setHovered(false)
      setEntering(false)
      setExiting(true)
      setPreHold(true)
    } else {
      introArmedRef.current = false
      setPreHold(false)
      setExiting(false)
      setEntrance({ at: performance.now(), kind: 'land' })
    }
  }, [introEntrance, enter])

  // Failsafe: a 'hold' whose 'land' never arrives must not leave an empty
  // bar forever. Generous — the hold is armed at summon time, seconds before
  // the cameo even cues the bar, and main converts every cameo death into a
  // 'land' push (its own watchdog caps the performance at 16s); this only
  // catches a fully wedged main-side flow.
  useEffect(() => {
    if (entrance?.kind !== 'hold') return
    const t = window.setTimeout(() => {
      setPreHold(false)
      setEntrance({ at: performance.now(), kind: 'land' })
    }, 20_000)
    return () => clearTimeout(t)
  }, [entrance])

  // Hiding the window never delivers the button's mouseleave — without this
  // a bar dismissed mid-hover re-summons stuck open with the invite showing
  // until the cursor happens to travel through the top strip again.
  useEffect(() => {
    if (document.visibilityState === 'visible') enter()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setHovered(false)
        // Kill a half-played entrance so the next summon restarts it
        // cleanly; drop any stale intro arming with it. preHold STAYS true
        // while hidden: whatever frame the buffer holds, the next show must
        // start from the collapsed pose until its 'show' cue lands.
        setEntering(false)
        setExiting(false)
        setEntrance(null)
        setPreHold(true)
        introArmedRef.current = false
      } else {
        enter()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [enter])

  // Open/close choreography:
  //   · state-driven opens are instant
  //   · hover-only opens wait out a short intent dwell (drive-by immunity)
  //   · re-hovering inside the collapse grace keeps an open bar open
  useEffect(() => {
    const clearHover = () => {
      if (hoverTimer.current) {
        clearTimeout(hoverTimer.current)
        hoverTimer.current = null
      }
    }
    const clearCollapse = () => {
      if (collapseTimer.current) {
        clearTimeout(collapseTimer.current)
        collapseTimer.current = null
      }
    }
    if (active || hovered || settingsOpen || tourPin) {
      // Any open intent cancels a pending collapse immediately — the bar
      // must never blink shut between hover-out and hover-back-in.
      clearCollapse()
      if (active || settingsOpen || tourPin) {
        // Settings mode pins the bar open without the hover-intent dwell —
        // mousing away mid-fiddle (e.g. into a native select popup) must
        // never collapse the panel under the user. The tour's gear
        // spotlight pins it the same way: the bar is mid-demonstration.
        // (The 'hover' spotlight is deliberately NOT pinned — see tourPin.)
        clearHover()
        setOpen(true)
      } else if (!openRef.current && !hoverTimer.current) {
        hoverTimer.current = window.setTimeout(() => {
          hoverTimer.current = null
          setOpen(true)
        }, HOVER_INTENT_MS)
      }
    } else {
      clearHover()
      collapseTimer.current = window.setTimeout(() => {
        setOpen(false)
        collapseTimer.current = null
      }, COLLAPSE_DELAY_MS)
    }
    return () => {
      clearHover()
      clearCollapse()
    }
  }, [active, hovered, settingsOpen, tourPin])

  const geo = notched ? GEOMETRY.notched : GEOMETRY.plain

  // Wing content. The wave (left) is the island's heartbeat — live motion
  // while audio flows, a quiet ripple otherwise. A short status word rides
  // beside the mascot (right) so the current state is legible at a glance —
  // Listening / Thinking / Speaking, or the live tool caption
  // ("Screenshot…") — reading as the character's own label. The full
  // response text still lives in the bottom caption pill; this is just the
  // one-word state badge, the way the platform's own island labels activity.
  const speaking = state === 'talking'
  const hearing = state === 'listening'
  const toolCaption =
    state === 'thinking' || state === 'transcribing' ? (caption && caption.trim()) || '' : ''
  // Status word per state. Transcribing carries no word — it's near-instant
  // now (speculative whisper) and the wave continuing from Listening reads as
  // one motion; a flashed "Transcribing" would only flicker.
  const statusLabel = settingsOpen
    ? '' // the panel's header title lives in the left wing beside the ✕
    : state === 'listening'
      ? 'Listening'
      : state === 'thinking'
        ? toolCaption || 'Thinking'
        : state === 'talking'
          ? 'Speaking'
          : state === 'error'
            ? hovered
              ? 'Tap to retry'
              : ''
            : !active && open
              ? tourSpotlight === 'gear'
                ? 'Tap the gear'
                : 'Tap to talk'
              : ''
  // Wave shows whenever the orb is actively engaged — live during audio,
  // resting ripple during transcribe/think so the wing never reads as dead.
  const showWave =
    speaking || hearing || state === 'transcribing' || state === 'thinking'
  const resting = showWave && !speaking && !hearing

  // Screenshot-attached flash: brief white rim pulse on the bar. The class
  // is cleared by the animation's own end event — a fixed timeout would
  // race App's 320ms flashAt reset and could stick the class on.
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (typeof flashAt === 'number' && flashAt > 0) setFlashing(true)
  }, [flashAt])

  // Stop affordance: on hover during any busy state the mascot's round eyes
  // morph into small stop squares — geometry, not words, answering "what
  // does a click do" the way the platform's own recording pill does. Every
  // busy state is clickable (listening sends, transcribing cancels,
  // thinking/talking stops), so every busy state earns the squares.
  const stoppable = hovered && active && state !== 'error' && !settingsOpen
  // Gear lives in the left wing whenever it's free (no wave) and the cursor
  // is around — the "other side" of the mascot. In settings mode it morphs
  // into the close ✕ with the panel title beside it. The tour's spotlight
  // forces it visible (with a pulse) while the voice says "tap the gear".
  const showGear =
    !settingsOpen && (hovered || tourSpotlight === 'gear') && !active && !!onSettingsToggle
  const ariaLabel = settingsOpen
    ? 'Rax voice settings'
    : state === 'talking' || state === 'thinking'
      ? 'Rax voice — tap to stop'
      : state === 'listening'
        ? 'Rax voice — listening, tap to send'
        : state === 'transcribing'
          ? 'Rax voice — transcribing, tap to cancel'
          : state === 'error'
            ? 'Rax voice — tap to retry'
            : 'Rax voice — tap to talk'

  return (
    <div
      className={`notch-root${entering ? ' entering' : ''}${exiting ? ' exiting' : ''}${preHold && !entering ? ' pre-entrance' : ''}`}
      // Entrance collapsed pose = the hardware-notch width, so the
      // center-out reveal starts exactly where the cutout ends and every
      // animated pixel is visible (see notch-entrance in styles.css).
      style={{ '--entrance-inset': `${((1 - geo.clearance / geo.parkedWidth) * 50).toFixed(2)}%` } as CSSProperties}
      onAnimationEnd={(e) => {
        // Covers both notch-entrance and the reduced-motion fade variant.
        if (e.animationName.startsWith('notch-entrance')) setEntering(false)
        // Exit settled — .pre-entrance (set alongside) holds the same
        // collapsed pose statically from here.
        if (e.animationName === 'notch-exit') setExiting(false)
      }}
    >
      {/* Impact wrapper — its only job is the touchdown dip. A separate
          element so the dip COMPOSES with the root's entrance slide (skip-
          intro can land while the bar is still sliding) instead of the two
          animations fighting over one transform. */}
      <div
        className={`notch-impact${thudding ? ' thud' : ''}`}
        onAnimationEnd={(e) => {
          if (e.animationName === 'notch-thud') setThudding(false)
        }}
      >
      {/* A div-with-button-role rather than a <button>: settings mode nests
          real interactive controls (gear/✕, select, toggle, swatches) inside
          the shell, and buttons cannot legally contain buttons. The window
          is non-focusable outside settings (overlay, not an app window), so
          activation is click/voice only — the Enter handler below is a
          vestigial a11y affordance for the brief focusable settings window. */}
      <motion.div
        role="button"
        tabIndex={0}
        className={`notch-shell${open ? ' open' : ''}${settingsOpen ? ' settings' : ''}${flashing ? ' flashing' : ''}${notched ? '' : ' plain'}${tourSpotlight === 'hover' ? ' tour-hover-invite' : ''}`}
        aria-label={ariaLabel}
        onClick={(e) => {
          // In settings mode the bar is a panel, not a talk button; clicks
          // on inner controls (gear, select, swatches…) must never fall
          // through to activate either.
          if (settingsOpen) return
          if ((e.target as HTMLElement).closest('button, select')) return
          onActivate()
        }}
        onKeyDown={(e) => {
          if (settingsOpen) return
          if (e.key === 'Enter') {
            e.preventDefault()
            onActivate()
          }
        }}
        onFocus={(e) => {
          // Outside settings the window is non-focusable, so any focus the
          // shell receives is a leftover from a window key transition
          // (settings close, hold-shortcut focus()). Drop it immediately —
          // the notch must never sit "selected".
          if (!settingsOpen) e.currentTarget.blur()
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onAnimationEnd={(e) => {
          if (e.animationName === 'notch-flash') setFlashing(false)
        }}
        initial={false}
        animate={{
          // Three sizes — parked, open, and the settings panel. One open
          // size for every state keeps the island calm instead of
          // re-morphing per state.
          width: settingsOpen ? geo.settingsWidth : open ? geo.openWidth : geo.parkedWidth,
          height: settingsOpen ? settingsHeight : open ? 38 : 32,
          borderBottomLeftRadius: settingsOpen ? 18 : open ? 12 : 10,
          borderBottomRightRadius: settingsOpen ? 18 : open ? 12 : 10,
        }}
        whileTap={settingsOpen ? undefined : { scale: 0.985 }}
        transition={reducedMotion ? REDUCED_TWEEN : SPRING}
      >
        {/* The header row animates its own height in lockstep with the
            shell (38px while open OR in settings mode, 32px parked) — if it
            sized itself via height:100%, leaving settings mode would snap
            it to the still-tall shell mid-collapse and the wings would leap. */}
        <motion.div
          className="notch-row"
          initial={false}
          animate={{ height: settingsOpen || open ? 38 : 32 }}
          transition={reducedMotion ? REDUCED_TWEEN : SPRING}
        >
          {/* Left wing — the wave while audio flows; the gear (settings
              invite) when the wing is free and the cursor is around; the
              ✕ + panel title in settings mode. mode="wait" serializes the
              swaps: an exiting member would otherwise sit in the flex flow
              and shove the entering one sideways. */}
          <div className="notch-wing left">
            <AnimatePresence mode="wait" initial={false}>
              {showWave ? (
                <motion.div
                  // One stable key across hearing/resting/speaking — state
                  // hops retune the SAME wave (color crossfades in CSS, the
                  // level decays naturally) instead of blanking the wing
                  // through an exit/enter pair.
                  key="wave"
                  className="notch-wave-wrap"
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  <Waveform
                    rgb={ACCENTS[state]}
                    analyser={hearing ? (analyser ?? null) : null}
                    speaking={speaking}
                    envelopeRef={ttsEnvelope ?? null}
                    resting={resting}
                  />
                </motion.div>
              ) : settingsOpen ? (
                <motion.div
                  key="settings-head"
                  className="notch-settings-head"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.14, ease: 'easeOut' }}
                >
                  <button
                    type="button"
                    className="notch-gear"
                    aria-label="Close voice settings"
                    onClick={() => onSettingsToggle?.(false)}
                  >
                    <X size={12} weight="bold" />
                  </button>
                  <span className="notch-caption">Voice agent</span>
                </motion.div>
              ) : showGear ? (
                <motion.div
                  key="quick"
                  className="notch-quick"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  <button
                    type="button"
                    className={`notch-gear${tourSpotlight === 'gear' ? ' spotlit' : ''}`}
                    aria-label="Voice agent settings"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSettingsToggle?.(true)
                    }}
                  >
                    <GearSix size={13} weight="bold" />
                  </button>
                  {onDockToggle ? (
                    <button
                      type="button"
                      className={`notch-gear notch-dock-toggle${dockVisible ? ' on' : ''}`}
                      aria-label={dockVisible ? 'Hide agents dock' : 'Show agents dock'}
                      aria-pressed={dockVisible}
                      title={dockVisible ? 'Hide agents dock' : 'Show agents dock'}
                      onClick={(e) => {
                        e.stopPropagation()
                        onDockToggle()
                      }}
                    >
                      <SidebarSimple size={13} weight={dockVisible ? 'fill' : 'bold'} />
                    </button>
                  ) : null}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {/* Center — hardware-notch clearance. Pure black, no content. */}
          <div className="notch-center" style={{ minWidth: open ? geo.clearance : 0 }} />

          {/* Right wing — the mascot with his status word beside him. Rax's
              signature presence: a living little robot that breathes,
              blinks, watches the cursor, and acts out every voice state
              (see Mascot.tsx); the label reads as his own. */}
          <div className="notch-wing right">
            <AnimatePresence mode="wait" initial={false}>
              {statusLabel ? (
                <motion.span
                  key={statusLabel}
                  className="notch-caption"
                  initial={{ opacity: 0, y: 2 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -2 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  {statusLabel}
                </motion.span>
              ) : null}
            </AnimatePresence>
            <Mascot
              state={state}
              hovered={hovered}
              stoppable={stoppable}
              analyser={hearing ? (analyser ?? null) : null}
              envelopeRef={ttsEnvelope ?? null}
              colorId={mascotColor}
              entrance={entrance}
              onEntranceImpact={() => {
                if (!reducedMotion) setThudding(true)
              }}
            />
          </div>
        </motion.div>

        {/* Settings panel — below the header strip, on the bar's own glass.
            The hardware notch only reaches ~37px down, so everything under
            the 38px header row is clear. Absolutely positioned so it never
            participates in the shell's flex layout: while the bar collapses
            it just gets CLIPPED by overflow:hidden as it fades, instead of
            being crushed and reflowing its rows mid-exit. */}
        <AnimatePresence initial={false}>
          {settingsOpen && settingsPanel ? (
            <motion.div
              key="settings-panel"
              className="notch-settings"
              style={{ top: 38, height: settingsHeight - 38 }}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.12, ease: 'easeIn' } }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              {settingsPanel}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
      </div>
    </div>
  )
}

// ─── Waveform ───
// Seven slim rounded bars with a center-weighted profile — taller in the
// middle, tapering outward — modulated by the live level. Listening reads
// the shared mic analyser; speaking replays the REAL loudness envelope of
// the playing utterance (extracted in main from the very WAV afplay is
// playing, anchored to its spawn timestamp — TTS audio never reaches the
// renderer, so there's no stream to analyse locally); resting (transcribing
// / pre-tool thinking) runs the think-sweep — a soft crest of height and
// light traveling across the bars on a loop, visible "processing" motion
// that stays quieter than the live waves so it never claims audio is
// flowing.
// Heights are written imperatively from one rAF; React never re-renders
// per frame.
const WAVE_PROFILE = [0.35, 0.6, 0.85, 1, 0.85, 0.6, 0.35]
const WAVE_MAX_PX = 16
const WAVE_MIN_PX = 3
const WAVE_REST_LEVEL = 0.1
// Think-sweep tuning. SPEED is rad/s (full loop ≈ 1.8s — unhurried, the
// cadence of "working on it"); PHASE_STEP spreads ~one crest across the
// seven bars so exactly one pulse is in flight at a time; LEVEL caps the
// crest at ~60% of the live wave's ceiling.
const THINK_LEVEL = 0.6
const THINK_SPEED = 3.4
const THINK_PHASE_STEP = 0.85
// afplay spawn → first audible sample is ~50–120ms (process launch + audio
// unit open). Shift the envelope cursor back so the wave doesn't lead the
// voice — a wave that runs early reads as fake, late reads as laggy; ~80ms
// splits the spawn-latency range.
const TTS_OUTPUT_LATENCY_MS = 80

function Waveform({
  rgb,
  analyser,
  speaking,
  envelopeRef,
  resting,
}: {
  rgb: RGB
  analyser: AnalyserNode | null
  speaking: boolean
  envelopeRef: React.MutableRefObject<TtsEnvelopeFrames | null> | null
  resting: boolean
}) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([])
  const rafRef = useRef<number>(0)
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const levelRef = useRef(0)
  const reducedMotion = useReducedMotion()
  const [r, g, b] = rgb

  useEffect(() => {
    // Vestibular safety: the resting ripple is pure decoration (no audio is
    // flowing), so under prefers-reduced-motion it freezes at its quiet
    // baseline pose. Live mic and speech waves keep moving — they're
    // functional feedback tracking real audio.
    if (reducedMotion && resting) {
      for (let i = 0; i < WAVE_PROFILE.length; i++) {
        const el = barsRef.current[i]
        if (!el) continue
        // Static mid pose — tall enough to read as "alive and working",
        // just motionless.
        const h = WAVE_MIN_PX + 0.35 * WAVE_PROFILE[i] * (WAVE_MAX_PX - WAVE_MIN_PX)
        el.style.height = `${h}px`
        el.style.opacity = '0.85'
      }
      return
    }
    const tick = (now: number) => {
      if (resting) {
        // Think-sweep: no audio to track, so the wave becomes a marquee of
        // cognition — one soft crest of height + brightness gliding across
        // the bars on a loop. (The old flat 10% baseline read as a dead or
        // stuck wave.) Never touch the analyser here: during transcribing
        // the mic stream is mid-teardown and would only read as flatline.
        levelRef.current += (THINK_LEVEL - levelRef.current) * 0.12
        for (let i = 0; i < WAVE_PROFILE.length; i++) {
          const el = barsRef.current[i]
          if (!el) continue
          const c = (Math.sin((now / 1000) * THINK_SPEED - i * THINK_PHASE_STEP) + 1) / 2
          // Smoothstep rounds the peak and softens the trough so the crest
          // reads as one glowing pulse, not a hard sine ridge.
          const crest = c * c * (3 - 2 * c)
          // Mostly flat profile — the traveling crest carries the shape;
          // the center-weighting only whispers through.
          const profile = 0.55 + 0.45 * WAVE_PROFILE[i]
          const h = Math.min(
            WAVE_MAX_PX,
            WAVE_MIN_PX +
              levelRef.current * profile * (0.25 + 0.75 * crest) * (WAVE_MAX_PX - WAVE_MIN_PX),
          )
          el.style.height = `${h}px`
          el.style.opacity = `${0.5 + 0.5 * crest}`
        }
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      let target = 0
      if (!speaking && analyser) {
        if (!dataRef.current || dataRef.current.length !== analyser.fftSize) {
          dataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize))
        }
        analyser.getByteTimeDomainData(dataRef.current)
        let sumSq = 0
        for (let i = 0; i < dataRef.current.length; i++) {
          const v = (dataRef.current[i] - 128) / 128
          sumSq += v * v
        }
        // Mic RMS is small for normal speech — scale up so the wave dances.
        target = Math.min(1, Math.sqrt(sumSq / dataRef.current.length) * 9)
      } else {
        // Speaking: replay the real loudness timeline of the playing WAV.
        // Syllables hit, pauses dip — the wave moves WITH the voice. Outside
        // the envelope's window (audio not started yet, between sentences,
        // or a stale envelope from a previous turn) hold the quiet baseline:
        // nothing is audible, so the wave shouldn't claim otherwise.
        const env = envelopeRef?.current ?? null
        if (env && env.levels.length) {
          const idx = Math.floor(
            (Date.now() - env.startedAtMs - TTS_OUTPUT_LATENCY_MS) / env.frameMs,
          )
          target = idx >= 0 && idx < env.levels.length ? env.levels[idx] : WAVE_REST_LEVEL
        } else {
          target = WAVE_REST_LEVEL
        }
      }
      // Fast attack, slower release.
      levelRef.current =
        target > levelRef.current
          ? levelRef.current + (target - levelRef.current) * 0.55
          : levelRef.current + (target - levelRef.current) * 0.18

      for (let i = 0; i < WAVE_PROFILE.length; i++) {
        const el = barsRef.current[i]
        if (!el) continue
        // Per-bar shimmer so the wave undulates instead of moving as a block.
        const shimmer = 0.85 + Math.sin(now / 1000 * (3.1 + i * 0.7) + i * 1.9) * 0.15
        const h = Math.max(
          WAVE_MIN_PX,
          Math.min(WAVE_MAX_PX, WAVE_MIN_PX + levelRef.current * WAVE_PROFILE[i] * shimmer * (WAVE_MAX_PX - WAVE_MIN_PX)),
        )
        el.style.height = `${h}px`
        // Clear any think-sweep dimming the moment audio goes live.
        el.style.opacity = '1'
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [analyser, speaking, envelopeRef, resting, reducedMotion])

  return (
    <div className="notch-wave" aria-hidden>
      {WAVE_PROFILE.map((_, i) => (
        <span
          key={i}
          ref={(el) => { barsRef.current[i] = el }}
          style={{ background: `rgba(${r},${g},${b},0.9)` }}
        />
      ))}
    </div>
  )
}
