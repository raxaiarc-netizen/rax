import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, writeFile, unlink, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { log as _log } from '../logger'
import { DEFAULT_KOKORO_VOICE, isValidVoice } from '../../shared/kokoro-voices'

function log(msg: string): void {
  _log('OrbLocalTTS', msg)
}

/**
 * Single-source-of-truth for the user-chosen voice across orb sessions.
 * Persisted to `<userData>/orb-tts-voice.json` so the choice survives
 * relaunches. The renderer Settings UI calls `setPersistedVoice()` which
 * updates the file AND tells the live TTSManager via setVoice(); on next
 * launch `getLocalTtsConfig()` picks it up at construction.
 *
 * Resolution priority:
 *   1. `RAX_TTS_VOICE` env var — dev override, always wins when set
 *   2. Persisted JSON — what the user last picked in Settings
 *   3. `DEFAULT_KOKORO_VOICE` — first-launch fallback
 */

function voiceStatePath(): string | null {
  try {
    return join(app.getPath('userData'), 'orb-tts-voice.json')
  } catch {
    // app.getPath can throw before app.ready in odd edge cases. The orb
    // doesn't spawn until app.whenReady() so this is defensive.
    return null
  }
}

export function loadPersistedVoice(): string | null {
  const p = voiceStatePath()
  if (!p || !existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    const id = parsed?.voice
    if (typeof id === 'string' && isValidVoice(id)) return id
  } catch (err) {
    log(`failed to read persisted voice: ${(err as Error).message}`)
  }
  return null
}

export function savePersistedVoice(voiceId: string): boolean {
  if (!isValidVoice(voiceId)) return false
  const p = voiceStatePath()
  if (!p) return false
  try {
    writeFileSync(p, JSON.stringify({ voice: voiceId }, null, 2))
    return true
  } catch (err) {
    log(`failed to persist voice: ${(err as Error).message}`)
    return false
  }
}

/**
 * On-device TTS for the orb, powered by Kokoro-82M running purely in Node
 * via `kokoro-js` + onnxruntime-node. There is no Python here — the package
 * ships its own ONNX runtime and tokenizer, and the model weights are
 * fetched once (or pre-staged into `resources/kokoro-cache/` for shipping
 * builds) and cached on disk via transformers.js's filesystem cache.
 *
 * The exported `synthesizeToTempFile()` matches the historical ElevenLabs
 * shape so `TTSManager` doesn't care where the audio came from:
 *
 *   const synth = await synthesizeToTempFile(cfg, text)
 *   await synth.ready            // resolves the moment the WAV is on disk
 *   spawn('afplay', [synth.path]) // play it
 *   // synth.alignment / onAlignmentChange feed the caption-pill karaoke loop
 *
 * Synthesis is in-process: there is no streaming and no per-utterance
 * cancel beyond marking a request `aborted` so its produced audio is
 * dropped. For typical orb sentences (50-200 chars) Kokoro generates at
 * ~2.5x realtime on Apple Silicon, so a 3-second utterance takes ~1.2s to
 * synthesize — well inside the pipeline-depth-2 budget that hides synth
 * latency behind the prior sentence's playback.
 */

/** Per-character alignment for one synthesized utterance. Same shape as
 *  what ElevenLabs used to return — `chars`/`starts`/`ends` are parallel
 *  arrays in seconds-since-audio-start. Index i across all three describes
 *  the same character. Kokoro doesn't expose phoneme timings publicly, so
 *  we distribute the audio's total duration proportionally over input
 *  characters; the caption-pill highlights words on the first-char-passed
 *  boundary and this approximation reads as a smoothly-advancing highlight
 *  rather than per-phoneme exactness. */
export interface CaptionAlignment {
  chars: string[]
  starts: number[]
  ends: number[]
}

export interface SynthesizeResult {
  /** Path to the WAV file. Caller is responsible for `cleanup()`. */
  path: string
  /** Resolves once the response body has fully drained to disk. afplay may
   *  start sooner; this is only used to detect "synthesis errored mid-stream". */
  finished: Promise<void>
  /** Resolves once enough bytes are on disk that afplay can begin reading
   *  without immediate EOF. For local Kokoro the WAV arrives as one blob,
   *  so this fires the moment fs.writeFile callback returns — same instant
   *  as `finished`. */
  ready: Promise<void>
  /** Per-character timings. Populated once (Kokoro doesn't stream
   *  alignment), then immutable. */
  alignment: CaptionAlignment
  /** Subscribe to alignment growth. With Kokoro this fires exactly once,
   *  right after the WAV is written, so the caption pill can render its
   *  per-word highlighting. Returns an unsubscribe. */
  onAlignmentChange(cb: () => void): () => void
  cleanup: () => void
}

export interface LocalTtsConfig {
  /** HuggingFace model id, e.g. `onnx-community/Kokoro-82M-v1.0-ONNX`. */
  modelId: string
  /** ONNX quantization. `q8` (~83 MB) is the shipping default — sounds
   *  indistinguishable from fp32 for orb-length utterances and fits the
   *  DMG bundle budget. Other useful values: `fp16` (better quality, ~165
   *  MB), `q4` (smaller, audible artefacts). */
  dtype: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16'
  /** Kokoro voice id. Examples: `af_heart`, `af_bella`, `af_sarah`,
   *  `am_michael`, `bf_emma`. Override via `RAX_TTS_VOICE`. */
  voice: string
  /** Speed multiplier (1.0 = natural). Override via `RAX_TTS_SPEED`. */
  speed: number
}

/**
 * Build the local-TTS config. There is no "not configured" path the way
 * cloud TTS had — the module is bundled with the orb and either works or
 * fails at model-load time (caller will fall back to the silent path).
 */
export function getLocalTtsConfig(): LocalTtsConfig {
  // Resolution priority: env override → persisted state → default. The
  // env-var path stays for dev convenience ("RAX_TTS_VOICE=foo npm run
  // dev") but Settings UI changes write to the persisted file which the
  // user's installed DMG reads on every launch.
  const envVoice = process.env.RAX_TTS_VOICE
  const persisted = loadPersistedVoice()
  const voice =
    envVoice && isValidVoice(envVoice)
      ? envVoice
      : persisted ?? DEFAULT_KOKORO_VOICE
  return {
    modelId: process.env.RAX_TTS_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX',
    dtype: (process.env.RAX_TTS_DTYPE as LocalTtsConfig['dtype']) || 'q8',
    voice,
    speed: Number(process.env.RAX_TTS_SPEED || '1.0'),
  }
}

/**
 * Resolve the directory where bundled / cached Kokoro model files live.
 *
 * Production (.app bundle): `process.resourcesPath/kokoro-cache` — written
 *   into the DMG by `npm run vendor-kokoro`. Pre-populated so the orb's
 *   first speech doesn't trigger a 100 MB download on a user machine
 *   without network.
 *
 * Development: `<repo>/resources/kokoro-cache` if present, else the
 *   transformers.js default at `node_modules/@huggingface/transformers/
 *   .cache`. The fallback path keeps `npm run dev` working out of the box
 *   on a freshly-cloned tree — the model self-downloads from HF on first
 *   use and is cached for subsequent runs.
 */
function resolveCacheDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'kokoro-cache')

  // Dev path: pick the in-repo `resources/kokoro-cache` if it exists, else
  // the first writable candidate. We always return a concrete path (never
  // empty) so `npm ci` can't wipe an inferred cache inside
  // `node_modules/@huggingface/transformers/.cache` — that's the default
  // transformers.js would use otherwise, and it's blown away on every
  // install.
  const candidates = [
    join(app.getAppPath(), 'resources', 'kokoro-cache'),
    join(process.cwd(), 'resources', 'kokoro-cache'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Nothing on disk yet — fall back to the in-repo location so the
  // first-run download lands there and survives subsequent installs.
  return candidates[0]
}

/** Singleton holding the loaded KokoroTTS instance + the in-flight load
 *  promise so back-to-back `speak()` calls don't trigger parallel loads. */
let kokoroPromise: Promise<unknown> | null = null
let kokoroReady = false
let lastLoadError: Error | null = null

async function getKokoro(cfg: LocalTtsConfig): Promise<any> {
  if (kokoroPromise) return kokoroPromise

  kokoroPromise = (async () => {
    // Clear any error from a prior failed load attempt so a successful
    // retry doesn't leave `lastLoadError` set (which would make
    // `synthesizeToTempFile` throw before it ever reaches the model again).
    lastLoadError = null

    // Dynamic import: avoid paying the kokoro-js + transformers.js load
    // cost (and the wasm runtime init) until the orb actually speaks.
    const [{ KokoroTTS }, transformers] = await Promise.all([
      import('kokoro-js'),
      import('@huggingface/transformers'),
    ])

    // Point transformers.js's cache at our app-controlled location so the
    // packaged DMG's pre-staged model files are picked up directly. We
    // mkdir even in dev so a clean clone with no bundled cache yet still
    // gets a stable cache dir under resources/ instead of inside the npm
    // package (which would get wiped by `npm ci`).
    const cacheDir = resolveCacheDir()
    if (cacheDir) {
      try { mkdirSync(cacheDir, { recursive: true }) } catch {}
      transformers.env.cacheDir = cacheDir
      log(`transformers cacheDir = ${cacheDir}`)
    }
    // In production we want to fail loud if the cache is missing files,
    // not silently kick off a 100 MB download. In dev we keep remote loads
    // enabled so the first run on a clean tree just works.
    if (app.isPackaged) {
      transformers.env.allowRemoteModels = false
    }

    const t0 = Date.now()
    log(`loading kokoro: model=${cfg.modelId} dtype=${cfg.dtype}`)
    const tts = await KokoroTTS.from_pretrained(cfg.modelId, {
      dtype: cfg.dtype,
      device: 'cpu',
    })
    log(`kokoro loaded in ${Date.now() - t0}ms (${Object.keys((tts as any).voices).length} voices)`)

    // Pre-warm with a tiny dummy synth. The first generate() pays a one-
    // time JIT/op-cache cost that's invisible afterwards — paying it here
    // (while the user is still listening to the orb start chime or
    // figuring out what to say) means the first real utterance hits the
    // already-warm fast path. Output is discarded.
    try {
      const tw0 = Date.now()
      await (tts as any).generate('a.', { voice: cfg.voice })
      log(`kokoro pre-warm synth: ${Date.now() - tw0}ms`)
    } catch (err) {
      // Pre-warm failure is non-fatal — the real synth will retry with a
      // proper error path.
      log(`pre-warm synth failed (non-fatal): ${(err as Error).message}`)
    }

    kokoroReady = true
    return tts
  })().catch((err) => {
    lastLoadError = err as Error
    kokoroPromise = null  // allow retry on next speak()
    throw err
  })

  return kokoroPromise
}

/** Eagerly start the model load. Safe to call when the orb window first
 *  opens so the first sentence the user triggers doesn't pay the cold-load
 *  latency. */
export function warmupLocalTts(cfg?: LocalTtsConfig): void {
  getKokoro(cfg ?? getLocalTtsConfig()).catch((err) => {
    log(`warmup failed: ${(err as Error).message}`)
  })
}

/** Tear down (drops the cached model instance — next synth will reload).
 *  Used by TTSManager.shutdown(); cheap no-op if never loaded. */
export function shutdownLocalTts(): void {
  kokoroPromise = null
  kokoroReady = false
  lastLoadError = null
}

/**
 * Distribute a duration across characters, but proportional to character
 * "weight" rather than raw count. Spaces are cheap (they're inter-word
 * gaps); punctuation gets a small post-pause; letters split the rest
 * evenly. Closer to natural speech pacing than raw 1/n.
 *
 * `offsetSeconds` is added to every time so the caption pill's clock
 * starts after any leading silence we kept (or 0 if silence was trimmed).
 */
function proportionalAlignment(
  text: string,
  durationSeconds: number,
  offsetSeconds = 0,
): CaptionAlignment {
  const n = text.length
  if (n === 0 || durationSeconds <= 0) {
    return { chars: [], starts: [], ends: [] }
  }
  // Per-char weights — letters carry the bulk, spaces are tiny, sentence-
  // ending punctuation gets a noticeable share to model end-of-clause
  // pauses. Tuned empirically against trimmed Kokoro output.
  const weights = new Float32Array(n)
  let totalWeight = 0
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    let w: number
    if (c === 32 || c === 9) w = 0.25         // space/tab
    else if (c === 46 || c === 33 || c === 63) w = 1.6  // . ! ?
    else if (c === 44 || c === 59 || c === 58) w = 1.2  // , ; :
    else w = 1.0                              // letter / digit / other
    weights[i] = w
    totalWeight += w
  }
  const perWeight = durationSeconds / Math.max(totalWeight, 1e-6)
  const chars = new Array<string>(n)
  const starts = new Array<number>(n)
  const ends = new Array<number>(n)
  let cursor = offsetSeconds
  for (let i = 0; i < n; i++) {
    chars[i] = text.charAt(i)
    starts[i] = Number(cursor.toFixed(4))
    cursor += weights[i] * perWeight
    ends[i] = Number(cursor.toFixed(4))
  }
  // Clamp the final end exactly to (offset + duration) — Float64 sums of
  // per-weight increments accumulate sub-microsecond drift that the
  // caption pill's rAF loop would otherwise round up to a stray
  // post-end frame.
  ends[n - 1] = Number((offsetSeconds + durationSeconds).toFixed(4))
  return { chars, starts, ends }
}

/**
 * Find the first/last non-silent sample indices using a simple amplitude
 * threshold. Kokoro pads each utterance with ~300 ms of leading and
 * ~400 ms of trailing near-silence; trimming those makes playback feel
 * dramatically snappier and (more importantly) makes the caption-pill
 * karaoke land on actual word starts instead of running ahead by the
 * leading-silence duration.
 *
 * Returns the sample-index range to KEEP. We always keep at least 30 ms
 * (≈720 samples at 24 kHz) of head/tail so consecutive utterances don't
 * butt up against each other with an audible click.
 */
function findSpokenRange(
  samples: Float32Array,
  sampleRate: number,
): { startIdx: number; endIdx: number } {
  const threshold = 0.01    // ~−40 dBFS — well above mic noise floor
  const cushionSamples = Math.floor(0.030 * sampleRate)
  // Minimum spoken duration we'll accept the trim for — anything shorter
  // and afplay may refuse to play, or the playback ends so abruptly the
  // user can't tell something was said. Falling back to the full range is
  // strictly safer than producing a sub-frame WAV.
  const minSpokenSamples = Math.floor(0.080 * sampleRate)
  const n = samples.length

  let startIdx = 0
  while (startIdx < n && Math.abs(samples[startIdx]) < threshold) startIdx++
  startIdx = Math.max(0, startIdx - cushionSamples)

  let endIdx = n - 1
  while (endIdx > startIdx && Math.abs(samples[endIdx]) < threshold) endIdx--
  endIdx = Math.min(n - 1, endIdx + cushionSamples)

  // Reject too-short results: all-silence (endIdx <= startIdx) OR a
  // valid-looking range that's shorter than minSpokenSamples (e.g. a
  // single thump amid silence — bad trim, would clip a real word's
  // attack). Fall back to the full audio so we never produce a WAV
  // afplay refuses.
  if (endIdx - startIdx + 1 < minSpokenSamples) {
    return { startIdx: 0, endIdx: n - 1 }
  }
  return { startIdx, endIdx }
}

/** Encode a Float32Array of mono PCM samples in [-1, 1] as a 16-bit PCM
 *  WAV. Faster than going through kokoro-js's `audio.save()` because we
 *  produce one Buffer and write once. */
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length
  const dataBytes = n * 2
  const buf = Buffer.alloc(44 + dataBytes)
  let p = 0
  // RIFF header
  buf.write('RIFF', p); p += 4
  buf.writeUInt32LE(36 + dataBytes, p); p += 4
  buf.write('WAVE', p); p += 4
  // fmt chunk
  buf.write('fmt ', p); p += 4
  buf.writeUInt32LE(16, p); p += 4
  buf.writeUInt16LE(1, p); p += 2          // PCM
  buf.writeUInt16LE(1, p); p += 2          // mono
  buf.writeUInt32LE(sampleRate, p); p += 4
  buf.writeUInt32LE(sampleRate * 2, p); p += 4 // byte rate
  buf.writeUInt16LE(2, p); p += 2          // block align
  buf.writeUInt16LE(16, p); p += 2         // bits per sample
  // data chunk
  buf.write('data', p); p += 4
  buf.writeUInt32LE(dataBytes, p); p += 4
  // Samples
  for (let i = 0; i < n; i++) {
    let s = samples[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    buf.writeInt16LE((s * 32767) | 0, p)
    p += 2
  }
  return buf
}

/**
 * Synthesize `text` with Kokoro, write the resulting WAV to a temp file,
 * and return a `SynthesizeResult` matching the ElevenLabs-era shape. The
 * whole synth happens in-process — no subprocess, no network — so once
 * the awaited promise resolves the WAV is fully on disk and `ready` /
 * `finished` are already settled.
 *
 * Cancellation: pass an `AbortSignal`. We can't actually interrupt
 * Kokoro's generate() once it's running (no torch-style hook), so an
 * abort just sets a flag and discards the produced audio when it arrives.
 * Worst case: ~300-1200 ms of wasted CPU. The user-facing effect is
 * identical — the caption pill never sees a `segment` for the aborted id.
 *
 * Throws if the model fails to load (e.g. cache miss in packaged build) —
 * caller is expected to catch and route to the orb's silent path.
 */
export async function synthesizeToTempFile(
  config: LocalTtsConfig,
  text: string,
  signal?: AbortSignal,
): Promise<SynthesizeResult> {
  // Failed prior load was a hard error — surface immediately rather than
  // letting subsequent speak() calls hang on a never-resolving promise.
  if (lastLoadError) throw lastLoadError

  const kokoro = await getKokoro(config)
  if (signal?.aborted) throw new Error('aborted')

  const filePath = join(tmpdir(), `rax-orb-tts-${randomUUID()}.wav`)
  const cleanup = (): void => { unlink(filePath, () => {}) }

  // Kokoro's generate is async (the wasm phonemizer + onnx infer both
  // return promises). We don't have a fine-grained abort, so we race the
  // synthesis against the abort signal: if abort wins, we discard the
  // produced audio when (later) it arrives.
  let abortError: Error | null = null
  const abortHook = new Promise<never>((_, reject) => {
    if (!signal) return
    const onAbort = (): void => {
      abortError = new Error('aborted')
      reject(abortError)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  let audio: { audio: Float32Array; sampling_rate: number }
  try {
    audio = await Promise.race([
      kokoro.generate(text, { voice: config.voice }),
      abortHook,
    ])
  } catch (err) {
    cleanup()
    throw err
  }

  // If the abort fired between generate() returning and us getting here,
  // bail rather than handing back an unwanted result.
  if (abortError || signal?.aborted) {
    cleanup()
    throw abortError ?? new Error('aborted')
  }

  // Trim silence from the head and tail. Kokoro pads each utterance with
  // ~300 ms leading and ~400 ms trailing near-silence; keeping it would
  // (a) make every sentence feel sluggish and (b) skew the caption-pill
  // alignment by the leading-silence duration. We keep a 30 ms cushion
  // on each side so back-to-back afplay spawns don't click together.
  const { startIdx, endIdx } = findSpokenRange(audio.audio, audio.sampling_rate)
  const trimmed =
    startIdx === 0 && endIdx === audio.audio.length - 1
      ? audio.audio
      : audio.audio.subarray(startIdx, endIdx + 1)

  const wav = encodeWav(trimmed, audio.sampling_rate)
  const duration = trimmed.length / audio.sampling_rate
  // Char 0's start time is 0 because we've already trimmed leading
  // silence from the audio. The cushion we kept (30 ms) is small enough
  // that the caption pill won't visibly lag.
  const alignment = proportionalAlignment(text, duration)

  // Promises mirror the cloud-era streaming surface so the rest of the
  // pipeline (TTSManager + caption pill) is identical to before.
  let resolveReady!: () => void
  let rejectReady!: (err: Error) => void
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej })
  let resolveFinished!: () => void
  let rejectFinished!: (err: Error) => void
  const finished = new Promise<void>((res, rej) => { resolveFinished = res; rejectFinished = rej })

  const alignmentSubs = new Set<() => void>()
  const onAlignmentChange = (cb: () => void): (() => void) => {
    alignmentSubs.add(cb)
    return () => alignmentSubs.delete(cb)
  }

  writeFile(filePath, wav, (err) => {
    if (err) {
      cleanup()
      // Drop any registered alignment subscribers — the callbacks would
      // otherwise stay rooted on this closure until the SynthesizeResult
      // itself gets GC'd. Cheap to clear here.
      alignmentSubs.clear()
      rejectReady(err)
      rejectFinished(err)
      return
    }
    // Notify alignment subscribers exactly once, with the full timing
    // array. The caption-pill's `tts_alignment` handler replaces (not
    // merges) so this single delivery is enough.
    for (const cb of alignmentSubs) {
      try { cb() } catch (subErr) {
        log(`alignment subscriber threw: ${(subErr as Error).message}`)
      }
    }
    alignmentSubs.clear()
    resolveReady()
    resolveFinished()
  })

  return { path: filePath, ready, finished, alignment, onAlignmentChange, cleanup }
}
