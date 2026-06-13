// Voice catalog for the Gemini Live backend (Google's realtime API).
// Shared between main (setup payload, config validation) and the orb
// renderer (the notch settings picker). Same role as grok-voices.ts.
//
// These are the prebuilt Live API voices; names are case-sensitive in the
// `prebuiltVoiceConfig.voiceName` field.

export interface GeminiVoiceMeta {
  id: string
  label: string
}

export const GEMINI_VOICES: GeminiVoiceMeta[] = [
  { id: 'Aoede', label: 'Aoede · breezy female' },
  { id: 'Leda', label: 'Leda · youthful female' },
  { id: 'Kore', label: 'Kore · firm female' },
  { id: 'Zephyr', label: 'Zephyr · bright female' },
  { id: 'Puck', label: 'Puck · upbeat male' },
  { id: 'Charon', label: 'Charon · deep male' },
  { id: 'Fenrir', label: 'Fenrir · excitable male' },
  { id: 'Orus', label: 'Orus · firm male' },
]

export const DEFAULT_GEMINI_VOICE = 'Aoede'

export function isValidGeminiVoice(id: string): boolean {
  return GEMINI_VOICES.some((v) => v.id === id)
}
