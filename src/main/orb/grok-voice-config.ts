import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { DEFAULT_GROK_VOICE, isValidGrokVoice } from '../../shared/grok-voices'
import { log as _log } from '../logger'

export { DEFAULT_GROK_VOICE, isValidGrokVoice }

function log(msg: string): void {
  _log('GrokVoiceConfig', msg)
}

// ─── Grok voice agent settings ───
//
// The notch's alternative voice backend: xAI's realtime speech-to-speech
// agent replaces the whole whisper → claude → Kokoro pipeline when enabled.
// OFF by default — the local pipeline stays the product default; this is an
// opt-in flipped from the notch settings panel.
//
// Same persistence shape as the TTS voice / mascot color settings: a tiny
// userData JSON owned by main, pushed to the orb window on renderer-ready
// and on every change. The file carries the user's xAI API key, so it is
// written 0o600 and the key itself is never shipped back to the renderer —
// only `hasKey` + a short tail for the settings field placeholder.

export interface GrokVoiceConfig {
  enabled: boolean
  apiKey: string
  voice: string
  /** Hold-to-talk mode: the session only hears you while ⌥R is held, and the
   *  model answers on release (manual turn-taking instead of server VAD).
   *  OFF by default — the open-mic continuous conversation stays the
   *  realtime default. */
  pushToTalk: boolean
}

/** What the renderer is allowed to see (no key material). */
export interface PublicGrokVoiceConfig {
  enabled: boolean
  voice: string
  pushToTalk: boolean
  hasKey: boolean
  /** Last 4 chars of the stored key for the settings placeholder ("…abcd"). */
  keyTail: string
}

/** Realtime model id. Overridable for future model bumps without a rebuild. */
export const GROK_REALTIME_MODEL = process.env.RAX_GROK_VOICE_MODEL || 'grok-voice-latest'

function configFile(): string {
  return join(app.getPath('userData'), 'grok-voice.json')
}

let cached: GrokVoiceConfig | null = null

export function getGrokVoiceConfig(): GrokVoiceConfig {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf-8')) as Partial<GrokVoiceConfig>
    cached = {
      enabled: parsed.enabled === true,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      voice:
        typeof parsed.voice === 'string' && isValidGrokVoice(parsed.voice)
          ? parsed.voice
          : DEFAULT_GROK_VOICE,
      pushToTalk: parsed.pushToTalk === true,
    }
    return cached
  } catch {
    cached = { enabled: false, apiKey: '', voice: DEFAULT_GROK_VOICE, pushToTalk: false }
    return cached
  }
}

/**
 * Merge-write a partial update. Returns the new config, or null when the
 * disk write failed (the in-memory state is still updated so the session
 * works until next launch — same contract as the voice/color settings).
 */
export function saveGrokVoiceConfig(partial: Partial<GrokVoiceConfig>): GrokVoiceConfig | null {
  const next: GrokVoiceConfig = { ...getGrokVoiceConfig() }
  if (typeof partial.enabled === 'boolean') next.enabled = partial.enabled
  if (typeof partial.apiKey === 'string') next.apiKey = partial.apiKey.trim()
  if (typeof partial.voice === 'string' && isValidGrokVoice(partial.voice)) next.voice = partial.voice
  if (typeof partial.pushToTalk === 'boolean') next.pushToTalk = partial.pushToTalk
  cached = next
  try {
    // 0o600 — the file carries the user's xAI API key.
    writeFileSync(configFile(), JSON.stringify({ ...next }), { encoding: 'utf-8', mode: 0o600 })
    return next
  } catch (err) {
    log(`Failed to persist grok voice config: ${(err as Error).message}`)
    return null
  }
}

export function publicGrokConfig(): PublicGrokVoiceConfig {
  const cfg = getGrokVoiceConfig()
  return {
    enabled: cfg.enabled,
    voice: cfg.voice,
    pushToTalk: cfg.pushToTalk,
    hasKey: cfg.apiKey.length > 0,
    keyTail: cfg.apiKey.length >= 8 ? cfg.apiKey.slice(-4) : '',
  }
}
