import { useRef, useState } from 'react'
import { Play, SpeakerHigh } from '@phosphor-icons/react'
import { KOKORO_VOICES } from '../../shared/kokoro-voices'
import { GROK_VOICES } from '../../shared/grok-voices'
import { GEMINI_VOICES } from '../../shared/gemini-voices'
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
//   · Hide / show   read-only ⇧⌘O hint — the notch is on by default at
//                   launch; this row tells you how to dismiss/summon it
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
  /** Grok voice — the realtime speech-to-speech backend (xAI). When ON, the
   *  notch becomes one continuous conversation instead of the local
   *  whisper → claude → Kokoro pipeline. Default off. */
  grokEnabled: boolean
  grokHasKey: boolean
  grokKeyTail: string
  grokVoice: string
  /** Hold-to-talk: the session only hears you while ⌥R is held; release =
   *  the orb answers. OFF = the open-mic continuous conversation. */
  grokPushToTalk: boolean
  onGrokToggle: (enabled: boolean) => void
  onGrokVoiceChange: (id: string) => void
  /** Commit a (non-empty) xAI API key — fired on Enter / blur. */
  onGrokKeySave: (apiKey: string) => void
  onGrokPushToTalkToggle: (enabled: boolean) => void
  /** Gemini Live — the second realtime backend (Google). Mutually exclusive
   *  with the Grok toggle; main flips the other one off. */
  geminiEnabled: boolean
  geminiHasKey: boolean
  geminiKeyTail: string
  geminiVoice: string
  /** Stream live screen frames into the Gemini session so it can SEE the
   *  screen continuously. Live toggle — applies mid-conversation. */
  geminiScreenShare: boolean
  /** Same hold-to-talk contract as grokPushToTalk, for the Gemini backend. */
  geminiPushToTalk: boolean
  onGeminiToggle: (enabled: boolean) => void
  onGeminiVoiceChange: (id: string) => void
  /** Commit a (non-empty) Google AI API key — fired on Enter / blur. */
  onGeminiKeySave: (apiKey: string) => void
  onGeminiScreenShareToggle: (enabled: boolean) => void
  onGeminiPushToTalkToggle: (enabled: boolean) => void
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
  grokEnabled,
  grokHasKey,
  grokKeyTail,
  grokVoice,
  grokPushToTalk,
  onGrokToggle,
  onGrokVoiceChange,
  onGrokKeySave,
  onGrokPushToTalkToggle,
  geminiEnabled,
  geminiHasKey,
  geminiKeyTail,
  geminiVoice,
  geminiScreenShare,
  geminiPushToTalk,
  onGeminiToggle,
  onGeminiVoiceChange,
  onGeminiKeySave,
  onGeminiScreenShareToggle,
  onGeminiPushToTalkToggle,
}: NotchSettingsProps) {
  // Playing state for the sample button — held for the sample's real length
  // (the invoke resolves at playback start and reports durationMs).
  const [previewing, setPreviewing] = useState(false)
  const previewTimer = useRef(0)

  // Key fields are write-only: the stored keys never reach the renderer, so
  // each input drafts locally and commits on Enter/blur. The placeholder
  // shows the saved key's tail as the "it's set" affordance.
  const [keyDraft, setKeyDraft] = useState('')
  const commitKey = () => {
    const v = keyDraft.trim()
    if (!v) return
    onGrokKeySave(v)
    setKeyDraft('')
  }
  const [geminiKeyDraft, setGeminiKeyDraft] = useState('')
  const commitGeminiKey = () => {
    const v = geminiKeyDraft.trim()
    if (!v) return
    onGeminiKeySave(v)
    setGeminiKeyDraft('')
  }
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

      <div className="notch-settings-row">
        <span
          className="notch-settings-name"
          title="Global shortcut — hides the notch bar; press again to bring it back"
        >
          Hide / show notch
        </span>
        <kbd className="notch-settings-kbd">⇧⌘O</kbd>
      </div>

      <div className="notch-settings-row">
        <span className="notch-settings-name" title="Realtime speech-to-speech via xAI — replaces the local voice pipeline while on">
          Grok voice
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={grokEnabled}
          aria-label="Use Grok voice (realtime, requires xAI API key)"
          className={`notch-toggle${grokEnabled ? ' on' : ''}`}
          onClick={() => onGrokToggle(!grokEnabled)}
        >
          <span className="notch-toggle-dot" />
        </button>
      </div>

      {grokEnabled ? (
        <>
          <div className="notch-settings-row">
            <span className="notch-settings-name">xAI key</span>
            <input
              type="password"
              className="notch-settings-input"
              value={keyDraft}
              placeholder={grokHasKey ? `saved ····${grokKeyTail}` : 'xai-…'}
              aria-label="xAI API key"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKeyDraft(e.target.value)}
              onBlur={commitKey}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitKey()
                  return
                }
                if (e.key === 'Escape') {
                  // Cancel the draft; let the event bubble so App's handler
                  // closes the panel (the blur-commit sees an empty draft).
                  setKeyDraft('')
                  return
                }
                // Keep typing (incl. Space) from triggering bar shortcuts.
                e.stopPropagation()
              }}
            />
          </div>

          <div className="notch-settings-row">
            <span className="notch-settings-name">Grok speaker</span>
            <select
              className="notch-settings-select"
              value={grokVoice}
              onChange={(e) => onGrokVoiceChange(e.target.value)}
              aria-label="Grok voice persona"
            >
              {GROK_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          <div className="notch-settings-row">
            <span
              className="notch-settings-name"
              title="Only listen while ⌥R is held — release and the orb answers. Off = open mic: the session hears you continuously and answers when you pause"
            >
              Hold to talk ⌥R
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={grokPushToTalk}
              aria-label="Hold ⌥R to talk (push-to-talk) instead of open mic"
              className={`notch-toggle${grokPushToTalk ? ' on' : ''}`}
              onClick={() => onGrokPushToTalkToggle(!grokPushToTalk)}
            >
              <span className="notch-toggle-dot" />
            </button>
          </div>
        </>
      ) : null}

      <div className="notch-settings-row">
        <span className="notch-settings-name" title="Realtime speech-to-speech via Google's Gemini Live — replaces the local voice pipeline while on">
          Gemini voice
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={geminiEnabled}
          aria-label="Use Gemini Live voice (realtime, requires Google AI API key)"
          className={`notch-toggle${geminiEnabled ? ' on' : ''}`}
          onClick={() => onGeminiToggle(!geminiEnabled)}
        >
          <span className="notch-toggle-dot" />
        </button>
      </div>

      {geminiEnabled ? (
        <>
          <div className="notch-settings-row">
            <span className="notch-settings-name">Google key</span>
            <input
              type="password"
              className="notch-settings-input"
              value={geminiKeyDraft}
              placeholder={geminiHasKey ? `saved ····${geminiKeyTail}` : 'AIza…'}
              aria-label="Google AI API key"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setGeminiKeyDraft(e.target.value)}
              onBlur={commitGeminiKey}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitGeminiKey()
                  return
                }
                if (e.key === 'Escape') {
                  // Cancel the draft; let the event bubble so App's handler
                  // closes the panel (the blur-commit sees an empty draft).
                  setGeminiKeyDraft('')
                  return
                }
                // Keep typing (incl. Space) from triggering bar shortcuts.
                e.stopPropagation()
              }}
            />
          </div>

          <div className="notch-settings-row">
            <span className="notch-settings-name">Gemini speaker</span>
            <select
              className="notch-settings-select"
              value={geminiVoice}
              onChange={(e) => onGeminiVoiceChange(e.target.value)}
              aria-label="Gemini voice persona"
            >
              {GEMINI_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          <div className="notch-settings-row">
            <span
              className="notch-settings-name"
              title="Stream live frames of your screen into the conversation so Gemini can see what you see (≤1 fps; uses tokens while on)"
            >
              Share screen
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={geminiScreenShare}
              aria-label="Share your screen with the Gemini voice session"
              className={`notch-toggle${geminiScreenShare ? ' on' : ''}`}
              onClick={() => onGeminiScreenShareToggle(!geminiScreenShare)}
            >
              <span className="notch-toggle-dot" />
            </button>
          </div>

          <div className="notch-settings-row">
            <span
              className="notch-settings-name"
              title="Only listen while ⌥R is held — release and the orb answers. Off = open mic: the session hears you continuously and answers when you pause"
            >
              Hold to talk ⌥R
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={geminiPushToTalk}
              aria-label="Hold ⌥R to talk (push-to-talk) instead of open mic"
              className={`notch-toggle${geminiPushToTalk ? ' on' : ''}`}
              onClick={() => onGeminiPushToTalkToggle(!geminiPushToTalk)}
            >
              <span className="notch-toggle-dot" />
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
