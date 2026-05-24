import { useEffect, useRef } from 'react'

export type OrbState = 'idle' | 'listening' | 'talking'

/**
 * Owner of the mic stream lives in the parent (App.tsx) — the orb opens one
 * stream for recording + VAD, and we share its analyser here so we don't
 * trigger a second OS-level "Microphone in use" indicator. Pass `null` to
 * disable mic-driven visualisation; the canvas falls back to procedural noise
 * so the orb still feels alive.
 */
interface VoiceOrbProps {
  state: OrbState
  size?: number
  /** Shared AnalyserNode driven by the parent's mic stream. */
  analyser?: AnalyserNode | null
  onError?: (error: Error) => void
  /**
   * Performance.now()-ish timestamp at which an auto-screenshot was attached.
   * The orb plays a one-shot 280ms rim-brightness pulse so the user knows
   * their screen was captured. Pass `null` for no flash.
   */
  flashAt?: number | null
  className?: string
  style?: React.CSSProperties
}

const FLASH_DURATION_MS = 280

interface FluidPhase {
  baseAngle: number
  distOffset: number
  sizeNoise: number
  speedJitter: number
}

const BLOB_POINTS = 14
const FREQ_BINS = 64
const INNER_LINES = 14
const FLUID_BLOBS = 4

type RGB = [number, number, number]
type Palette = {
  core: RGB
  mid: RGB
  outer: RGB
  accent: RGB
  ring: RGB
  flow1: RGB
  flow2: RGB
  flow3: RGB
  flow4: RGB
}

// ─── Siri-style palettes ───
// Each state has a primary body gradient (core/mid/outer) plus four "flow"
// colors used by the inner liquid blobs to make the orb feel alive. The
// flow colors are intentionally more saturated than the body gradient — they
// blend additively (screen) so they read as bright, glowing color streams
// inside the orb, not as solid disks.
const PALETTES: Record<OrbState, Palette> = {
  idle: {
    core: [225, 230, 255],
    mid: [125, 135, 235],
    outer: [50, 55, 175],
    accent: [245, 240, 255],
    ring: [160, 170, 255],
    flow1: [150, 130, 255],
    flow2: [110, 165, 255],
    flow3: [205, 140, 255],
    flow4: [125, 205, 255],
  },
  listening: {
    core: [210, 248, 255],
    mid: [40, 195, 255],
    outer: [10, 90, 220],
    accent: [225, 255, 255],
    ring: [80, 220, 255],
    flow1: [110, 225, 255],
    flow2: [60, 180, 255],
    flow3: [160, 250, 235],
    flow4: [90, 140, 255],
  },
  talking: {
    core: [255, 222, 240],
    mid: [255, 110, 200],
    outer: [180, 50, 200],
    accent: [255, 245, 225],
    ring: [255, 155, 220],
    flow1: [255, 130, 200],
    flow2: [255, 180, 145],
    flow3: [225, 130, 255],
    flow4: [255, 205, 230],
  },
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpC = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(lerp(a[0], b[0], t)),
  Math.round(lerp(a[1], b[1], t)),
  Math.round(lerp(a[2], b[2], t)),
]
const lerpP = (a: Palette, b: Palette, t: number): Palette => ({
  core: lerpC(a.core, b.core, t),
  mid: lerpC(a.mid, b.mid, t),
  outer: lerpC(a.outer, b.outer, t),
  accent: lerpC(a.accent, b.accent, t),
  ring: lerpC(a.ring, b.ring, t),
  flow1: lerpC(a.flow1, b.flow1, t),
  flow2: lerpC(a.flow2, b.flow2, t),
  flow3: lerpC(a.flow3, b.flow3, t),
  flow4: lerpC(a.flow4, b.flow4, t),
})
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

function drawSmoothBlob(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  const n = pts.length
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
  }
  ctx.closePath()
}

export function VoiceOrb({ state, size = 280, analyser, flashAt = null, className, style }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Live ref to the parent's analyser so render-loop reads always see the
  // freshest pointer without re-binding the rAF callback.
  const analyserRef = useRef<AnalyserNode | null>(analyser ?? null)
  // Wall-clock at which the screenshot-attached flash should peak. Read on
  // every rAF tick; rebuilt whenever the prop changes (parent uses Date.now()
  // so a new attachment within the same ms still re-arms — the equality check
  // here on the ref guards against duplicate writes).
  const flashStartRef = useRef<number | null>(null)
  // Cast to the explicit ArrayBuffer-backed variant so getByteFrequencyData
  // (which has a stricter signature in newer TS lib defs) accepts it.
  const rawFreqRef = useRef<Uint8Array<ArrayBuffer>>(new Uint8Array(new ArrayBuffer(FREQ_BINS)))
  const freqRef = useRef<Float32Array>(new Float32Array(FREQ_BINS))
  const ampRef = useRef(0)

  const fluidPhasesRef = useRef<FluidPhase[]>([])

  const stateRef = useRef<OrbState>(state)
  const prevStateRef = useRef<OrbState>(state)
  const stateBlendRef = useRef(1)
  const rafRef = useRef<number>(0)
  const startRef = useRef(performance.now())

  // Track state transitions so palette can crossfade
  useEffect(() => {
    if (stateRef.current !== state) {
      prevStateRef.current = stateRef.current
      stateRef.current = state
      stateBlendRef.current = 0
    }
  }, [state])

  // Initialize fluid blob phase offsets once. Each blob orbits the orb
  // center on its own slow path; the phases stagger them so they never
  // bunch up into a single hot spot.
  useEffect(() => {
    const arr: FluidPhase[] = []
    for (let i = 0; i < FLUID_BLOBS; i++) {
      arr.push({
        baseAngle: (i / FLUID_BLOBS) * Math.PI * 2 + Math.random() * 0.5,
        distOffset: Math.random() * Math.PI * 2,
        sizeNoise: Math.random() * Math.PI * 2,
        speedJitter: 0.85 + Math.random() * 0.3,
      })
    }
    fluidPhasesRef.current = arr
  }, [])

  // The mic stream lives in the parent — we just track its analyser pointer.
  useEffect(() => {
    analyserRef.current = analyser ?? null
  }, [analyser])

  // Translate the parent-supplied `flashAt` (Date.now() epoch ms) into a
  // performance.now() origin so the render loop can compare cheaply.
  useEffect(() => {
    if (typeof flashAt === 'number' && flashAt > 0) {
      flashStartRef.current = performance.now()
    } else {
      flashStartRef.current = null
    }
  }, [flashAt])

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let mounted = true

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = container.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    const render = (now: number) => {
      if (!mounted) return
      const t = (now - startRef.current) / 1000
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const cx = w / 2
      const cy = h / 2
      const orbR = size * 0.4

      const target = stateRef.current

      // ─── Audio source: real mic for listening, procedural for talking ───
      let sourceAmp = 0
      if (target === 'listening' && analyserRef.current) {
        // Parent owns the analyser; its fftSize may differ from ours. Resize
        // the read buffer if needed and bucket the bins down to FREQ_BINS so
        // the visual stays in proportion regardless of FFT resolution.
        const a = analyserRef.current
        const binCount = a.frequencyBinCount
        if (rawFreqRef.current.length !== binCount) {
          rawFreqRef.current = new Uint8Array(new ArrayBuffer(binCount))
        }
        a.getByteFrequencyData(rawFreqRef.current)
        const stride = Math.max(1, Math.floor(binCount / FREQ_BINS))
        let sum = 0
        for (let i = 0; i < FREQ_BINS; i++) {
          const start = i * stride
          let bucket = 0
          for (let j = 0; j < stride && start + j < binCount; j++) {
            bucket = Math.max(bucket, rawFreqRef.current[start + j])
          }
          sum += bucket
          freqRef.current[i] = bucket > freqRef.current[i] ? bucket : freqRef.current[i] * 0.88
        }
        sourceAmp = Math.min(1, (sum / (FREQ_BINS * 255)) * 4.2)
      } else if (target === 'listening') {
        // No analyser yet (parent still acquiring mic) — gentle procedural
        // shimmer so the orb doesn't visibly freeze during the brief acquire.
        for (let i = 0; i < FREQ_BINS; i++) freqRef.current[i] *= 0.9
        sourceAmp = 0.18 + Math.sin(t * 1.6) * 0.06
      } else if (target === 'talking') {
        const sentence = (Math.sin(t * 0.45) + 1) / 2
        const word = Math.pow(Math.max(0, Math.sin(t * 2.6 + Math.sin(t * 0.8))), 1.5)
        const syllable = (Math.sin(t * 7.4 + Math.sin(t * 3.1) * 1.6) + 1) / 2
        const jitter = 0.85 + Math.sin(t * 19) * 0.15
        sourceAmp = Math.min(
          1,
          (0.18 + sentence * 0.6) * (0.35 + word * 0.65) * (0.45 + syllable * 0.55) * jitter,
        )
        for (let i = 0; i < FREQ_BINS; i++) {
          const fw = Math.exp(-i / 22)
          const osc =
            (Math.sin(t * (1.3 + i * 0.11) + i * 0.4) + 1) * 0.5 *
            (0.7 + Math.sin(t * (0.7 + i * 0.05)) * 0.3)
          const v = osc * fw * sourceAmp * 255
          freqRef.current[i] = v > freqRef.current[i] ? v : freqRef.current[i] * 0.82
        }
      } else {
        for (let i = 0; i < FREQ_BINS; i++) freqRef.current[i] *= 0.92
        sourceAmp = 0.08 + Math.sin(t * 1.1) * 0.04
      }
      ampRef.current = lerp(ampRef.current, sourceAmp, 0.14)
      const amp = ampRef.current

      // ─── State crossfade ───
      stateBlendRef.current = Math.min(1, stateBlendRef.current + 0.018)
      const blendT = easeOutCubic(stateBlendRef.current)
      const palette = lerpP(PALETTES[prevStateRef.current], PALETTES[target], blendT)

      ctx.clearRect(0, 0, w, h)

      // ─── Compute morphing blob points ───
      // Three-octave noise (low/mid/high) gives the silhouette a more organic,
      // breathing quality vs. the original two-term wobble. Talking deforms
      // most aggressively; idle barely deforms at all.
      const points: { x: number; y: number }[] = []
      const breathFactor = 0.04 + amp * 0.022 + Math.sin(t * 0.6) * 0.01
      const deformK =
        target === 'talking' ? 0.22 : target === 'listening' ? 0.16 : 0.07
      for (let i = 0; i < BLOB_POINTS; i++) {
        const ang = (i / BLOB_POINTS) * Math.PI * 2
        const fIdx = Math.floor((i / BLOB_POINTS) * (FREQ_BINS / 2)) + 4
        const fVal = freqRef.current[fIdx] / 255
        const breath = Math.sin(t * 1.15 + i * 0.5) * breathFactor
        const wobble =
          Math.sin(t * 2.4 + i * 1.3) * 0.022 +
          Math.cos(t * 1.7 - i * 0.9) * 0.018 +
          Math.sin(t * 3.4 + i * 2.1) * 0.011
        const radius = orbR * (1 + breath + wobble + fVal * deformK + amp * 0.05)
        points.push({ x: cx + Math.cos(ang) * radius, y: cy + Math.sin(ang) * radius })
      }

      // ─── Layered rim glow ───
      // Two passes of shadowBlur on the blob shape build a soft outer
      // atmosphere without staining the transparent canvas — shadowBlur
      // fades to alpha 0 at its edge, so empty pixels stay transparent.
      ctx.save()
      ctx.shadowColor = rgba(palette.ring, 0.55)
      ctx.shadowBlur = 56 + amp * 38
      drawSmoothBlob(ctx, points)
      ctx.fillStyle = rgba(palette.mid, 0.18)
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.shadowColor = rgba(palette.mid, 0.95)
      ctx.shadowBlur = 28 + amp * 28
      drawSmoothBlob(ctx, points)
      ctx.fillStyle = rgba(palette.outer, 0.6)
      ctx.fill()
      ctx.restore()

      // ─── Blob body (clipped) ───
      ctx.save()
      drawSmoothBlob(ctx, points)
      ctx.clip()

      // 1. Base radial — light source upper-left, deep colors at the rim
      const lightX = cx - orbR * 0.32
      const lightY = cy - orbR * 0.45
      const baseG = ctx.createRadialGradient(lightX, lightY, 0, cx, cy + orbR * 0.3, orbR * 1.7)
      baseG.addColorStop(0, rgba(palette.core, 1))
      baseG.addColorStop(0.32, rgba(palette.mid, 1))
      baseG.addColorStop(0.85, rgba(palette.outer, 1))
      baseG.addColorStop(1, rgba(palette.outer, 0.9))
      ctx.fillStyle = baseG
      ctx.fillRect(cx - orbR * 1.6, cy - orbR * 1.6, orbR * 3.2, orbR * 3.2)

      // 2. Inner liquid color blobs — 4 small bright blobs that orbit and
      //    blend additively. This is the move that makes the orb feel alive
      //    instead of "static gradient ball." Each blob has its own orbit
      //    speed/direction; sizes pulse with amplitude so the orb visibly
      //    "breathes color" while listening or talking.
      const flowColors: RGB[] = [palette.flow1, palette.flow2, palette.flow3, palette.flow4]
      const phases = fluidPhasesRef.current
      const stateEnergy = target === 'talking' ? 1.25 : target === 'listening' ? 1.05 : 0.8
      ctx.globalCompositeOperation = 'screen'
      for (let i = 0; i < FLUID_BLOBS; i++) {
        const ph = phases[i]
        const orbitR =
          orbR * (0.28 + Math.sin(t * 0.42 + ph.distOffset) * 0.16 + amp * 0.08)
        const orbitSpeed = (0.18 + i * 0.045) * stateEnergy * ph.speedJitter
        const orbitDir = i % 2 === 0 ? 1 : -1
        const angle = ph.baseAngle + t * orbitSpeed * orbitDir
        const bx = cx + Math.cos(angle) * orbitR
        const by = cy + Math.sin(angle) * orbitR
        const blobR =
          orbR * (0.42 + Math.sin(t * 0.85 + ph.sizeNoise) * 0.09 + amp * 0.18)
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, blobR)
        g.addColorStop(0, rgba(flowColors[i], 0.55 + amp * 0.25))
        g.addColorStop(0.45, rgba(flowColors[i], 0.18))
        g.addColorStop(1, rgba(flowColors[i], 0))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(bx, by, blobR, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'

      // 3. Iridescent conic — soap-bubble shimmer, a touch more vibrant than
      //    the original (extra color stops + slightly stronger alphas).
      const conic = (ctx as CanvasRenderingContext2D & {
        createConicGradient?: (start: number, x: number, y: number) => CanvasGradient
      }).createConicGradient
      if (conic) {
        const g = conic.call(ctx, t * 0.32, cx, cy)
        g.addColorStop(0, 'rgba(120,200,255,0.30)')
        g.addColorStop(0.14, 'rgba(255,180,255,0.22)')
        g.addColorStop(0.28, 'rgba(255,220,150,0.26)')
        g.addColorStop(0.42, 'rgba(160,255,210,0.22)')
        g.addColorStop(0.58, 'rgba(180,160,255,0.26)')
        g.addColorStop(0.72, 'rgba(255,170,220,0.22)')
        g.addColorStop(0.88, 'rgba(255,230,180,0.20)')
        g.addColorStop(1, 'rgba(120,200,255,0.30)')
        ctx.globalCompositeOperation = 'overlay'
        ctx.fillStyle = g
        ctx.fillRect(cx - orbR * 1.6, cy - orbR * 1.6, orbR * 3.2, orbR * 3.2)
        ctx.globalCompositeOperation = 'source-over'
      }

      // 4. Caustic light streaks — curved S-shape Bezier sweeps with true
      //    gaussian-blurred edges (ctx.filter). The previous version drew
      //    hard horizontal strips that read as straight bands; these are
      //    organic curves that feather into the surrounding color, like
      //    sun caustics drifting under water. Stroke intensity is tapered
      //    along the path via a linear gradient so each streak fades at
      //    its tips instead of cutting off.
      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      ctx.filter = 'blur(5px)'
      ctx.lineCap = 'round'
      const causticCount = 5
      for (let band = 0; band < causticCount; band++) {
        const phase = t * (0.4 + band * 0.13) + band * 1.7
        const yCenter = cy + Math.sin(phase) * orbR * 0.72
        const tilt = Math.cos(phase * 0.55) * orbR * 0.28
        const flow = Math.sin(phase * 1.2) * orbR * 0.18
        const intensity = 0.16 + (Math.sin(phase * 0.7) + 1) * 0.1 + amp * 0.14

        const sx = cx - orbR * 1.2
        const ex = cx + orbR * 1.2
        const taper = ctx.createLinearGradient(sx, yCenter, ex, yCenter)
        taper.addColorStop(0, rgba(palette.accent, 0))
        taper.addColorStop(0.25, rgba(palette.accent, intensity * 0.6))
        taper.addColorStop(0.5, rgba(palette.accent, intensity))
        taper.addColorStop(0.75, rgba(palette.accent, intensity * 0.6))
        taper.addColorStop(1, rgba(palette.accent, 0))

        ctx.lineWidth = 2.4 + Math.sin(phase * 1.1) * 1.2
        ctx.strokeStyle = taper
        ctx.beginPath()
        ctx.moveTo(sx, yCenter - tilt)
        ctx.bezierCurveTo(
          cx - orbR * 0.4, yCenter + flow,
          cx + orbR * 0.4, yCenter - flow,
          ex, yCenter + tilt,
        )
        ctx.stroke()
      }
      ctx.restore()

      // 5. Frequency-driven inner waves
      ctx.globalAlpha = 0.85
      for (let i = 0; i < INNER_LINES; i++) {
        const y = cy - orbR + (i / (INNER_LINES - 1)) * orbR * 2
        const fIdx = Math.floor((i / INNER_LINES) * FREQ_BINS * 0.7)
        const v = freqRef.current[fIdx] / 255
        if (v < 0.04 && target !== 'idle') continue
        const lineAmp = (target === 'idle' ? 1.5 : v * 7) * (0.6 + amp * 0.6)
        ctx.strokeStyle = rgba(palette.accent, 0.06 + v * 0.18)
        ctx.lineWidth = 0.8
        ctx.beginPath()
        for (let x = -orbR; x <= orbR; x += 4) {
          const sx = cx + x
          const wave = Math.sin(t * 4.2 + x * 0.05 + i * 0.7) * lineAmp
          if (x === -orbR) ctx.moveTo(sx, y + wave)
          else ctx.lineTo(sx, y + wave)
        }
        ctx.stroke()
      }
      ctx.globalAlpha = 1

      // 6. Specular kiss — top-left bright highlight
      const specG = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, orbR * 0.78)
      specG.addColorStop(0, rgba(palette.accent, 0.6))
      specG.addColorStop(0.45, rgba(palette.accent, 0.13))
      specG.addColorStop(1, rgba(palette.accent, 0))
      ctx.fillStyle = specG
      ctx.fillRect(0, 0, w, h)

      // 7. Secondary specular — small lower-right kiss to give a sense of
      //    a curved reflective surface, not a flat disc.
      const spec2X = cx + orbR * 0.42
      const spec2Y = cy + orbR * 0.28
      const spec2G = ctx.createRadialGradient(spec2X, spec2Y, 0, spec2X, spec2Y, orbR * 0.34)
      spec2G.addColorStop(0, rgba(palette.accent, 0.28))
      spec2G.addColorStop(0.55, rgba(palette.accent, 0.06))
      spec2G.addColorStop(1, rgba(palette.accent, 0))
      ctx.fillStyle = spec2G
      ctx.fillRect(0, 0, w, h)

      // 8. Inner core — bright pulsing heart that reacts to amplitude
      const coreR = orbR * (0.22 + amp * 0.46)
      const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.5)
      coreG.addColorStop(0, rgba(palette.accent, 0.65 + amp * 0.35))
      coreG.addColorStop(0.4, rgba(palette.core, 0.32))
      coreG.addColorStop(1, rgba(palette.core, 0))
      ctx.fillStyle = coreG
      ctx.beginPath()
      ctx.arc(cx, cy, coreR * 1.5, 0, Math.PI * 2)
      ctx.fill()

      ctx.restore()

      // ─── Edge stroke — thin glowing rim with bloom ───
      ctx.save()
      drawSmoothBlob(ctx, points)
      ctx.strokeStyle = rgba(palette.accent, 0.5)
      ctx.lineWidth = 1
      ctx.shadowColor = rgba(palette.ring, 0.9)
      ctx.shadowBlur = 12
      ctx.stroke()
      ctx.restore()

      // ─── Screenshot-attached flash (one-shot rim pulse) ───
      // When the auto-screenshot pipeline pre-captures the user's screen, we
      // play a brief white-rim bloom so the user knows their screen was just
      // seen. Ease-in-out 0→1→0 across FLASH_DURATION_MS. Silent — no sound.
      const fStart = flashStartRef.current
      if (fStart !== null) {
        const age = now - fStart
        if (age >= 0 && age <= FLASH_DURATION_MS) {
          const tFlash = age / FLASH_DURATION_MS
          const ease = 1 - (2 * tFlash - 1) ** 2 // 0→1→0
          ctx.save()
          drawSmoothBlob(ctx, points)
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.55 * ease})`
          ctx.lineWidth = 2.4
          ctx.shadowColor = `rgba(255, 255, 255, ${0.95 * ease})`
          ctx.shadowBlur = 30 + 22 * ease
          ctx.stroke()
          ctx.restore()
        } else if (age > FLASH_DURATION_MS) {
          flashStartRef.current = null
        }
      }

      rafRef.current = requestAnimationFrame(render)
    }

    rafRef.current = requestAnimationFrame(render)
    return () => {
      mounted = false
      ro.disconnect()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [size])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: size * 2,
        height: size * 2,
        position: 'relative',
        ...style,
      }}
      role="img"
      aria-label={`Voice orb — ${state}`}
    >
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  )
}
