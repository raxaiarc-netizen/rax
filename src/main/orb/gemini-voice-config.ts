import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { DEFAULT_GEMINI_VOICE, isValidGeminiVoice } from '../../shared/gemini-voices'
import { log as _log } from '../logger'

export { DEFAULT_GEMINI_VOICE, isValidGeminiVoice }

function log(msg: string): void {
  _log('GeminiVoiceConfig', msg)
}

// ─── Gemini Live voice agent settings ───
//
// The notch's second realtime backend: Google's Live API speech-to-speech
// agent replaces the whole whisper → claude → Kokoro pipeline when enabled,
// exactly like Grok voice. OFF by default — the local pipeline stays the
// product default; this is an opt-in flipped from the notch settings panel.
// Grok and Gemini are mutually exclusive (main enforces it on SET_CONFIG).
//
// Same persistence shape as grok-voice.json: a tiny userData JSON owned by
// main, pushed to the orb window on renderer-ready and on every change. The
// file carries the user's Google AI API key, so it is written 0o600 and the
// key itself is never shipped back to the renderer — only `hasKey` + a
// short tail for the settings field placeholder.

export interface GeminiVoiceConfig {
  enabled: boolean
  apiKey: string
  voice: string
  /** Stream live frames of the user's screen into the session (Gemini Live
   *  accepts ≤1fps image frames) so the model can SEE the screen
   *  continuously, not just on rax_screenshot. Opt-in — frames cost tokens. */
  screenShare: boolean
  /** Hold-to-talk mode: the session only hears you while ⌥R is held, and the
   *  model answers on release (manual activity signals instead of the Live
   *  API's automatic VAD). OFF by default — open mic stays the realtime
   *  default. */
  pushToTalk: boolean
}

/** What the renderer is allowed to see (no key material). */
export interface PublicGeminiVoiceConfig {
  enabled: boolean
  voice: string
  screenShare: boolean
  pushToTalk: boolean
  hasKey: boolean
  /** Last 4 chars of the stored key for the settings placeholder ("…abcd"). */
  keyTail: string
}

/** Live API model id. Overridable for future model bumps without a rebuild. */
export const GEMINI_LIVE_MODEL =
  process.env.RAX_GEMINI_VOICE_MODEL || 'gemini-3.1-flash-live-preview'

function configFile(): string {
  return join(app.getPath('userData'), 'gemini-voice.json')
}

let cached: GeminiVoiceConfig | null = null

export function getGeminiVoiceConfig(): GeminiVoiceConfig {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf-8')) as Partial<GeminiVoiceConfig>
    cached = {
      enabled: parsed.enabled === true,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      voice:
        typeof parsed.voice === 'string' && isValidGeminiVoice(parsed.voice)
          ? parsed.voice
          : DEFAULT_GEMINI_VOICE,
      screenShare: parsed.screenShare === true,
      pushToTalk: parsed.pushToTalk === true,
    }
    return cached
  } catch {
    cached = {
      enabled: false,
      apiKey: '',
      voice: DEFAULT_GEMINI_VOICE,
      screenShare: false,
      pushToTalk: false,
    }
    return cached
  }
}

/**
 * Merge-write a partial update. Returns the new config, or null when the
 * disk write failed (the in-memory state is still updated so the session
 * works until next launch — same contract as the grok/voice/color settings).
 */
export function saveGeminiVoiceConfig(partial: Partial<GeminiVoiceConfig>): GeminiVoiceConfig | null {
  const next: GeminiVoiceConfig = { ...getGeminiVoiceConfig() }
  if (typeof partial.enabled === 'boolean') next.enabled = partial.enabled
  if (typeof partial.apiKey === 'string') next.apiKey = partial.apiKey.trim()
  if (typeof partial.voice === 'string' && isValidGeminiVoice(partial.voice)) next.voice = partial.voice
  if (typeof partial.screenShare === 'boolean') next.screenShare = partial.screenShare
  if (typeof partial.pushToTalk === 'boolean') next.pushToTalk = partial.pushToTalk
  cached = next
  try {
    // 0o600 — the file carries the user's Google AI API key.
    writeFileSync(configFile(), JSON.stringify({ ...next }), { encoding: 'utf-8', mode: 0o600 })
    return next
  } catch (err) {
    log(`Failed to persist gemini voice config: ${(err as Error).message}`)
    return null
  }
}

export function publicGeminiConfig(): PublicGeminiVoiceConfig {
  const cfg = getGeminiVoiceConfig()
  return {
    enabled: cfg.enabled,
    voice: cfg.voice,
    screenShare: cfg.screenShare,
    pushToTalk: cfg.pushToTalk,
    hasKey: cfg.apiKey.length > 0,
    keyTail: cfg.apiKey.length >= 8 ? cfg.apiKey.slice(-4) : '',
  }
}
