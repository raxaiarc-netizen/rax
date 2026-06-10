import { useEffect, useId, useRef } from 'react'
import { useReducedMotion } from 'framer-motion'
import { getMascotColorway } from '../../shared/mascot-colors'
import type { TtsEnvelopeFrames, VoiceState } from './Notch'

// ─── Rax mascot ───
//
// The island's presence is no longer a dot — it's a little robot: white head,
// blue visor band (wider than the head, like a pulled-down pair of goggles),
// two round white eyes inside the band, a stub of neck below. He lives in the
// right wing, beside the hardware notch, and he is ALIVE:
//
//   · idle         breathes, blinks, glances around, follows your cursor when
//                  it wanders into the strip; dozes off after a long while
//   · hover        perks up — a little hop, wide eyes locked on the cursor
//   · listening    leans in, eyes wide and swelling with your voice, visor
//                  glow riding the live mic level
//   · transcribing eyes squint and scan left-right, like reading back notes
//   · thinking     gazes up-left / up-right while a KITT-style light sweeps
//                  across the visor
//   · talking      bounces and stretches to the REAL loudness envelope of the
//                  playing utterance — he dances to his own voice
//   · error        head-shake "no", visor flushes red, then a downcast sulk;
//                  hover and he looks up at you, pleading for the retry tap
//   · stop hover   while busy, hovering morphs both eyes into rounded stop
//                  squares — the platform's "tap ends this" glyph, in-character
//
// Everything runs through one rAF: a bank of tiny damped springs (position,
// tilt, squash, gaze, lids, glow…) chases per-state targets, and stochastic
// schedulers (blink / saccade / tilt / glint / doze) keep the idle loop from
// ever visibly repeating. Depth is faked with parallax — eyes travel furthest,
// visor band less, head circle least, neck not at all — so a gaze shift reads
// as a real head turn instead of stickers sliding on a coin. React renders the
// SVG once; every frame mutates attributes imperatively, the same pattern the
// waveform uses. No per-frame React work.

interface MascotProps {
  state: VoiceState
  /** Cursor is over the island shell (Notch's hover, not raw mousemove). */
  hovered: boolean
  /** Hovering while busy — a click stops/sends, so eyes morph to stop squares. */
  stoppable: boolean
  /** Live mic analyser while listening, null otherwise. */
  analyser: AnalyserNode | null
  /** Real loudness timeline of the utterance afplay is playing (talking). */
  envelopeRef: React.MutableRefObject<TtsEnvelopeFrames | null> | null
  /** Visor colorway id (shared/mascot-colors.ts) — Rax blue or a crew skin.
   *  Unknown/absent ids fall back to Rax blue. */
  colorId?: string
}

// ─── Geometry (one 72×72 viewBox space; rendered at 34px) ───
// Proportions traced from the reference art: head r22, visor band ~0.63·r
// tall overhanging the head by ~4u each side, eyes r5.6 at ±13.2 — slightly
// larger than the art's eyes so expressions survive being 5px on screen.
const HEAD_CX = 36
const HEAD_CY = 34
const HEAD_R = 22
const VISOR_X = 10
const VISOR_Y = 25
const VISOR_W = 52
const VISOR_H = 14
const VISOR_CY = VISOR_Y + VISOR_H / 2 // 32
const EYE_DX = 13.2
const EYE_D = 11.2
const STOP_SIZE = 10.6 // square-eye side while "tap stops this"
// Neck proportions traced from the art: ~0.3 head-widths wide with only a
// stub showing below the chin — wider/shorter reads "torso below frame",
// where the first draft's slim peg read "tail".
const NECK_TOP = 50 // tucked behind the head circle; bottom edge is his "ground"
const NECK_BOTTOM = 63
const NECK_W = 13

// Travel budgets for a full gaze deflection (|gaze| = 1), in viewBox units.
// The three layers move different amounts — that difference IS the depth.
const EYE_TRAVEL_X = 5
const EYE_TRAVEL_Y = 2.8
const VISOR_TRAVEL_X = 3.5
const VISOR_TRAVEL_Y = 1.6
const HEAD_TRAVEL_X = 1.6
const HEAD_TRAVEL_Y = 0.8

// Mirrors the waveform's afplay spawn-latency compensation: the envelope is
// anchored to process spawn, first audible sample lands ~50–120ms later.
const TTS_OUTPUT_LATENCY_MS = 80

// Doze: after this long idle with no cursor/hover/state activity he nods off —
// half-lidded, gaze sinking, slow deep breaths, the occasional head-bob dip.
const DOZE_AFTER_MS = 75_000

// ─── Tiny damped spring ───
// Semi-implicit Euler; ω = response speed (rad/s), ζ = damping ratio. ζ < 1
// overshoots — deliberately, on the bouncy channels — so impulses (hops,
// startles, thuds) ring with cartoon life instead of easing flatly.
class Spring {
  x: number
  v = 0
  constructor(
    x0: number,
    private w: number,
    private z: number,
  ) {
    this.x = x0
  }
  step(target: number, dt: number): number {
    const a = -this.w * this.w * (this.x - target) - 2 * this.z * this.w * this.v
    this.v += a * dt
    this.x += this.v * dt
    return this.x
  }
  snap(target: number): number {
    this.x = target
    this.v = 0
    return this.x
  }
  impulse(dv: number): void {
    this.v += dv
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const rand = (a: number, b: number) => a + Math.random() * (b - a)

// Blink envelope — lids snap shut fast, hold a beat, reopen slower with a
// slight over-wide settle (the snap-open that makes a blink read as awake
// rather than sleepy). Returns an eye-height multiplier, may exceed 1.
const BLINK_CLOSE_MS = 70
const BLINK_HOLD_MS = 45
const BLINK_OPEN_MS = 150
const BLINK_TOTAL_MS = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS
function blinkMul(elapsed: number): number {
  if (elapsed < 0 || elapsed >= BLINK_TOTAL_MS) return 1
  if (elapsed < BLINK_CLOSE_MS) {
    const t = elapsed / BLINK_CLOSE_MS
    return 1 - t * t
  }
  if (elapsed < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 0
  const t = (elapsed - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS
  const e = 1 - (1 - t) * (1 - t)
  return e * (1 + 0.08 * Math.sin(t * Math.PI))
}

export function Mascot({ state, hovered, stoppable, analyser, envelopeRef, colorId }: MascotProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const rootRef = useRef<SVGGElement | null>(null)
  const squashRef = useRef<SVGGElement | null>(null)
  const headRef = useRef<SVGGElement | null>(null)
  const visorRef = useRef<SVGGElement | null>(null)
  const eyeLRef = useRef<SVGRectElement | null>(null)
  const eyeRRef = useRef<SVGRectElement | null>(null)
  const redRef = useRef<SVGRectElement | null>(null)
  const glowRef = useRef<SVGRectElement | null>(null)
  const scanRef = useRef<SVGEllipseElement | null>(null)
  const glintRef = useRef<SVGRectElement | null>(null)

  const reducedMotion = useReducedMotion()

  // Props + reduced-motion mirrored into a ref so the mount-once rAF loop
  // reads fresh values without re-subscribing — springs and schedulers must
  // survive every state flip, or the motion would reset mid-gesture.
  const propsRef = useRef({ state, hovered, stoppable, analyser, envelopeRef, reducedMotion, colorId })
  propsRef.current = { state, hovered, stoppable, analyser, envelopeRef, reducedMotion, colorId }

  useEffect(() => {
    const svg = svgRef.current
    const root = rootRef.current
    const squash = squashRef.current
    const head = headRef.current
    const visor = visorRef.current
    const eyeL = eyeLRef.current
    const eyeR = eyeRRef.current
    const red = redRef.current
    const glow = glowRef.current
    const scan = scanRef.current
    const glint = glintRef.current
    if (!svg || !root || !squash || !head || !visor || !eyeL || !eyeR || !red || !glow || !scan || !glint) {
      return
    }

    const now0 = performance.now()

    // Spring bank. ζ < 1 on y / tilt / squash = bounce; gaze slightly
    // underdamped so saccades land with the real eye's tiny overshoot.
    const sp = {
      x: new Spring(0, 14, 0.85),
      y: new Spring(-44, 16, 0.55), // starts above the bar — mount = drop-in
      rot: new Spring(0, 16, 0.6),
      sx: new Spring(1, 26, 0.55),
      sy: new Spring(1, 26, 0.55),
      gx: new Spring(0, 24, 0.8),
      gy: new Spring(0, 24, 0.8),
      open: new Spring(1, 30, 1),
      wide: new Spring(1, 18, 0.7),
      sq: new Spring(0, 20, 0.9), // round eyes ↔ stop squares
      frown: new Spring(0, 14, 0.9), // 0..1 → sad slit angle
      glow: new Spring(0, 12, 1),
      red: new Spring(0, 10, 1),
      scan: new Spring(0, 12, 1),
      lean: new Spring(0, 12, 0.9),
    }

    // Behavior memory — every stochastic scheduler keys off these timestamps.
    const B = {
      prevState: 'idle' as VoiceState,
      prevHovered: false,
      prevColorId: propsRef.current.colorId,
      enteredAt: now0,
      nextBlinkAt: now0 + rand(900, 2200),
      blinkAt: -1e9,
      doubleBlinkAt: -1e9,
      nextSaccadeAt: now0 + rand(2200, 4500),
      sacX: 0,
      sacY: 0,
      sacUntil: 0,
      nextTiltAt: now0 + rand(7000, 15_000),
      tiltAmt: 0,
      tiltUntil: 0,
      nextGlintAt: now0 + rand(5000, 12_000),
      glintAt: -1e9,
      thinkSide: Math.random() < 0.5 ? -1 : 1,
      nextThinkSwapAt: 0,
      nextSquintAt: 0,
      squintUntil: 0,
      shakeAt: -1e9,
      lastActiveAt: now0,
      nextDozeDipAt: 0,
      dozing: false,
      micLevel: 0,
      voiceLevel: 0,
      cursorX: 0,
      cursorY: 0,
      cursorAt: -1e9,
      rect: null as DOMRect | null,
    }

    // Cursor watching: the strip window forwards mousemove even while
    // click-through, so within the top strip he genuinely watches the pointer.
    // The bounding rect is cached per move (it only shifts when the bar
    // resizes, and moves keep flowing during that) — no per-frame layout read.
    const onMove = (e: MouseEvent) => {
      B.cursorX = e.clientX
      B.cursorY = e.clientY
      B.cursorAt = performance.now()
      B.rect = svg.getBoundingClientRect()
    }
    const onLeave = () => {
      B.cursorAt = -1e9
    }
    // Squash on press — only when the cursor is actually on the shell
    // (everywhere else the window is click-through and the press belongs to
    // whatever app is underneath).
    const onDown = () => {
      if (!propsRef.current.hovered) return
      sp.sy.impulse(-3.2)
      sp.y.impulse(10)
    }
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    window.addEventListener('mousedown', onDown)

    const data = { buf: null as Uint8Array<ArrayBuffer> | null }

    let raf = 0
    let last = now0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = clamp((now - last) / 1000, 0, 0.034)
      last = now
      if (dt <= 0) return

      const p = propsRef.current
      const rm = !!p.reducedMotion
      const st = p.state

      // ── State-enter impulses — the gesture that announces each mode ──
      if (st !== B.prevState) {
        const from = B.prevState
        B.prevState = st
        B.enteredAt = now
        B.lastActiveAt = now
        if (!rm) {
          if (st === 'listening') {
            sp.y.impulse(-30) // eager hop: "I'm all ears"
            sp.wide.impulse(2.2)
          } else if (st === 'transcribing') {
            sp.y.impulse(8) // small settling nod
          } else if (st === 'thinking') {
            sp.y.impulse(-10)
            B.thinkSide = Math.random() < 0.5 ? -1 : 1
            B.nextThinkSwapAt = now + rand(1300, 2600)
          } else if (st === 'talking') {
            sp.y.impulse(-22) // bright little hop into speech
            B.nextSquintAt = now + rand(2800, 5200)
          } else if (st === 'error') {
            B.shakeAt = now // head-shake "no" + thud
            sp.y.impulse(14)
            sp.sy.impulse(-3.5)
          } else if (st === 'idle' && (from === 'talking' || from === 'thinking')) {
            // Turn finished — relax with a contented double-blink.
            B.blinkAt = now + 220
            B.doubleBlinkAt = now + 220 + BLINK_TOTAL_MS + 130
          }
        }
      }

      // ── Hover enter: perk up ──
      if (p.hovered && !B.prevHovered && !rm) {
        sp.y.impulse(-18)
        if (st === 'idle') sp.wide.impulse(1.6)
      }
      B.prevHovered = p.hovered

      // ── New colorway: a delighted hop + double-blink, like trying on a
      // fresh visor. (The gradient itself crossfades via CSS on the stops.)
      if (p.colorId !== B.prevColorId) {
        B.prevColorId = p.colorId
        if (!rm) {
          sp.y.impulse(-24)
          sp.wide.impulse(2)
          B.blinkAt = now
          B.doubleBlinkAt = now + BLINK_TOTAL_MS + 120
        }
      }

      // ── Audio levels ──
      // Listening: RMS of the shared mic analyser (same ×9 normalization as
      // the waveform). Talking: the utterance's real loudness envelope.
      let micT = 0
      if (st === 'listening' && p.analyser) {
        const a = p.analyser
        if (!data.buf || data.buf.length !== a.fftSize) {
          data.buf = new Uint8Array(new ArrayBuffer(a.fftSize))
        }
        a.getByteTimeDomainData(data.buf)
        let sumSq = 0
        for (let i = 0; i < data.buf.length; i++) {
          const v = (data.buf[i] - 128) / 128
          sumSq += v * v
        }
        micT = Math.min(1, Math.sqrt(sumSq / data.buf.length) * 9)
      }
      B.micLevel += (micT - B.micLevel) * (micT > B.micLevel ? 0.5 : 0.16)

      let voiceT = 0
      if (st === 'talking') {
        const env = p.envelopeRef?.current ?? null
        if (env && env.levels.length) {
          const idx = Math.floor((Date.now() - env.startedAtMs - TTS_OUTPUT_LATENCY_MS) / env.frameMs)
          voiceT = idx >= 0 && idx < env.levels.length ? env.levels[idx] : 0
        }
      }
      B.voiceLevel += (voiceT - B.voiceLevel) * (voiceT > B.voiceLevel ? 0.5 : 0.18)
      const mic = B.micLevel
      const voice = B.voiceLevel

      // ── Cursor → gaze target (idle / hover / error plead / stop hover).
      // While listening he looks AT you (straight out), not at the pointer.
      const cursorFresh = now - B.cursorAt < 1600 && B.rect
      let cgx = 0
      let cgy = 0
      if (cursorFresh && B.rect) {
        const cx = B.rect.left + B.rect.width / 2
        const cy = B.rect.top + B.rect.height / 2
        const dx = B.cursorX - cx
        const dy = B.cursorY - cy
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          cgx = clamp(dx / 140, -1, 1)
          cgy = clamp(dy / 80, -1, 1) * 0.8
        }
      }

      // ── Activity + doze bookkeeping ──
      if (st !== 'idle' || p.hovered || cursorFresh) B.lastActiveAt = now
      const wasDozing = B.dozing
      B.dozing = !rm && st === 'idle' && now - B.lastActiveAt > DOZE_AFTER_MS
      if (B.dozing && !wasDozing) B.nextDozeDipAt = now + rand(4000, 8000)
      if (!B.dozing && wasDozing) {
        // Startled awake — jolt up, eyes wide, quick double-blink.
        sp.y.impulse(-26)
        sp.wide.impulse(2.4)
        B.blinkAt = now
        B.doubleBlinkAt = now + BLINK_TOTAL_MS + 110
      }
      const doze = B.dozing ? clamp((now - B.lastActiveAt - DOZE_AFTER_MS) / 1800, 0, 1) : 0

      // ── Targets for this frame ──
      let tx = 0
      let ty = 0
      let trot = 0
      let topen = 1
      let twide = 1
      let tgx = 0
      let tgy = 0
      let tsq = 0
      let tfrown = 0
      let tglow = 0.06
      let tred = 0
      let tscan = 0
      let tlean = 0
      let breathAmp = 1
      let allowBlink = true
      let allowSaccade = false

      switch (st) {
        case 'idle': {
          if (cursorFresh) {
            tgx = cgx
            tgy = cgy
          } else {
            allowSaccade = true
          }
          if (p.hovered) {
            twide = 1.16
            tglow = 0.3
          }
          if (doze > 0) {
            topen = 1 - 0.55 * doze
            tgy = 0.35 * doze
            ty = 1.4 * doze
            twide = 1 - 0.06 * doze
            breathAmp = 1 + 0.6 * doze
            allowBlink = doze < 0.5
            // The nod-off dip: head slowly sags, then catches itself.
            if (now >= B.nextDozeDipAt) {
              B.nextDozeDipAt = now + rand(5000, 9500)
              sp.y.impulse(9)
            }
          }
          break
        }
        case 'listening': {
          twide = 1.15 + mic * 0.14
          tglow = 0.22 + mic * 0.55
          tlean = 1
          breathAmp = 0.35
          // Micro gaze jitter — fixated but alive, the way held eye contact
          // actually behaves.
          tgx = Math.sin(now / 311) * 0.05
          tgy = 0.04 + Math.sin(now / 401) * 0.04
          break
        }
        case 'transcribing': {
          // Reading back your words: squinted eyes sweeping line-wise.
          topen = 0.72
          twide = 0.96
          tglow = 0.28
          breathAmp = 0.5
          const ph = ((now - B.enteredAt) / 700) % 2
          tgx = lerp(-0.55, 0.55, ph < 1 ? ph : 2 - ph)
          tgy = 0.15
          allowBlink = false
          break
        }
        case 'thinking': {
          // Pondering gaze — up and to one side, swapping sides now and then —
          // while the scanner light sweeps the visor.
          if (now >= B.nextThinkSwapAt) {
            B.nextThinkSwapAt = now + rand(1300, 2800)
            if (Math.random() < 0.7) B.thinkSide = -B.thinkSide
          }
          tgx = 0.6 * B.thinkSide
          tgy = -0.55
          topen = 0.92
          tscan = 1
          tglow = 0.12
          breathAmp = 0.7
          trot = Math.sin(now / 900) * 1.6
          break
        }
        case 'talking': {
          // He dances to his own voice: louder syllables stretch him taller
          // and lift him off the baseline; pauses let him settle.
          ty = -voice * 4.6
          trot = Math.sin(now / 77) * voice * 2.4
          twide = 1 + voice * 0.12
          tgy = 0.06
          tglow = 0.18 + voice * 0.6
          breathAmp = 0.2
          if (now >= B.nextSquintAt && B.squintUntil < now) {
            B.nextSquintAt = now + rand(3200, 6500)
            B.squintUntil = now + 600
          }
          if (now < B.squintUntil) {
            // Happy squint mid-speech — the ^ ^ beat.
            topen = 0.42
            twide = Math.max(twide, 1.1)
          }
          break
        }
        case 'error': {
          tred = 1
          tglow = 0
          breathAmp = 0.4
          if (p.hovered) {
            // Pleading look up at the cursor: "tap to retry?"
            tgx = cgx * 0.8
            tgy = cgy * 0.5 - 0.15
            topen = 0.9
            tfrown = 0.4
            twide = 1.1
          } else {
            // Downcast sulk after the shake.
            tgy = 0.42
            tgx = 0.12
            topen = 0.55
            tfrown = 1
            allowBlink = false
          }
          break
        }
      }

      // Stop affordance trumps the eye pose: both eyes square up while a
      // click would stop/send — geometry answering "what does a tap do".
      if (p.stoppable) {
        tsq = 1
        topen = 1
        tfrown = 0
        twide = 1
        allowBlink = false
        if (cursorFresh) {
          tgx = cgx * 0.7
          tgy = cgy * 0.7
        }
      }

      // ── Stochastic schedulers ──
      if (!rm) {
        // Saccades — idle glances at nothing in particular.
        if (allowSaccade) {
          if (now >= B.nextSaccadeAt) {
            B.sacX = rand(-0.85, 0.85)
            B.sacY = rand(-0.35, 0.45)
            B.sacUntil = now + rand(550, 2100)
            B.nextSaccadeAt = B.sacUntil + rand(900, 4600)
          }
          if (now < B.sacUntil) {
            tgx = B.sacX
            tgy = B.sacY
          }
        }
        // Idle head tilts — the curious-dog beat.
        if (st === 'idle' && doze === 0) {
          if (now >= B.nextTiltAt) {
            B.tiltAmt = rand(4, 7) * (Math.random() < 0.5 ? -1 : 1)
            B.tiltUntil = now + rand(1400, 3000)
            B.nextTiltAt = B.tiltUntil + rand(6000, 16_000)
          }
          if (now < B.tiltUntil) trot += B.tiltAmt
        }
        // Specular glint marching across the visor — idle/talking jewellery.
        if ((st === 'idle' || st === 'talking') && now >= B.nextGlintAt) {
          B.glintAt = now
          B.nextGlintAt = now + rand(11_000, 26_000)
        }
        // Error head-shake — driven directly, not through a spring, so the
        // "no-no-no" oscillation stays crisp.
        const shakeT = now - B.shakeAt
        if (shakeT >= 0 && shakeT < 520) {
          const decay = 1 - shakeT / 520
          trot += Math.sin(shakeT / 42) * 8.5 * decay * decay
        }
      }

      // Blinks — scheduled, plus occasional doubles; suppressed while the
      // pose owns the lids (squints, sulk, stop squares).
      let blink = 1
      if (!rm || st === 'idle') {
        if (allowBlink && topen > 0.6 && now >= B.nextBlinkAt) {
          B.blinkAt = now
          B.nextBlinkAt = now + (rm ? rand(6000, 9000) : rand(2400, 6500))
          if (!rm && Math.random() < 0.18) B.doubleBlinkAt = now + BLINK_TOTAL_MS + 120
        }
        if (B.doubleBlinkAt > 0 && now >= B.doubleBlinkAt) {
          B.blinkAt = now
          B.doubleBlinkAt = -1e9
        }
        blink = blinkMul(now - B.blinkAt)
      }

      // ── Step springs (reduced motion: snap straight to pose) ──
      const stepOf = (s: Spring, target: number) => (rm ? s.snap(target) : s.step(target, dt))
      const x = stepOf(sp.x, tx)
      let y = stepOf(sp.y, ty)
      let rot = stepOf(sp.rot, trot)
      let sxv = stepOf(sp.sx, 1)
      let syv = stepOf(sp.sy, 1)
      const gx = stepOf(sp.gx, tgx)
      const gy = stepOf(sp.gy, tgy)
      const openV = stepOf(sp.open, topen)
      const wide = stepOf(sp.wide, twide)
      const sqv = stepOf(sp.sq, tsq)
      const frown = stepOf(sp.frown, tfrown)
      const glowV = stepOf(sp.glow, tglow)
      const redV = stepOf(sp.red, tred)
      const scanV = stepOf(sp.scan, rm ? (st === 'thinking' ? 0.8 : 0) : tscan)
      const lean = stepOf(sp.lean, tlean)

      // Breathing + lean + speech squash-and-stretch, layered after the
      // springs so they ride on top of whatever gesture is in flight.
      if (!rm) {
        const breath = Math.sin((now / (3400 + doze * 1400)) * Math.PI * 2) * breathAmp
        y += breath * 1.3
        syv *= 1 + breath * 0.011
        y += lean * 1.2
        rot += lean * -1.1
        syv *= 1 + lean * 0.02
        syv *= 1 + voice * 0.07
        sxv *= 1 - voice * 0.05
        // Gaze drags a hint of head-turn with it — necks exist.
        rot += gx * 1.5
      }

      // ── Compose & write ──
      root.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot.toFixed(2)} ${HEAD_CX} 40)`)
      squash.setAttribute(
        'transform',
        `translate(${HEAD_CX} ${NECK_BOTTOM}) scale(${sxv.toFixed(3)} ${syv.toFixed(3)}) translate(${-HEAD_CX} ${-NECK_BOTTOM})`,
      )
      head.setAttribute('transform', `translate(${(gx * HEAD_TRAVEL_X).toFixed(2)} ${(gy * HEAD_TRAVEL_Y).toFixed(2)})`)
      visor.setAttribute('transform', `translate(${(gx * VISOR_TRAVEL_X).toFixed(2)} ${(gy * VISOR_TRAVEL_Y).toFixed(2)})`)

      const openTotal = clamp(openV * blink, 0, 1.12)
      for (const side of [-1, 1] as const) {
        const eye = side < 0 ? eyeL : eyeR
        // 3D foreshortening: the eye on the far side of a turn narrows.
        const trail = side < 0 ? Math.max(0, gx) : Math.max(0, -gx)
        let w = EYE_D * wide * (1 - 0.16 * trail)
        let h = Math.max(1.1, EYE_D * wide * openTotal)
        w = lerp(w, STOP_SIZE, sqv)
        h = lerp(h, STOP_SIZE, sqv)
        const rx = lerp(Math.min(w, h) / 2, 3, sqv)
        const cx = HEAD_CX + side * EYE_DX + gx * EYE_TRAVEL_X
        const cy = VISOR_CY + gy * EYE_TRAVEL_Y + (1 - openTotal) * 1.4
        const eyeRot = frown * -14 * side
        eye.setAttribute('x', (cx - w / 2).toFixed(2))
        eye.setAttribute('y', (cy - h / 2).toFixed(2))
        eye.setAttribute('width', w.toFixed(2))
        eye.setAttribute('height', h.toFixed(2))
        eye.setAttribute('rx', Math.min(rx, h / 2).toFixed(2))
        eye.setAttribute('transform', `rotate(${eyeRot.toFixed(2)} ${cx.toFixed(2)} ${cy.toFixed(2)})`)
      }

      red.setAttribute('fill-opacity', redV.toFixed(3))
      glow.setAttribute('fill-opacity', (glowV * 0.22).toFixed(3))

      // Thinking scanner — KITT sweep, frozen to a steady glow under
      // reduced motion (state info without the travel).
      const scanX = rm ? HEAD_CX : HEAD_CX + Math.sin((now / 1400) * Math.PI * 2) * 15
      scan.setAttribute('cx', scanX.toFixed(2))
      scan.setAttribute('opacity', (scanV * 0.62).toFixed(3))

      const glintT = (now - B.glintAt) / 650
      if (glintT >= 0 && glintT < 1) {
        glint.setAttribute('transform', `translate(${lerp(-30, 30, glintT).toFixed(2)} 0) rotate(16 ${HEAD_CX} ${VISOR_CY})`)
        glint.setAttribute('opacity', (0.35 * Math.sin(glintT * Math.PI)).toFixed(3))
      } else {
        glint.setAttribute('opacity', '0')
      }
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('mousedown', onDown)
    }
    // Mount-once by design — see propsRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Visor colorway — Rax blue or a crew skin. Re-rendering on change only
  // touches the gradient stops (React diffs the rest back to identical
  // initial attrs, so the rAF's imperative transforms survive untouched);
  // the stop-color transition crossfades the visor instead of snapping.
  const colorway = getMascotColorway(colorId)

  // SVG paint-server ids must be unique per INSTANCE — url(#…) resolves
  // document-wide, so two mascots sharing literal ids would both paint with
  // whichever gradient mounted first. Strip useId's colons: they're legal in
  // HTML ids but flaky inside url() fragment references.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const visorGradId = `rxm-visor-${uid}`
  const redGradId = `rxm-red-${uid}`
  const scanGradId = `rxm-scan-${uid}`
  const glintGradId = `rxm-glint-${uid}`
  const clipId = `rxm-clip-${uid}`

  return (
    <svg
      ref={svgRef}
      className={`notch-mascot ${state}`}
      viewBox="0 0 72 72"
      width={34}
      height={34}
      style={{ overflow: 'visible' }}
      aria-hidden
      focusable="false"
    >
      <defs>
        {/* Visor gradient: lit left → deep right, same lighting as the
            reference art whatever the colorway. */}
        <linearGradient id={visorGradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={colorway.visorLight} style={{ transition: 'stop-color 0.4s ease' }} />
          <stop offset="1" stopColor={colorway.visorDeep} style={{ transition: 'stop-color 0.4s ease' }} />
        </linearGradient>
        <linearGradient id={redGradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FF6B5E" />
          <stop offset="1" stopColor="#E0382E" />
        </linearGradient>
        {/* Soft-core sweep light — radial fade instead of a blur filter, so the
            thinking scan costs a gradient fill rather than a per-frame filter. */}
        <radialGradient id={scanGradId} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.9" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={glintGradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x={VISOR_X} y={VISOR_Y} width={VISOR_W} height={VISOR_H} rx={2} />
        </clipPath>
      </defs>

      <g ref={rootRef}>
        <g ref={squashRef}>
          {/* Neck — the still layer the parallax plays against. */}
          <rect x={HEAD_CX - NECK_W / 2} y={NECK_TOP} width={NECK_W} height={NECK_BOTTOM - NECK_TOP} rx={3} fill="#FFFFFF" />
          <g ref={headRef}>
            <circle cx={HEAD_CX} cy={HEAD_CY} r={HEAD_R} fill="#FFFFFF" />
          </g>
          <g ref={visorRef}>
            <rect x={VISOR_X} y={VISOR_Y} width={VISOR_W} height={VISOR_H} rx={2} fill={`url(#${visorGradId})`} />
            <g clipPath={`url(#${clipId})`}>
              <rect ref={redRef} x={VISOR_X} y={VISOR_Y} width={VISOR_W} height={VISOR_H} fill={`url(#${redGradId})`} fillOpacity={0} />
              <rect ref={glowRef} x={VISOR_X} y={VISOR_Y} width={VISOR_W} height={VISOR_H} fill="#FFFFFF" fillOpacity={0} />
              <ellipse ref={scanRef} cx={HEAD_CX} cy={VISOR_CY} rx={9.5} ry={9.5} fill={`url(#${scanGradId})`} opacity={0} />
              <rect ref={glintRef} x={33.5} y={VISOR_Y - 3} width={5} height={VISOR_H + 6} fill={`url(#${glintGradId})`} opacity={0} />
              <rect ref={eyeLRef} x={17.2} y={26.4} width={EYE_D} height={EYE_D} rx={EYE_D / 2} fill="#FFFFFF" />
              <rect ref={eyeRRef} x={43.6} y={26.4} width={EYE_D} height={EYE_D} rx={EYE_D / 2} fill="#FFFFFF" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  )
}
