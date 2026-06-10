// ─── Earcons ───
// A warm "pluck" voice modeled on HeyClicky's produced cues (analyzed from
// the real waveforms: bright ~15ms transient + warm sine body with a slight
// downward glide + sub partial, fast 1–2 note figures, soft attacks). No
// assets shipped — everything is synthesized in WebAudio.
//
//   listen-start    rising C5→A5 pluck pair    "you have the floor"
//   listen-end      single F5 tap              "got it, processing"
//   turn-done       warm low G3→D4 pair        "finished speaking"
//   barge-in        bright micro tick          "we heard you, switching"
//   mishear         muted E4 double            "didn't catch that"
//   error           dark B3→F3 fall            "something went wrong"
//   listen-cap      E5 double tap              "i kept listening as long as i can"
//
// All cues share one lazy AudioContext and a short damped feedback delay
// for a touch of room. Levels are deliberately low — these should register,
// never demand attention.

let sharedCtx: AudioContext | null = null
let shimmerBus: GainNode | null = null
let noiseBuf: AudioBuffer | null = null
let suspendTimer: number | null = null

// The cues are sub-second one-shots, but a running AudioContext keeps an
// audio render thread alive 24/7 in an always-on-screen window. Park it a
// few seconds after the last cue (covers the longest decay + shimmer tail);
// getCtx resumes it on the next one.
const SUSPEND_AFTER_MS = 5000

function armSuspend(): void {
  if (suspendTimer) clearTimeout(suspendTimer)
  suspendTimer = window.setTimeout(() => {
    suspendTimer = null
    if (sharedCtx && sharedCtx.state === 'running') {
      sharedCtx.suspend().catch(() => {})
    }
  }, SUSPEND_AFTER_MS)
}

function getCtx(): AudioContext | null {
  try {
    if (!sharedCtx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      sharedCtx = new Ctor()
    }
    if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {})
    return sharedCtx
  } catch {
    return null
  }
}

// Short damped feedback delay (~90ms, 18%) — just enough air to lift the
// plucks off "dry sine in a lab" without an audible echo.
function getShimmer(ctx: AudioContext): GainNode {
  if (shimmerBus) return shimmerBus
  const input = ctx.createGain()
  const delay = ctx.createDelay(0.3)
  delay.delayTime.value = 0.09
  const feedback = ctx.createGain()
  feedback.gain.value = 0.18
  const damp = ctx.createBiquadFilter()
  damp.type = 'lowpass'
  damp.frequency.value = 1500
  const wet = ctx.createGain()
  wet.gain.value = 0.12

  input.connect(ctx.destination)
  input.connect(delay)
  delay.connect(damp)
  damp.connect(feedback)
  feedback.connect(delay)
  damp.connect(wet)
  wet.connect(ctx.destination)

  shimmerBus = input
  return input
}

// 60ms of white noise, reused for every transient tick.
function getNoise(ctx: AudioContext): AudioBuffer {
  if (noiseBuf) return noiseBuf
  const len = Math.floor(ctx.sampleRate * 0.06)
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate)
  const ch = noiseBuf.getChannelData(0)
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1
  return noiseBuf
}

interface PluckSpec {
  /** Fundamental frequency, Hz. */
  freq: number
  /** Offset from the call, seconds. */
  at?: number
  /** Peak gain of the body. */
  peak?: number
  /** Body decay, seconds. */
  decay?: number
  /** Attack, seconds — Clicky's cues ease in (~15–25ms), they don't snap. */
  attack?: number
  /** Lowpass cutoff for the body — lower = duller/warmer. */
  bright?: number
  /** Transient tick gain (0 disables). */
  tick?: number
}

// The voice: fundamental sine with a slight downward glide (-2.5%) + warm
// sub an octave below + a quiet 2nd partial, through a lowpass; topped with
// a tiny high blip + band-passed noise click for the "pluck" onset.
function pluck(spec: PluckSpec): void {
  const ctx = getCtx()
  if (!ctx) return
  const {
    freq,
    at = 0,
    peak = 0.06,
    decay = 0.22,
    attack = 0.018,
    bright = 2200,
    tick = 0.35,
  } = spec
  const start = ctx.currentTime + at
  const bus = getShimmer(ctx)

  // ── Body ──
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = bright
  filter.Q.value = 0.4

  const env = ctx.createGain()
  env.gain.setValueAtTime(0, start)
  env.gain.linearRampToValueAtTime(1, start + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay)

  // Sub octave — the "warm body" in Clicky's cues. Below ~300Hz the sub
  // lands under a MacBook speaker's cutoff, where it only wastes headroom
  // and intermodulates; halve it there (still audible on headphones).
  const subGain = freq < 300 ? 0.18 : 0.35
  const partials: ReadonlyArray<readonly [ratio: number, gain: number]> = [
    [1, 1],
    [0.5, subGain],
    [2, 0.16],
  ]
  for (const [ratio, pGain] of partials) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    const f = freq * ratio
    osc.frequency.setValueAtTime(f, start)
    // Slight downward glide reads as a struck/plucked string settling.
    osc.frequency.exponentialRampToValueAtTime(f * 0.975, start + attack + decay)
    const g = ctx.createGain()
    g.gain.value = peak * pGain
    osc.connect(g).connect(filter)
    osc.start(start)
    osc.stop(start + attack + decay + 0.05)
  }
  filter.connect(env).connect(bus)

  // ── Transient tick ──
  if (tick > 0) {
    // High sine blip ~3 octaves up, 18ms.
    const blip = ctx.createOscillator()
    blip.type = 'sine'
    blip.frequency.value = Math.min(freq * 6, 2400)
    const blipG = ctx.createGain()
    blipG.gain.setValueAtTime(0, start)
    blipG.gain.linearRampToValueAtTime(peak * tick * 0.5, start + 0.004)
    blipG.gain.exponentialRampToValueAtTime(0.0001, start + 0.022)
    blip.connect(blipG).connect(bus)
    blip.start(start)
    blip.stop(start + 0.05)

    // Band-passed noise click, 12ms.
    const noise = ctx.createBufferSource()
    noise.buffer = getNoise(ctx)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1800
    bp.Q.value = 1.2
    const nG = ctx.createGain()
    nG.gain.setValueAtTime(peak * tick * 0.4, start)
    nG.gain.exponentialRampToValueAtTime(0.0001, start + 0.012)
    noise.connect(bp).connect(nG).connect(bus)
    noise.start(start)
    noise.stop(start + 0.05)
  }

  armSuspend()
}

// ─── Public cues ───

// Rising pair, modeled on Clicky's question figure (C5 → high). Friendly
// "go ahead" — soft attack so it never startles.
export function playListenStart(): void {
  pluck({ freq: 523, peak: 0.05, decay: 0.16, tick: 0.25 }) // C5
  pluck({ freq: 880, at: 0.085, peak: 0.055, decay: 0.3 }) // A5
}

// Single tap in Clicky's enter.mp3 register (~F5). Understated "got it".
export function playListenEnd(): void {
  pluck({ freq: 698, peak: 0.05, decay: 0.24, tick: 0.25 }) // F5
}

// Warm low rising fifth — the "settled" completion figure, echoing
// agent-done's low-register warmth. Quiet; plays when speech audibly ends.
// Peaks run hotter than the high cues: equal-loudness means G3/D4 need the
// extra level to register on MacBook speakers at all.
export function playTurnDone(): void {
  pluck({ freq: 196, peak: 0.085, decay: 0.4, bright: 1400, tick: 0.15 }) // G3
  pluck({ freq: 294, at: 0.12, peak: 0.08, decay: 0.55, bright: 1500, tick: 0 }) // D4
}

// Micro tick only — acknowledge the interruption, stay out of the way.
export function playBargeIn(): void {
  pluck({ freq: 1175, peak: 0.03, decay: 0.07, attack: 0.004, tick: 0.6 }) // D6
}

// Muted same-note double — "didn't catch that", deliberately not an error.
export function playMishear(): void {
  pluck({ freq: 330, peak: 0.045, decay: 0.18, bright: 1200, tick: 0.15 }) // E4
  pluck({ freq: 330, at: 0.11, peak: 0.04, decay: 0.28, bright: 1100, tick: 0 }) // E4
}

// Dark falling pair. Authoritative but never harsh. Hotter peaks for the
// same equal-loudness reason as turn-done — B3/F3 vanish on small drivers.
export function playError(): void {
  pluck({ freq: 247, peak: 0.09, decay: 0.3, bright: 1100, tick: 0.2 }) // B3
  pluck({ freq: 175, at: 0.13, peak: 0.085, decay: 0.5, bright: 950, tick: 0 }) // F3
}

// Hit the 30s cap — same-note double in the upper register, distinct from
// the listen-end tap.
export function playListenCap(): void {
  pluck({ freq: 659, peak: 0.045, decay: 0.16, tick: 0.2 }) // E5
  pluck({ freq: 659, at: 0.12, peak: 0.045, decay: 0.3, tick: 0 }) // E5
}
