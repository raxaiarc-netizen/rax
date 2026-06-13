// Voice catalog for the Grok realtime backend (xAI Voice Agent API).
// Shared between main (session.update payload, config validation) and the
// orb renderer (the notch settings picker).

export interface GrokVoiceMeta {
  id: string
  label: string
}

export const GROK_VOICES: GrokVoiceMeta[] = [
  { id: 'ara', label: 'Ara · warm female' },
  { id: 'eve', label: 'Eve · upbeat female' },
  { id: 'rex', label: 'Rex · confident male' },
  { id: 'leo', label: 'Leo · authoritative male' },
  { id: 'sal', label: 'Sal · smooth neutral' },
]

export const DEFAULT_GROK_VOICE = 'ara'

export function isValidGrokVoice(id: string): boolean {
  return GROK_VOICES.some((v) => v.id === id)
}
