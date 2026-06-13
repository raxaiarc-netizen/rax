import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Mascot } from '../orb/Mascot'
import type { VoiceState } from '../orb/Notch'
import { getMascotColorway } from '../../shared/mascot-colors'
import './styles.css'

// ─── Intro cameo ───
//
// The notch's opening number. When the app opens (boot, onboarding launch),
// main raises THIS window — transparent, click-through with mousemove
// forwarding, covering the target display — and the mascot performs before
// merging into the bar. Two variants:
//
//   'game'    the full first-install number below (chase game included) —
//             plays exactly once, on the onboarding "Launch Rax".
//   'glance'  the everyday opener: materialize, take a good look at the
//             screen for a few seconds (squint-read + radar pings sweeping
//             the desktop), then the same aim/crouch/leap home. No chase.
//
// The full 'game' flow:
//
//   materialize   tumbles out of thin air — drop + unscrew + overshoot pop,
//                 perks up awake
//   analyze       his 'transcribing' squint-and-read + a radar ping —
//                 reading your desktop
//   game          "click on me!" — and he means it: his eyes track your
//                 cursor (the Mascot's built-in cursor-gaze, fed by the
//                 forwarded mousemoves), and the moment the pointer gets
//                 close he ZIPS somewhere else — afterimage ghosts trailing
//                 the dash, an overshoot-skid arrival plop — leaving a
//                 ripple where he was. The cursor can never touch him. The
//                 taunts escalate per dodge; after three he calls it. If
//                 you don't take the bait he gets bored and leaves.
//   aim…crouch    anticipation: he rises and leans back eyeing the seat,
//                 then loads a deep crouch…
//   leap          …and EXPLODES up a bezier arc (ease-out: all the crouch's
//                 energy spent in the first beat), one full backflip,
//                 ghosts streaming, shrinking onto the EXACT seat the notch
//                 mascot occupies, ducking behind the bar (the notch window
//                 sits one level above).
//
// Choreography contract with main: `barCue()` fires at aim — the bar slide
// (~420ms) is long settled before touchdown (~850–1150ms later). `done()`
// fires at touchdown; main releases the notch mascot ('land', a momentum-
// absorbing squash + bar dip — the character reads as continuous) and tears
// this window down.
//
// One rAF drives all continuous motion imperatively (the codebase's
// pattern); React only flips the discrete bits (voice state, perk pulses,
// taunt bubble, pings).

const SIZE = 140

// "Trying to click him" = cursor within this many px of his center. Generous
// on purpose: he must be gone before a click could ever land.
const DODGE_RADIUS = 132
// Breather between dodges, measured from dodge START — must barely outlive
// the dash itself (150–240ms): the mid-dash guard already stops spam, and a
// longer cooldown opens a post-landing window where a committed cursor can
// sit ON him (seen on the harness contact sheet at 340ms).
const DODGE_COOLDOWN_MS = 200
const DODGES_TO_WIN = 3
// No chase? He waits this long per taunt, then leaves on his own.
const BOREDOM_MS = 4200
// Hard ceiling on the whole game phase regardless of dodge count.
const GAME_DEADLINE_MS = 7500

const TAUNTS = ['click on me!', 'try again!', 'haha — got you!', 'okay okay, gotta go!'] as const
const BORED_FAREWELL = 'catch me up there!'

interface PlayPayload {
  seat: { x: number; y: number; size: number }
  display: { x: number; y: number; width: number; height: number }
  colorId: string
  variant: 'game' | 'glance'
  cursor: { x: number; y: number }
}

interface IntroAPI {
  ready(): void
  onPlay(callback: (payload: PlayPayload) => void): () => void
  barCue(): void
  done(): void
}

const intro = (window as unknown as { intro: IntroAPI }).intro

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v: number) => clamp(v, 0, 1)
const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3)
const easeOutBack = (t: number, k = 1.55) => {
  const c = clamp01(t)
  return 1 + (k + 1) * Math.pow(c - 1, 3) + k * Math.pow(c - 1, 2)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (t: number) => {
  const c = clamp01(t)
  return c * c * (3 - 2 * c)
}
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by)

// Anticipation beats before the leap: rise-and-aim, then load the crouch.
const AIM_MS = 230
const CROUCH_MS = 170

type Phase = 'materialize' | 'analyze' | 'game' | 'farewell' | 'aim' | 'crouch' | 'leap' | 'gone'

/** Somewhere fun to zip to: on-screen with margins, well away from BOTH the
 *  cursor (so the next try is a real chase) and his current spot (so the
 *  dash reads as a dash). Best-of-N random sampling. */
function pickDodgeTarget(
  W: number,
  H: number,
  cur: { x: number; y: number },
  cursor: { x: number; y: number },
): { x: number; y: number } {
  let best = { x: W / 2, y: H / 2 }
  let bestScore = -Infinity
  for (let i = 0; i < 10; i++) {
    const x = W * (0.14 + 0.72 * Math.random())
    const y = H * (0.2 + 0.56 * Math.random())
    const dCursor = dist(x, y, cursor.x, cursor.y)
    const dSelf = dist(x, y, cur.x, cur.y)
    let score = Math.min(dCursor, 460) + Math.min(dSelf, 420) * 0.7 - Math.abs(x - W / 2) * 0.06
    if (dCursor < 220) score -= 600 // never land beside the cursor
    if (dSelf < 240) score -= 350 // a hop, not a shuffle
    if (score > bestScore) {
      bestScore = score
      best = { x, y }
    }
  }
  return best
}

/** First-install spawn: somewhere comfortable around the center, but never
 *  near the cursor — a mascot materializing under a parked pointer would
 *  burn the first dodge before the user even meant to play. Same best-of-N
 *  sampling idea as pickDodgeTarget, biased toward the center. */
function pickSpawnPoint(W: number, H: number, cursor: { x: number; y: number }): { x: number; y: number } {
  let best = { x: W / 2, y: H * 0.44 }
  let bestScore = -Infinity
  for (let i = 0; i < 14; i++) {
    const x = W * (0.28 + 0.44 * Math.random())
    const y = H * (0.28 + 0.34 * Math.random())
    const dCursor = dist(x, y, cursor.x, cursor.y)
    const dCenter = dist(x, y, W / 2, H * 0.44)
    let score = Math.min(dCursor, 520) - dCenter * 0.55
    // Comfortably clear of DODGE_RADIUS — a hand twitch must not read as a
    // chase. Hard penalty, not a hard fail: best-of-N still returns the
    // least-bad spot when the cursor parks dead center on a small display.
    if (dCursor < 280) score -= 1000
    if (score > bestScore) {
      bestScore = score
      best = { x, y }
    }
  }
  return best
}

function IntroApp() {
  const [play, setPlay] = useState<PlayPayload | null>(null)
  const [mState, setMState] = useState<VoiceState>('idle')
  const [perky, setPerky] = useState(false)
  const [bubble, setBubble] = useState<{ text: string; key: number; out?: boolean } | null>(null)
  const [pings, setPings] = useState<Array<{ id: number; x: number; y: number; size: number }>>([])
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const off = intro.onPlay((p) => setPlay(p))
    intro.ready()
    return off
  }, [])

  useEffect(() => {
    if (!play) return

    // Vestibular safety: no cameo under prefers-reduced-motion — cue the
    // bar (which fades in plainly) and report done.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      intro.barCue()
      const t = window.setTimeout(() => intro.done(), 600)
      return () => clearTimeout(t)
    }

    const W = play.display.width
    const H = play.display.height
    const ex = play.seat.x - play.display.x + play.seat.size / 2
    const ey = play.seat.y - play.display.y + play.seat.size / 2
    const endScale = play.seat.size / SIZE
    const isGlance = play.variant === 'glance'
    // Where the pointer was at summon time (display-relative; far off-screen
    // if a stale payload ever arrives without it — that reads as "no cursor
    // anywhere near", which degrades to the old center spawn).
    const cursor0 = play.cursor
      ? { x: play.cursor.x - play.display.x, y: play.cursor.y - play.display.y }
      : { x: -1e4, y: -1e4 }
    // The game spawns clear of the pointer (the chase must start on purpose);
    // the glance has no dodge, so it keeps the classic center entrance.
    const spawn = isGlance ? { x: W / 2, y: H * 0.44 } : pickSpawnPoint(W, H, cursor0)

    // ── Mutable motion model (rAF-owned; React never sees per-frame data) ──
    const M = {
      phase: 'materialize' as Phase,
      phaseAt: 0,
      pos: { x: spawn.x, y: spawn.y },
      // Seeded with the real pointer so the very first dodge already knows
      // to flee AWAY from it, even if the mouse hasn't moved yet.
      cursor: { x: cursor0.x, y: cursor0.y, at: -1e9 },
      dodge: null as null | { x0: number; y0: number; x1: number; y1: number; t0: number; dur: number },
      // Post-dash arrival plop: a brief brake-squash + counter-lean.
      arrive: null as null | { t: number; dir: number },
      dodgeCount: 0,
      lastDodgeAt: -1e9,
      gameAt: 0,
      leap: null as null | { x0: number; y0: number; cx: number; cy: number; t0: number; dur: number },
      barCued: false,
      doneSent: false,
      pingId: 10,
      // Afterimage trail: recent wrap transforms; ghosts replay them lagged.
      hist: [] as Array<{ t: number; tf: string; op: number }>,
      ghosts: null as null | HTMLDivElement[],
    }

    // Afterimage ghosts — frozen-pose clones of the SVG trailing the dash /
    // leap by a few frames. Clones reference the live svg's gradient defs by
    // id (url(#…) resolves document-wide), so they paint identically for
    // free; a slight blur sells motion. Spawned fresh per dash so the frozen
    // pose stays current; they fade out and self-remove when the dash ends.
    const spawnGhosts = () => {
      if (M.ghosts) return
      const wrap = wrapRef.current
      const svg = wrap?.querySelector('svg')
      const stage = wrap?.parentElement
      if (!wrap || !svg || !stage) return
      M.ghosts = [0.26, 0.13].map((base) => {
        const g = document.createElement('div')
        g.className = 'intro-ghost'
        g.style.opacity = '0'
        g.dataset.base = String(base)
        const clone = svg.cloneNode(true) as SVGSVGElement
        // The live svg carries an inline drop-shadow (written per frame
        // below) — cleared so the ghost class's motion blur applies instead
        // of two shadowed solid robots.
        clone.style.filter = ''
        g.appendChild(clone)
        stage.insertBefore(g, wrap)
        return g
      })
    }
    const killGhosts = () => {
      if (!M.ghosts) return
      for (const g of M.ghosts) g.remove()
      M.ghosts = null
    }

    const timers: number[] = []
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))
    const perkPulse = (ms = 280) => {
      setPerky(true)
      at(ms, () => setPerky(false))
    }
    const ripple = (x: number, y: number, size: number) => {
      M.pingId += 1
      const id = M.pingId
      setPings((p) => [...p.slice(-4), { id, x, y, size }])
    }
    const say = (text: string) => setBubble({ text, key: performance.now() })
    // Pop the bubble out (scale-fade) instead of yanking it from the DOM.
    const clearBubble = () => {
      setBubble((b) => (b ? { ...b, out: true } : null))
      at(180, () => setBubble(null))
    }

    const setPhase = (phase: Phase, now: number) => {
      M.phase = phase
      M.phaseAt = now
    }

    // ── The flow's discrete beats ──
    const startGame = (now: number) => {
      setPhase('game', now)
      M.gameAt = now
      setMState('idle') // cursor-gaze mode: he WATCHES you line up the click
      say(TAUNTS[0])
      perkPulse(320)
    }

    const startFarewell = (now: number, text: string) => {
      setPhase('farewell', now)
      say(text)
    }

    const startAim = (now: number) => {
      setPhase('aim', now)
      clearBubble()
      if (!M.barCued) {
        M.barCued = true
        intro.barCue() // bar slides in NOW — settled long before touchdown
      }
    }

    const startLeap = (now: number) => {
      const d = dist(M.pos.x, M.pos.y, ex, ey)
      // Flight time scales with distance — a cross-screen swoop shouldn't
      // feel rushed, a short hop shouldn't crawl. Ease-out spends the speed
      // up front, so the clock runs shorter than the old in-out flight.
      const dur = clamp(d / 1.3, 480, 760)
      const side = ex - M.pos.x >= 0 ? -1 : 1
      M.leap = {
        x0: M.pos.x,
        y0: M.pos.y,
        cx: M.pos.x + (ex - M.pos.x) * 0.35 + side * Math.min(140, 40 + d * 0.16),
        cy: M.pos.y + (ey - M.pos.y) * 0.62,
        t0: now,
        dur,
      }
      ripple(M.pos.x, M.pos.y + 30, 180) // push-off ring at the launch point
      spawnGhosts()
      setPhase('leap', now)
    }

    const dodge = (now: number) => {
      if (M.phase !== 'game' && M.phase !== 'analyze') return
      if (now - M.lastDodgeAt < DODGE_COOLDOWN_MS) return
      // Mid-dash he's already untouchable; let the dash finish.
      if (M.dodge && now - M.dodge.t0 < M.dodge.dur) return
      if (M.phase === 'analyze') {
        // Poked before the game even started — game on, that counts.
        startGame(now)
      }
      const target = pickDodgeTarget(W, H, M.pos, M.cursor)
      ripple(M.pos.x, M.pos.y, 210) // he vanishes from here — leave a ripple
      const d = dist(M.pos.x, M.pos.y, target.x, target.y)
      // Dash time scales with distance — constant speed, not constant time.
      M.dodge = { x0: M.pos.x, y0: M.pos.y, x1: target.x, y1: target.y, t0: now, dur: clamp(d * 0.32, 150, 240) }
      M.lastDodgeAt = now
      M.dodgeCount += 1
      spawnGhosts()
      perkPulse(240) // startled little hop + wide eyes
      if (M.dodgeCount >= DODGES_TO_WIN) {
        say(TAUNTS[3])
        at(700, () => startAim(performance.now()))
        setPhase('farewell', now)
      } else {
        say(TAUNTS[Math.min(M.dodgeCount, 2)])
      }
    }

    // Forwarded mousemoves (window is click-through; moves still arrive).
    // This both feeds the dodge game and — via Mascot's own window-mousemove
    // listener — makes his eyes genuinely follow the cursor. The glance
    // variant keeps the cursor-gaze but never dodges: he's reading the
    // screen, not playing.
    const onMove = (e: MouseEvent) => {
      M.cursor.x = e.clientX
      M.cursor.y = e.clientY
      M.cursor.at = performance.now()
      if (
        !isGlance &&
        (M.phase === 'game' || M.phase === 'analyze') &&
        dist(e.clientX, e.clientY, M.pos.x, M.pos.y) < DODGE_RADIUS
      ) {
        dodge(M.cursor.at)
      }
    }
    window.addEventListener('mousemove', onMove)

    // Scripted opening, shared by both variants: materialize → squint-read
    // the desktop…
    at(140, () => perkPulse(340))
    at(560, () => {
      // An eager cursor can start the game before this beat lands — don't
      // squint-scan (or ping his old spot) over an already-running chase.
      if (M.phase !== 'materialize' && M.phase !== 'analyze') return
      setMState('transcribing')
      ripple(spawn.x, spawn.y, 380)
    })
    at(480, () => {
      if (M.phase === 'materialize') setPhase('analyze', performance.now())
    })
    if (isGlance) {
      // …'glance': a good few seconds of looking — radar pings sweep other
      // corners of the desktop while he squint-reads — then a satisfied
      // perk-up and straight home. No game, no taunts.
      at(1350, () => {
        if (M.phase === 'analyze') ripple(W * 0.26, H * 0.3, 320)
      })
      at(1950, () => {
        if (M.phase === 'analyze') ripple(W * 0.74, H * 0.56, 320)
      })
      at(2450, () => {
        if (M.phase !== 'analyze') return
        setMState('idle') // done reading — perk up, eye the seat
        perkPulse(300)
      })
      at(2800, () => {
        if (M.phase === 'analyze') startAim(performance.now())
      })
    } else {
      // …'game': the catch-me-if-you-can chase takes it from here.
      at(1650, () => {
        if (M.phase === 'materialize' || M.phase === 'analyze') startGame(performance.now())
      })
    }

    // ── The one rAF ──
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const el = now - t0
      const wrap = wrapRef.current
      if (!wrap) return
      if (M.phase === 'gone') {
        // Touchdown already reported — hold the final (occluded, faded)
        // frame rather than recomputing a stale pose.
        wrap.style.opacity = '0'
        killGhosts()
        cancelAnimationFrame(raf)
        return
      }

      // Boredom / deadline: nobody's chasing — leave gracefully.
      if (M.phase === 'game') {
        const idleSince = Math.max(M.lastDodgeAt, M.gameAt)
        if (now - idleSince > BOREDOM_MS || now - M.gameAt > GAME_DEADLINE_MS) {
          startFarewell(now, M.dodgeCount > 0 ? TAUNTS[3] : BORED_FAREWELL)
          at(700, () => startAim(performance.now()))
        }
      }
      if (M.phase === 'aim' && now - M.phaseAt >= AIM_MS) setPhase('crouch', now)
      if (M.phase === 'crouch' && now - M.phaseAt >= CROUCH_MS) startLeap(now)

      let cx = M.pos.x
      let cy = M.pos.y
      let scale = 1
      let rot = 0
      let sx = 1
      let sy = 1
      let opacity = 1
      let shadow = 1
      // Velocity-aligned squash & stretch for the dash (deg + amount) —
      // composed as rotate(θ)·scale·rotate(−θ) so a vertical zip stretches
      // vertically instead of going wide.
      let stretchDeg = 0
      let stretchAmt = 0

      // Materialize — drop + unscrew + overshoot pop: he tumbles out of
      // thin air and catches himself, rather than fading while inflating.
      scale *= 0.25 + 0.75 * easeOutBack(el / 420)
      opacity = clamp01(el / 180)
      if (el < 620) {
        cy -= 26 * (1 - easeOutCubic(el / 620))
        rot += -32 * (1 - easeOutBack(el / 560))
      }

      // Levitation bob whenever he's "standing" somewhere — damped through
      // the aim and dead in the crouch, so the launch loads from stillness.
      const bobAmp =
        M.phase === 'leap' || M.phase === 'crouch'
          ? 0
          : M.phase === 'aim'
            ? 1 - smooth((now - M.phaseAt) / AIM_MS)
            : 1
      if (bobAmp > 0) {
        cy += Math.sin(el / 640) * 4 * bobAmp
        // A whisper of sway so hovering never reads as parked.
        cx += Math.sin(el / 1130) * 3 * bobAmp
      }

      // Dash interpolation — fast, leaning into the travel, stretching
      // ALONG the travel through the middle, overshooting the landing spot
      // a touch (easeOutBack) so the arrival reads as a skid-and-catch.
      if (M.dodge) {
        const u = (now - M.dodge.t0) / M.dodge.dur
        if (u >= 1) {
          M.pos.x = M.dodge.x1
          M.pos.y = M.dodge.y1
          M.arrive = { t: now, dir: Math.sign(M.dodge.x1 - M.dodge.x0) || 1 }
          M.dodge = null
        } else {
          const e = easeOutBack(u, 0.9)
          cx = M.dodge.x0 + (M.dodge.x1 - M.dodge.x0) * e
          cy = M.dodge.y0 + (M.dodge.y1 - M.dodge.y0) * e
          const k = Math.sin(Math.PI * clamp01(u))
          const dx = M.dodge.x1 - M.dodge.x0
          const dy = M.dodge.y1 - M.dodge.y0
          const len = Math.hypot(dx, dy) || 1
          rot += (dx / len) * 14 * k // sprinter lean, horizontal component
          stretchDeg = (Math.atan2(dy, dx) * 180) / Math.PI
          stretchAmt = 0.22 * k
          // Track the live position so a mid-dash proximity check is honest.
          M.pos.x = cx
          M.pos.y = cy
        }
      }
      // Arrival plop — brake-squash + counter-lean as he sticks the stop.
      if (M.arrive) {
        const q = (now - M.arrive.t) / 170
        if (q >= 1) M.arrive = null
        else {
          const k = Math.sin(Math.PI * clamp01(q))
          sx *= 1 + 0.1 * k
          sy *= 1 - 0.12 * k
          rot += -M.arrive.dir * 5 * k
        }
      }

      // Anticipation: AIM — rise and lean back, eyeing the seat…
      if (M.phase === 'aim') {
        const u = smooth((now - M.phaseAt) / AIM_MS)
        const side = Math.sign(ex - M.pos.x) || 1
        cy -= 7 * u
        rot += -side * 9 * u
        sy *= 1 + 0.06 * u
        sx *= 1 - 0.04 * u
      }
      // …then CROUCH: load the spring, deep and quick.
      if (M.phase === 'crouch') {
        const u = smooth((now - M.phaseAt) / CROUCH_MS)
        const side = Math.sign(ex - M.pos.x) || 1
        cy += -7 * (1 - u) + 15 * u
        rot += -side * 9 * (1 - u)
        sy *= (1 + 0.06 * (1 - u)) * (1 - 0.34 * u)
        sx *= (1 - 0.04 * (1 - u)) * (1 + 0.25 * u)
      }

      // The leap — one bezier swoop, one full backflip, docking exactly on
      // the seat. Ease-out: ALL the crouch's energy spends in the first
      // beat (the old in-out launch floated off a loaded spring), gliding
      // into the occluded dock.
      if (M.phase === 'leap' && M.leap) {
        const L = M.leap
        const u = 1 - Math.pow(1 - clamp01((now - L.t0) / L.dur), 2.1)
        const quad = (a: number, c: number, b: number, t: number) =>
          (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b
        cx = quad(L.x0, L.cx, ex, u)
        cy = quad(L.y0, L.cy, ey, u)
        scale = 1 + (endScale - 1) * u
        rot = -360 * u
        // The crouch recovers THROUGH a launch streak that relaxes mid-arc.
        const s = now - L.t0
        const stretch = s < 70 ? lerp(-0.34, 0.34, easeOutCubic(s / 70)) : 0.34 * Math.exp(-(s - 70) / 130)
        sy = 1 + stretch
        sx = 1 - stretch * 0.55
        shadow = clamp01(1 - u * 2.2)
        // The last beat happens occluded behind the bar — fade there so the
        // handoff to the notch mascot is invisible.
        opacity = u > 0.9 ? clamp01((1 - u) / 0.1) : 1
        if (u >= 1 && !M.doneSent) {
          M.doneSent = true
          setPhase('gone', now)
          intro.done()
        }
      }
      wrap.style.transform =
        `translate(${(cx - SIZE / 2).toFixed(2)}px, ${(cy - SIZE / 2).toFixed(2)}px) ` +
        `rotate(${rot.toFixed(2)}deg) ` +
        (stretchAmt > 0.001
          ? `rotate(${stretchDeg.toFixed(1)}deg) ` +
            `scale(${(scale * (1 + stretchAmt)).toFixed(4)}, ${(scale * (1 - stretchAmt * 0.6)).toFixed(4)}) ` +
            `rotate(${(-stretchDeg).toFixed(1)}deg)`
          : `scale(${(scale * sx).toFixed(4)}, ${(scale * sy).toFixed(4)})`)
      wrap.style.opacity = opacity.toFixed(3)

      // Afterimages: remember this frame, replay it lagged on the ghosts.
      M.hist.push({ t: now, tf: wrap.style.transform, op: opacity })
      if (M.hist.length > 30) M.hist.shift()
      if (M.ghosts) {
        // (cast: the leap block above can set 'gone' mid-frame — TS's
        // narrowing from the early return doesn't see the mutation)
        const active = M.dodge !== null || (M.phase as Phase) === 'leap'
        const lags = [42, 84]
        let visible = false
        for (let i = 0; i < M.ghosts.length; i++) {
          const g = M.ghosts[i]
          let past: { t: number; tf: string; op: number } | null = null
          for (let h = M.hist.length - 1; h >= 0; h--) {
            if (M.hist[h].t <= now - lags[i]) {
              past = M.hist[h]
              break
            }
          }
          const base = parseFloat(g.dataset.base || '0.2')
          const cur = parseFloat(g.style.opacity || '0')
          const next = active && past ? base * past.op : Math.max(0, cur - 0.06)
          if (past) g.style.transform = past.tf
          g.style.opacity = next.toFixed(3)
          if (next > 0.01) visible = true
        }
        if (!active && !visible) killGhosts()
      }
      const svg = wrap.querySelector('svg')
      if (svg) {
        svg.style.filter = `drop-shadow(0 22px 26px rgba(0,0,0,${(0.4 * shadow).toFixed(3)}))`
      }

      // The taunt bubble rides above him (below if he's hugging the top).
      const bub = bubbleRef.current
      if (bub) {
        const half = (SIZE / 2) * scale
        const above = cy - half - 30
        const by = above < 56 ? cy + half + 34 : above
        const bx = clamp(cx, 90, W - 90)
        bub.style.transform = `translate(${bx.toFixed(1)}px, ${by.toFixed(1)}px) translate(-50%, -100%)`
        bub.style.visibility = 'visible'
      }
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMove)
      timers.forEach((t) => clearTimeout(t))
      killGhosts()
    }
  }, [play])

  if (!play) return null
  const ringColor = getMascotColorway(play.colorId).visorLight

  return (
    <div className="intro-stage" aria-hidden>
      {pings.map((p) => (
        <div
          key={p.id}
          className="intro-ping"
          style={{
            left: p.x - p.size / 2,
            top: p.y - p.size / 2,
            width: p.size,
            height: p.size,
            borderColor: ringColor,
          }}
        />
      ))}
      <div ref={wrapRef} className="intro-mascot" style={{ opacity: 0 }}>
        <Mascot
          state={mState}
          hovered={perky}
          stoppable={false}
          analyser={null}
          envelopeRef={null}
          colorId={play.colorId}
          size={SIZE}
        />
      </div>
      {bubble ? (
        <div ref={bubbleRef} className="intro-bubble-anchor">
          <div key={bubble.key} className={`intro-bubble${bubble.out ? ' out' : ''}`}>
            {bubble.text}
          </div>
        </div>
      ) : null}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<IntroApp />)
