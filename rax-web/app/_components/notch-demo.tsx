'use client'

import { useEffect, useRef, useState } from 'react'
import { Mascot, type MascotState } from './mascot'

// A miniature top-of-screen: wallpaper, menu-bar edge, and the Rax notch bar
// hanging from it — waveform on the left wing, status word + live mascot on
// the right, exactly like the desktop app. Expression chips below cycle his
// moods automatically until you pick one yourself.

const SCENES: ReadonlyArray<{ id: MascotState; label: string; caption: string }> = [
  { id: 'idle',         label: 'idle',      caption: 'Hold ⌥ R to talk' },
  { id: 'listening',    label: 'listening', caption: 'Listening' },
  { id: 'transcribing', label: 'reading',   caption: 'Transcribing' },
  { id: 'thinking',     label: 'thinking',  caption: 'Thinking' },
  { id: 'talking',      label: 'speaking',  caption: 'Speaking' },
  { id: 'error',        label: 'error',     caption: 'Tap to retry' },
]

export default function NotchDemo() {
  const [idx, setIdx] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned

  useEffect(() => {
    const t = setInterval(() => {
      if (!pinnedRef.current) setIdx((i) => (i + 1) % SCENES.length)
    }, 3400)
    return () => clearInterval(t)
  }, [])

  const scene = SCENES[idx]
  const waveMode = scene.id === 'listening' ? 'mic' : scene.id === 'talking' ? 'voice' : 'off'

  return (
    <div className="space-y-3">
      <div className="nm-screen" aria-hidden>
        <div
          className="nm-bar"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <div className="nm-wing nm-left">
            <span className={'nm-wave ' + waveMode}>
              <span /><span /><span /><span /><span />
            </span>
          </div>
          {/* The hardware notch — the bar wraps it, so the middle stays empty. */}
          <div className="nm-gap" />
          <div className="nm-wing nm-right">
            <span className="nm-caption">{scene.caption}</span>
            <Mascot state={scene.id} hovered={hovered} size={26} noDoze />
          </div>
        </div>
        {/* A window peeking from under the menu bar, for scale. */}
        <div className="nm-window">
          <span /><span /><span />
        </div>
      </div>

      <div className="nm-chips" role="group" aria-label="mascot expressions">
        {SCENES.map((s, i) => (
          <button
            key={s.id}
            onClick={() => { setIdx(i); setPinned(true) }}
            className={'nm-chip' + (i === idx ? ' is-active' : '')}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
