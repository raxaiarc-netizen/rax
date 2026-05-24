/**
 * The 28 voices bundled with Kokoro-82M v1.0. Hardcoded so the renderer can
 * populate the Settings dropdown without round-tripping through the main
 * process or waiting for the model to load.
 *
 * Source: kokoro-js@1.2.1's internal `voices` map. Update this if you swap
 * to a newer Kokoro release. Keep `id` values stable — they're persisted to
 * localStorage and to `<userData>/orb-tts-voice.json`.
 */

export type KokoroGender = 'Female' | 'Male'
export type KokoroLanguage = 'en-us' | 'en-gb'
/** Kokoro's own subjective rating (A through F). Used to sort the
 *  Settings dropdown so the natural-sounding voices float to the top. */
export type KokoroGrade =
  | 'A+' | 'A' | 'A-'
  | 'B+' | 'B' | 'B-'
  | 'C+' | 'C' | 'C-'
  | 'D+' | 'D' | 'D-'
  | 'F+' | 'F'

export interface KokoroVoice {
  id: string
  name: string
  gender: KokoroGender
  language: KokoroLanguage
  /** Kokoro's `overallGrade` for this voice (combination of quality + style). */
  overallGrade: KokoroGrade
}

export const KOKORO_VOICES: readonly KokoroVoice[] = [
  // ─── en-us · Female ──────────────────────────────────────────────────
  { id: 'af_heart',    name: 'Heart',    gender: 'Female', language: 'en-us', overallGrade: 'A'  },
  { id: 'af_bella',    name: 'Bella',    gender: 'Female', language: 'en-us', overallGrade: 'A-' },
  { id: 'af_nicole',   name: 'Nicole',   gender: 'Female', language: 'en-us', overallGrade: 'B-' },
  { id: 'af_aoede',    name: 'Aoede',    gender: 'Female', language: 'en-us', overallGrade: 'C+' },
  { id: 'af_kore',     name: 'Kore',     gender: 'Female', language: 'en-us', overallGrade: 'C+' },
  { id: 'af_sarah',    name: 'Sarah',    gender: 'Female', language: 'en-us', overallGrade: 'C+' },
  { id: 'af_alloy',    name: 'Alloy',    gender: 'Female', language: 'en-us', overallGrade: 'C'  },
  { id: 'af_nova',     name: 'Nova',     gender: 'Female', language: 'en-us', overallGrade: 'C'  },
  { id: 'af_sky',      name: 'Sky',      gender: 'Female', language: 'en-us', overallGrade: 'C-' },
  { id: 'af_jessica',  name: 'Jessica',  gender: 'Female', language: 'en-us', overallGrade: 'D'  },
  { id: 'af_river',    name: 'River',    gender: 'Female', language: 'en-us', overallGrade: 'D'  },

  // ─── en-us · Male ────────────────────────────────────────────────────
  { id: 'am_fenrir',   name: 'Fenrir',   gender: 'Male',   language: 'en-us', overallGrade: 'C+' },
  { id: 'am_michael',  name: 'Michael',  gender: 'Male',   language: 'en-us', overallGrade: 'C+' },
  { id: 'am_puck',     name: 'Puck',     gender: 'Male',   language: 'en-us', overallGrade: 'C+' },
  { id: 'am_echo',     name: 'Echo',     gender: 'Male',   language: 'en-us', overallGrade: 'D'  },
  { id: 'am_eric',     name: 'Eric',     gender: 'Male',   language: 'en-us', overallGrade: 'D'  },
  { id: 'am_liam',     name: 'Liam',     gender: 'Male',   language: 'en-us', overallGrade: 'D'  },
  { id: 'am_onyx',     name: 'Onyx',     gender: 'Male',   language: 'en-us', overallGrade: 'D'  },
  { id: 'am_santa',    name: 'Santa',    gender: 'Male',   language: 'en-us', overallGrade: 'D-' },
  { id: 'am_adam',     name: 'Adam',     gender: 'Male',   language: 'en-us', overallGrade: 'F+' },

  // ─── en-gb · Female ──────────────────────────────────────────────────
  { id: 'bf_emma',     name: 'Emma',     gender: 'Female', language: 'en-gb', overallGrade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', gender: 'Female', language: 'en-gb', overallGrade: 'C'  },
  { id: 'bf_alice',    name: 'Alice',    gender: 'Female', language: 'en-gb', overallGrade: 'D'  },
  { id: 'bf_lily',     name: 'Lily',     gender: 'Female', language: 'en-gb', overallGrade: 'D'  },

  // ─── en-gb · Male ────────────────────────────────────────────────────
  { id: 'bm_fable',    name: 'Fable',    gender: 'Male',   language: 'en-gb', overallGrade: 'C'  },
  { id: 'bm_george',   name: 'George',   gender: 'Male',   language: 'en-gb', overallGrade: 'C'  },
  { id: 'bm_lewis',    name: 'Lewis',    gender: 'Male',   language: 'en-gb', overallGrade: 'D+' },
  { id: 'bm_daniel',   name: 'Daniel',   gender: 'Male',   language: 'en-gb', overallGrade: 'D'  },
] as const

/** Voice id used when nothing is persisted and no env override is set. */
export const DEFAULT_KOKORO_VOICE = 'af_heart'

const VOICE_BY_ID = new Map(KOKORO_VOICES.map((v) => [v.id, v] as const))

/** Returns null when `id` isn't a known voice; main-process IPC + persisted
 *  state both go through this so a stale/typo'd id can't crash the orb. */
export function findVoice(id: string | undefined | null): KokoroVoice | null {
  if (!id) return null
  return VOICE_BY_ID.get(id) ?? null
}

export function isValidVoice(id: string | undefined | null): id is string {
  return findVoice(id) !== null
}
