// ─── Earcons ───
// Short oscillator-driven cues that fill the perceptual gap the orb's
// canvas can't on its own — useful when the user isn't looking at the orb.
//
//   listen-start    60ms 880Hz sine        "you have the floor"
//   listen-end      50ms 660Hz sine        "got it, processing"
//   barge-in        30ms 1200Hz blend      "we heard you, switching"
//   mishear         two-note fall          "didn't catch that"
//   error           low triangle pair      "something went wrong"
//   listen-cap      double low chirp       "i kept listening as long as i can"
//
// All share one lazy AudioContext. No assets shipped.

let sharedCtx: AudioContext | null = null

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

interface ToneSpec {
  freq: number
  durationMs: number
  type?: OscillatorType
  peak?: number
  attackMs?: number
  releaseMs?: number
  detuneCents?: number
}

function playTone(spec: ToneSpec, when = 0): void {
  const ctx = getCtx()
  if (!ctx) return
  const {
    freq,
    durationMs,
    type = 'sine',
    peak = 0.16,
    attackMs = 5,
    releaseMs = 25,
    detuneCents = 0,
  } = spec
  const start = ctx.currentTime + when
  const dur = durationMs / 1000
  const attack = attackMs / 1000
  const release = Math.min(releaseMs / 1000, dur - attack)

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  if (detuneCents) osc.detune.value = detuneCents

  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(peak, start + attack)
  gain.gain.setValueAtTime(peak, start + Math.max(attack, dur - release))
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)

  osc.connect(gain).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

export function playListenStart(): void {
  playTone({ freq: 880, durationMs: 60, type: 'sine', peak: 0.18, attackMs: 4, releaseMs: 30 })
}

export function playListenEnd(): void {
  playTone({ freq: 660, durationMs: 50, type: 'sine', peak: 0.15, attackMs: 4, releaseMs: 28 })
}

// Soft click: two stacked, slightly detuned tones with a sharp envelope.
// Detune adds a touch of noise-band character without going full white-noise.
export function playBargeIn(): void {
  playTone({ freq: 1200, durationMs: 30, type: 'triangle', peak: 0.10, attackMs: 2, releaseMs: 16 })
  playTone({ freq: 1200, durationMs: 30, type: 'triangle', peak: 0.06, attackMs: 2, releaseMs: 16, detuneCents: -28 })
}

// "I didn't catch that" — gentle two-note fall. Avoids feeling like an error;
// just a soft "no input registered" cue. ~140ms total.
export function playMishear(): void {
  playTone({ freq: 580, durationMs: 70, type: 'sine', peak: 0.12, attackMs: 4, releaseMs: 40 })
  playTone({ freq: 440, durationMs: 80, type: 'sine', peak: 0.10, attackMs: 4, releaseMs: 50 }, 0.07)
}

// Error tone — low triangle pair, more authoritative than mishear.
// Plays at most once per error edge so we don't spam.
export function playError(): void {
  playTone({ freq: 320, durationMs: 90, type: 'triangle', peak: 0.14, attackMs: 4, releaseMs: 60 })
  playTone({ freq: 240, durationMs: 110, type: 'triangle', peak: 0.12, attackMs: 4, releaseMs: 80 }, 0.09)
}

// "I kept listening as long as I can" — double low chirp, lets the user know
// the cap was hit so they can re-summon and continue.
export function playListenCap(): void {
  playTone({ freq: 520, durationMs: 60, type: 'sine', peak: 0.13, attackMs: 4, releaseMs: 32 })
  playTone({ freq: 520, durationMs: 60, type: 'sine', peak: 0.13, attackMs: 4, releaseMs: 32 }, 0.085)
}
