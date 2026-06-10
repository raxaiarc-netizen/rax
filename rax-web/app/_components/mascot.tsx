'use client'

import { useEffect, useId, useRef, useState } from 'react'

// ─── Rax mascot (web port) ───
//
// The same little robot that lives in the desktop app's notch — white head,
// blue visor band, two round eyes, a stub of neck — ported for the marketing
// site. Identical spring bank, blink/saccade/tilt schedulers and per-state
// gestures as src/renderer/orb/Mascot.tsx; the only difference is audio:
// the website has no mic analyser or TTS envelope, so "listening" and
// "talking" ride a synthesized speech-cadence level instead of real audio.
//
//   · idle         breathes, blinks, glances around, follows your cursor;
//                  dozes off if you leave him alone long enough
//   · hover        perks up — a little hop, wide eyes locked on the cursor
//   · listening    leans in, eyes swelling with the (synthesized) voice,
//                  visor glow riding the level
//   · transcribing eyes squint and scan left-right, like reading back notes
//   · thinking     gazes up-left / up-right while a KITT-style light sweeps
//                  across the visor
//   · talking      bounces and stretches to the speech envelope — he dances
//                  to his own voice
//   · error        head-shake "no", visor flushes red, then a downcast sulk;
//                  hover and he looks up at you, pleading for a retry
//
// With `interactive` he can also be POKED, and he has feelings about it:
//
//   · click        a real hit — squash, eyes screwed shut, "ouch!" pops up;
//                  the complaints escalate with every rapid poke
//   · too many     full crash-out: red visor, tremble, "GRRR!!" — and
//                  clicks stop working (cursor flips to not-allowed)
//   · while angry  bring the cursor near and he GLARES at it, eyes squinted
//                  to slits, tracking your every move; poking again only
//                  extends the grudge
//   · 15 rapid hits HE HITS BACK — lunges up at the cursor, looming half
//                  again his size, wagging his head in a stern no-no scold:
//                  "don't do that again!" — everything ignores you until
//                  he's finished telling you off
//   · after ~6s    a huff, then a pointed look away ("hmph.") before he
//                  forgives you — but he stays touchy for a little while

export type MascotState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'talking' | 'error'

// Visor colorways — mirrors src/shared/mascot-colors.ts in the app (the
// website can't import across package roots, so the palette is copied).
const COLORWAYS: Record<string, { visorLight: string; visorDeep: string }> = {
  rax:  { visorLight: '#5BC4FA', visorDeep: '#3D7DF8' },
  max:  { visorLight: '#53E5E8', visorDeep: '#17AFC9' },
  alex: { visorLight: '#93BBFF', visorDeep: '#5F86F5' },
  luna: { visorLight: '#C8A6FF', visorDeep: '#9163F2' },
  nova: { visorLight: '#71E9B9', visorDeep: '#2EBE83' },
  zara: { visorLight: '#FF92B8', visorDeep: '#F2477F' },
}

interface MascotProps {
  state: MascotState
  /** Cursor is over the surface he belongs to (card, notch mock, …). */
  hovered?: boolean
  /** Visor colorway id — Rax blue or a crew skin. Unknown ids fall back. */
  colorId?: string
  /** Rendered square size. A number is px; a string passes through (e.g. '100%'). */
  size?: number | string
  /** Skip the long-idle doze (for mascots that should always look awake). */
  noDoze?: boolean
  /** Clicks hurt him, rapid clicks enrage him. For the big showcase guy. */
  interactive?: boolean
}

// ─── Geometry (one 72×72 viewBox space) ───
const HEAD_CX = 36
const HEAD_CY = 34
const HEAD_R = 22
const VISOR_X = 10
const VISOR_Y = 25
const VISOR_W = 52
const VISOR_H = 14
const VISOR_CY = VISOR_Y + VISOR_H / 2
const EYE_DX = 13.2
const EYE_D = 11.2
const NECK_TOP = 50
const NECK_BOTTOM = 63
const NECK_W = 13

// Parallax travel budgets — the per-layer difference IS the depth.
const EYE_TRAVEL_X = 5
const EYE_TRAVEL_Y = 2.8
const VISOR_TRAVEL_X = 3.5
const VISOR_TRAVEL_Y = 1.6
const HEAD_TRAVEL_X = 1.6
const HEAD_TRAVEL_Y = 0.8

const DOZE_AFTER_MS = 75_000

// ─── Tiny damped spring ───
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

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function Mascot({ state, hovered = false, colorId, size = 34, noDoze = false, interactive = false }: MascotProps) {
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
  const bubbleRef = useRef<SVGTextElement | null>(null)

  const reducedMotion = useReducedMotion()

  // Props mirrored into a ref so the mount-once rAF loop reads fresh values
  // without re-subscribing — springs must survive every state flip.
  const propsRef = useRef({ state, hovered, reducedMotion, noDoze, interactive })
  propsRef.current = { state, hovered, reducedMotion, noDoze, interactive }

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
    const bubble = bubbleRef.current
    if (!svg || !root || !squash || !head || !visor || !eyeL || !eyeR || !red || !glow || !scan || !glint || !bubble) {
      return
    }

    const now0 = performance.now()

    const sp = {
      x: new Spring(0, 14, 0.85),
      y: new Spring(-44, 16, 0.55), // starts above — mount = drop-in
      rot: new Spring(0, 16, 0.6),
      sx: new Spring(1, 26, 0.55),
      sy: new Spring(1, 26, 0.55),
      gx: new Spring(0, 24, 0.8),
      gy: new Spring(0, 24, 0.8),
      open: new Spring(1, 30, 1),
      wide: new Spring(1, 18, 0.7),
      frown: new Spring(0, 14, 0.9),
      glow: new Spring(0, 12, 1),
      red: new Spring(0, 10, 1),
      scan: new Spring(0, 12, 1),
      lean: new Spring(0, 12, 0.9),
      anger: new Spring(0, 10, 1),
      loom: new Spring(1, 12, 0.8), // scold lunge — he grows in your face
    }

    const B = {
      prevState: 'idle' as MascotState,
      prevHovered: false,
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
      // Synthesized speech cadence (no real audio on the web).
      nextPauseAt: now0 + rand(1500, 3000),
      pauseUntil: 0,
      // Poke fallout — annoyance builds per click, decays with good behavior.
      annoy: 0,
      angryUntil: 0,
      prevAngry: false,
      winceUntil: 0,
      ouchAt: -1e9,
      bubble: '',
      angerShakeAt: -1e9,
      sulkUntil: 0,
      // The retaliation ledger: rapid hits accumulate toward the scolding.
      hits: 0,
      lastHitAt: -1e9,
      scoldUntil: 0,
      micLevel: 0,
      voiceLevel: 0,
      cursorX: 0,
      cursorY: 0,
      cursorAt: -1e9,
      rect: null as DOMRect | null,
    }

    const onMove = (e: MouseEvent) => {
      B.cursorX = e.clientX
      B.cursorY = e.clientY
      B.cursorAt = performance.now()
      B.rect = svg.getBoundingClientRect()
    }
    const onLeave = () => {
      B.cursorAt = -1e9
    }
    const onDown = () => {
      if (!propsRef.current.hovered) return
      sp.sy.impulse(-3.2)
      sp.y.impulse(10)
    }
    // Pokes. He is a good sport about the first few.
    const OUCHES = ['ouch!', 'hey!', 'ow!!', 'quit it!']
    const SCOLD_MS = 2600
    const onPoke = () => {
      if (!propsRef.current.interactive) return
      const now = performance.now()
      // Mid-scold HE is doing the talking — input is dead.
      if (now < B.scoldUntil) return
      // The retaliation ledger: a pause wipes the slate, rapid hits add up.
      if (now - B.lastHitAt > 4000) B.hits = 0
      B.hits++
      B.lastHitAt = now
      if (B.hits >= 15) {
        // Enough. He hits BACK — lunges up at the cursor and scolds you.
        B.hits = 0
        B.scoldUntil = now + SCOLD_MS
        B.angryUntil = now + SCOLD_MS + 3500
        B.bubble = "don't do that again!"
        B.ouchAt = now + SCOLD_MS // bubble holds through the scold, then fades
        B.winceUntil = 0
        const toCursor = B.rect ? Math.sign(B.cursorX - (B.rect.left + B.rect.width / 2)) || 1 : 1
        sp.x.impulse(toCursor * 46)
        sp.y.impulse(-30)
        sp.sy.impulse(4)
        return
      }
      if (now < B.angryUntil) {
        // Still fuming — poking does NOT help your case.
        B.angryUntil = Math.min(B.angryUntil + 900, now + 9000)
        B.angerShakeAt = now
        B.bubble = 'stop it.'
        B.ouchAt = now
        return
      }
      B.lastActiveAt = now
      const tier = Math.min(OUCHES.length - 1, Math.floor(B.annoy * 3))
      B.annoy = Math.min(1, B.annoy + 0.28)
      B.winceUntil = now + 420
      B.ouchAt = now
      B.bubble = OUCHES[tier]
      sp.sy.impulse(-4.5)
      sp.y.impulse(16)
      sp.rot.impulse(rand(-55, 55))
      if (B.annoy >= 1) {
        // That's it. Full crash-out.
        B.angryUntil = now + 6000
        B.angerShakeAt = now
        B.bubble = 'GRRR!!'
        B.winceUntil = 0
        sp.y.impulse(-34)
        sp.sy.impulse(3)
      }
    }
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    window.addEventListener('mousedown', onDown)
    svg.addEventListener('pointerdown', onPoke)

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

      // ── Grudge bookkeeping ──
      const angry = now < B.angryUntil
      const scolding = now < B.scoldUntil
      if (B.prevAngry && !angry) {
        // Forgiveness: a huff, a pointed look away, then back to himself —
        // but he stays touchy for a little while.
        B.sulkUntil = now + 1800
        B.annoy = 0.45
        B.bubble = 'hmph.'
        B.ouchAt = now
        sp.y.impulse(-12)
        B.blinkAt = now + 600
        B.doubleBlinkAt = now + 600 + BLINK_TOTAL_MS + 130
      }
      B.prevAngry = angry
      if (!angry) B.annoy = Math.max(0, B.annoy - dt * 0.1)

      // ── State-enter impulses ──
      if (st !== B.prevState) {
        const from = B.prevState
        B.prevState = st
        B.enteredAt = now
        B.lastActiveAt = now
        if (!rm && !angry) {
          if (st === 'listening') {
            sp.y.impulse(-30) // eager hop: "I'm all ears"
            sp.wide.impulse(2.2)
          } else if (st === 'transcribing') {
            sp.y.impulse(8)
          } else if (st === 'thinking') {
            sp.y.impulse(-10)
            B.thinkSide = Math.random() < 0.5 ? -1 : 1
            B.nextThinkSwapAt = now + rand(1300, 2600)
          } else if (st === 'talking') {
            sp.y.impulse(-22)
            B.nextSquintAt = now + rand(2800, 5200)
          } else if (st === 'error') {
            B.shakeAt = now
            sp.y.impulse(14)
            sp.sy.impulse(-3.5)
          } else if (st === 'idle' && (from === 'talking' || from === 'thinking')) {
            B.blinkAt = now + 220
            B.doubleBlinkAt = now + 220 + BLINK_TOTAL_MS + 130
          }
        }
      }

      // ── Hover enter: perk up (not while he's mad at you) ──
      if (p.hovered && !B.prevHovered && !rm && !angry) {
        sp.y.impulse(-18)
        if (st === 'idle') sp.wide.impulse(1.6)
      }
      B.prevHovered = p.hovered

      // ── Synthesized audio levels ──
      // Speech-shaped: fast syllable wobble gated by breath pauses. Drives
      // "listening" (your voice) and "talking" (his) since the site has no
      // real analyser or TTS envelope.
      let speech = 0
      if (st === 'listening' || st === 'talking') {
        if (now >= B.nextPauseAt) {
          B.pauseUntil = now + rand(240, 520)
          B.nextPauseAt = now + rand(1700, 3400)
        }
        if (now >= B.pauseUntil) {
          const syll = Math.abs(Math.sin(now / 92) * Math.sin(now / 41 + 1.7))
          speech = clamp(0.16 + syll * 0.84, 0, 1)
        }
      }
      const micT = st === 'listening' ? speech : 0
      B.micLevel += (micT - B.micLevel) * (micT > B.micLevel ? 0.5 : 0.16)
      const voiceT = st === 'talking' ? speech : 0
      B.voiceLevel += (voiceT - B.voiceLevel) * (voiceT > B.voiceLevel ? 0.5 : 0.18)
      const mic = B.micLevel
      const voice = B.voiceLevel

      // ── Cursor → gaze target ──
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
      B.dozing = !rm && !p.noDoze && st === 'idle' && now - B.lastActiveAt > DOZE_AFTER_MS
      if (B.dozing && !wasDozing) B.nextDozeDipAt = now + rand(4000, 8000)
      if (!B.dozing && wasDozing) {
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
          tgx = Math.sin(now / 311) * 0.05
          tgy = 0.04 + Math.sin(now / 401) * 0.04
          break
        }
        case 'transcribing': {
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
            tgx = cgx * 0.8
            tgy = cgy * 0.5 - 0.15
            topen = 0.9
            tfrown = 0.4
            twide = 1.1
          } else {
            tgy = 0.42
            tgx = 0.12
            topen = 0.55
            tfrown = 1
            allowBlink = false
          }
          break
        }
      }

      // ── Poke fallout — overlays that trump whatever state holds ──
      if (angry) {
        // Crashed out. Red visor, seething breath, and if your cursor dares
        // come close he GLARES at it, eyes squinted to slits.
        tred = Math.max(tred, 0.9)
        tglow = 0
        twide = 1.04
        tfrown = 0
        ty = 0
        allowBlink = false
        allowSaccade = false
        breathAmp = 1.8
        if (cursorFresh) {
          tgx = cgx
          tgy = cgy
          topen = 0.34
        } else {
          topen = 0.48
          tgx = Math.sin(now / 800) * 0.12
          tgy = 0.05
        }
      } else if (now < B.sulkUntil) {
        // Forgiven — but pointedly looking away from you.
        tgx = cursorFresh ? -Math.sign(cgx || 1) * 0.55 : 0.45
        tgy = 0.12
        topen = 0.78
        tfrown = 0.3
        twide = 1
      }
      if (scolding) {
        // The strike-back: up in your face, eyes hard on the cursor, head
        // wagging a slow deliberate "no. no. no." while he tells you off.
        const t = now - (B.scoldUntil - SCOLD_MS)
        tx = (cursorFresh ? cgx : 0) * 5
        ty = -3
        topen = 0.4
        twide = 1.2
        tgx = cursorFresh ? cgx : 0
        tgy = cursorFresh ? cgy * 0.6 : 0.1
        breathAmp = 0
        allowBlink = false
        allowSaccade = false
        trot = Math.sin(t / 170) * 8 * Math.min(1, t / 250)
      }
      if (now < B.winceUntil) {
        // Ouch — eyes screwed shut.
        topen = 0.12
        twide = 1.06
        allowBlink = false
      }

      // ── Stochastic schedulers ──
      if (!rm) {
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
        if (st === 'idle' && doze === 0) {
          if (now >= B.nextTiltAt) {
            B.tiltAmt = rand(4, 7) * (Math.random() < 0.5 ? -1 : 1)
            B.tiltUntil = now + rand(1400, 3000)
            B.nextTiltAt = B.tiltUntil + rand(6000, 16_000)
          }
          if (now < B.tiltUntil) trot += B.tiltAmt
        }
        if ((st === 'idle' || st === 'talking') && now >= B.nextGlintAt) {
          B.glintAt = now
          B.nextGlintAt = now + rand(11_000, 26_000)
        }
        const shakeT = now - B.shakeAt
        if (shakeT >= 0 && shakeT < 520) {
          const decay = 1 - shakeT / 520
          trot += Math.sin(shakeT / 42) * 8.5 * decay * decay
        }
        // Crash-out shake — bigger and meaner than the error one.
        const aShakeT = now - B.angerShakeAt
        if (aShakeT >= 0 && aShakeT < 700) {
          const decay = 1 - aShakeT / 700
          trot += Math.sin(aShakeT / 30) * 10 * decay
        }
        // Seething tremble for as long as the grudge holds — but the scold
        // wag stays clean and deliberate.
        if (angry && !scolding) trot += Math.sin(now / 36) * 0.9
      }

      // Blinks
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
      const frown = stepOf(sp.frown, tfrown)
      const glowV = stepOf(sp.glow, tglow)
      const redV = stepOf(sp.red, tred)
      const scanV = stepOf(sp.scan, rm ? (st === 'thinking' ? 0.8 : 0) : tscan)
      const lean = stepOf(sp.lean, tlean)
      const angerV = stepOf(sp.anger, angry ? 1 : 0)
      const loomV = stepOf(sp.loom, scolding ? 1.3 : 1)

      if (!rm) {
        const breath = Math.sin((now / (3400 + doze * 1400)) * Math.PI * 2) * breathAmp
        y += breath * 1.3
        syv *= 1 + breath * 0.011
        y += lean * 1.2
        rot += lean * -1.1
        syv *= 1 + lean * 0.02
        syv *= 1 + voice * 0.07
        sxv *= 1 - voice * 0.05
        rot += gx * 1.5
      }
      // Scold loom rides on top of everything — he grows from the neck up.
      sxv *= loomV
      syv *= loomV

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
        const trail = side < 0 ? Math.max(0, gx) : Math.max(0, -gx)
        const w = EYE_D * wide * (1 - 0.16 * trail)
        const h = Math.max(1.1, EYE_D * wide * openTotal)
        const rx = Math.min(w, h) / 2
        const cx = HEAD_CX + side * EYE_DX + gx * EYE_TRAVEL_X
        const cy = VISOR_CY + gy * EYE_TRAVEL_Y + (1 - openTotal) * 1.4
        // Angry = inner corners DOWN toward the nose ("\ /"). SVG rotation is
        // clockwise-positive, so the left eye (side -1) needs +deg → -deg·side.
        // (+deg·side gives inner-corners-up — worried puppy brows, the exact
        // opposite read.)
        const eyeRot = (frown * -14 + angerV * -17) * side
        eye.setAttribute('x', (cx - w / 2).toFixed(2))
        eye.setAttribute('y', (cy - h / 2).toFixed(2))
        eye.setAttribute('width', w.toFixed(2))
        eye.setAttribute('height', h.toFixed(2))
        eye.setAttribute('rx', Math.min(rx, h / 2).toFixed(2))
        eye.setAttribute('transform', `rotate(${eyeRot.toFixed(2)} ${cx.toFixed(2)} ${cy.toFixed(2)})`)
      }

      red.setAttribute('fill-opacity', redV.toFixed(3))
      glow.setAttribute('fill-opacity', (glowV * 0.22).toFixed(3))

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

      // Comic bubble — pops up off his head, rises, fades. The scold line is
      // longer and louder: smaller type, parked above his loomed head, held
      // steady until he's finished, then it fades like the rest.
      if (bubble.textContent !== B.bubble) bubble.textContent = B.bubble
      const bubbleSize = scolding ? '7.5' : '10'
      if (bubble.getAttribute('font-size') !== bubbleSize) bubble.setAttribute('font-size', bubbleSize)
      if (scolding) {
        bubble.setAttribute('transform', 'translate(0 -13)')
        bubble.setAttribute('opacity', '1')
      } else {
        const bubbleT = (now - B.ouchAt) / 800
        if (bubbleT >= 0 && bubbleT < 1) {
          bubble.setAttribute('transform', `translate(0 ${(-bubbleT * 9).toFixed(2)})`)
          bubble.setAttribute('opacity', Math.sin(bubbleT * Math.PI).toFixed(3))
        } else {
          bubble.setAttribute('opacity', '0')
        }
      }

      // Cursor tells the truth: poke-able, or very much not right now.
      const wantCursor = p.interactive ? (angry ? 'not-allowed' : 'pointer') : ''
      if (svg.style.cursor !== wantCursor) svg.style.cursor = wantCursor
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('mousedown', onDown)
      svg.removeEventListener('pointerdown', onPoke)
    }
    // Mount-once by design — see propsRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const colorway = COLORWAYS[colorId ?? 'rax'] ?? COLORWAYS.rax

  // SVG paint-server ids must be unique per instance — url(#…) resolves
  // document-wide. Strip useId's colons: flaky inside url() fragments.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const visorGradId = `rxm-visor-${uid}`
  const redGradId = `rxm-red-${uid}`
  const scanGradId = `rxm-scan-${uid}`
  const glintGradId = `rxm-glint-${uid}`
  const clipId = `rxm-clip-${uid}`

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 72 72"
      width={size}
      height={size}
      style={{ overflow: 'visible', display: 'block' }}
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={visorGradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={colorway.visorLight} style={{ transition: 'stop-color 0.4s ease' }} />
          <stop offset="1" stopColor={colorway.visorDeep} style={{ transition: 'stop-color 0.4s ease' }} />
        </linearGradient>
        <linearGradient id={redGradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FF6B5E" />
          <stop offset="1" stopColor="#E0382E" />
        </linearGradient>
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
        {/* Poke feedback — outside the squash so the words don't smear. */}
        <text
          ref={bubbleRef}
          x={36}
          y={7}
          textAnchor="middle"
          fontSize={10}
          fontWeight={800}
          fontFamily="var(--font-display), system-ui, sans-serif"
          fill="#FF5A5A"
          stroke="#FFFFFF"
          strokeWidth={0.9}
          paintOrder="stroke"
          opacity={0}
          style={{ userSelect: 'none' }}
        />
      </g>
    </svg>
  )
}
