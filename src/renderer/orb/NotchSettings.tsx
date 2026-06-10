import { useRef, useState } from 'react'
import { Play, SpeakerHigh } from '@phosphor-icons/react'
import { KOKORO_VOICES } from '../../shared/kokoro-voices'
import { MASCOT_COLORWAYS } from '../../shared/mascot-colors'

// ─── Notch settings panel ───
//
// The voice agent's controls, inline in the island — HeyClicky-style. When
// the bar expands into settings mode (gear on the left wing), this panel
// renders below the 38px header strip: three compact rows on the bar's own
// black glass, hairline-separated, every control writing through the same
// main-process handlers the fullscreen Settings view uses.
//
//   · Voice         native select (renders as a real macOS menu, so it
//                   floats fine above the always-on-top panel window)
//   · Live captions mini switch — shared `rax-settings` localStorage key;
//                   the caption pill picks the flip up via its storage
//                   listener, no IPC needed
//   · Color         the mascot colorway swatches (Rax blue + the crew)
//
// Pure presentation: state and persistence live in App, which already owns
// the IPC surface and the pushed mascot color.

interface NotchSettingsProps {
  voiceId: string
  onVoiceChange: (id: string) => void
  /** Play a short sample in the selected voice (App routes to main, which
   *  synthesizes with a voice override — the configured voice is untouched). */
  onVoicePreview: (id: string) => Promise<{ ok: boolean; durationMs?: number; error?: string }>
  captionsEnabled: boolean
  onCaptionsChange: (enabled: boolean) => void
  colorId: string
  onColorChange: (id: string) => void
}

// Same grouping/ordering as the fullscreen Settings dropdown — American
// voices first (the default is American), best grades surfacing on top.
const GRADE_ORDER: Record<string, number> = {
  'A+': 0, A: 1, 'A-': 2,
  'B+': 3, B: 4, 'B-': 5,
  'C+': 6, C: 7, 'C-': 8,
  'D+': 9, D: 10, 'D-': 11,
  'F+': 12, F: 13,
}

const VOICE_GROUPS = (() => {
  const byKey: Record<string, typeof KOKORO_VOICES[number][]> = {}
  for (const v of KOKORO_VOICES) {
    const langLabel = v.language === 'en-gb' ? 'British' : 'American'
    const key = `${langLabel} ${v.gender}`
    if (!byKey[key]) byKey[key] = []
    byKey[key].push(v)
  }
  const order = ['American Female', 'American Male', 'British Female', 'British Male']
  return order
    .filter((k) => byKey[k]?.length)
    .map((label) => ({
      label,
      voices: [...byKey[label]].sort(
        (a, b) => (GRADE_ORDER[a.overallGrade] ?? 99) - (GRADE_ORDER[b.overallGrade] ?? 99),
      ),
    }))
})()

export function NotchSettings({
  voiceId,
  onVoiceChange,
  onVoicePreview,
  captionsEnabled,
  onCaptionsChange,
  colorId,
  onColorChange,
}: NotchSettingsProps) {
  // Playing state for the sample button — held for the sample's real length
  // (the invoke resolves at playback start and reports durationMs).
  const [previewing, setPreviewing] = useState(false)
  const previewTimer = useRef(0)
  const handlePreview = () => {
    window.clearTimeout(previewTimer.current)
    setPreviewing(true)
    onVoicePreview(voiceId)
      .then((res) => {
        const ms =
          res?.ok && typeof res.durationMs === 'number' && res.durationMs > 0
            ? Math.min(res.durationMs + 250, 8000)
            : 2200
        previewTimer.current = window.setTimeout(() => setPreviewing(false), ms)
      })
      .catch(() => setPreviewing(false))
  }

  return (
    <div className="notch-settings-rows">
      <div className="notch-settings-row">
        <span className="notch-settings-name">Voice</span>
        <div className="notch-voice-control">
          <button
            type="button"
            className={`notch-gear notch-voice-play${previewing ? ' playing' : ''}`}
            aria-label="Preview this voice"
            title="Hear a sample"
            onClick={handlePreview}
          >
            {previewing ? <SpeakerHigh size={11} weight="fill" /> : <Play size={11} weight="fill" />}
          </button>
          <select
            className="notch-settings-select"
            value={voiceId}
            onChange={(e) => onVoiceChange(e.target.value)}
            aria-label="Orb voice"
          >
            {VOICE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.overallGrade}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      <div className="notch-settings-row">
        <span className="notch-settings-name">Live captions</span>
        <button
          type="button"
          role="switch"
          aria-checked={captionsEnabled}
          aria-label="Live captions"
          className={`notch-toggle${captionsEnabled ? ' on' : ''}`}
          onClick={() => onCaptionsChange(!captionsEnabled)}
        >
          <span className="notch-toggle-dot" />
        </button>
      </div>

      <div className="notch-settings-row">
        <span className="notch-settings-name">Color</span>
        <div className="notch-swatches" role="radiogroup" aria-label="Mascot color">
          {MASCOT_COLORWAYS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={colorId === c.id}
              aria-label={`${c.name} — ${c.tagline}`}
              title={`${c.name} — ${c.tagline}`}
              className={`notch-swatch${colorId === c.id ? ' active' : ''}`}
              style={{ background: `linear-gradient(135deg, ${c.visorLight}, ${c.visorDeep})` }}
              onClick={() => onColorChange(c.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
