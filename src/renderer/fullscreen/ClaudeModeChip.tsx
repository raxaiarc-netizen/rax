import React, { useEffect, useState } from 'react'
import { Cube } from '@phosphor-icons/react'
import type { ClaudeInstanceInfo } from '../../shared/types'

interface Props {
  onClick: () => void
}

/**
 * Tiny pill in the titlebar that shows which Claude Code is active
 * ("Rax" — bundled / "Default" — system) and jumps to Settings when clicked.
 *
 * Subscribes to onClaudeModeChanged so flipping the mode from Settings updates
 * the chip without a manual refresh.
 */
export function ClaudeModeChip({ onClick }: Props): React.ReactElement | null {
  const [info, setInfo] = useState<ClaudeInstanceInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    window.rax.getClaudeInstanceInfo().then((i) => { if (!cancelled) setInfo(i) }).catch(() => {})
    const unsub = window.rax.onClaudeModeChanged((next) => setInfo(next))
    return () => { cancelled = true; unsub() }
  }, [])

  if (!info) return null

  const isBundled = info.mode === 'bundled'
  const label = isBundled ? 'Rax' : 'Default'
  const title = isBundled
    ? `Using Rax's bundled Claude — open Settings to switch`
    : `Using your system Claude (${info.homeDescription}) — open Settings to switch`

  return (
    <button
      className={`fs-claude-chip${isBundled ? ' is-bundled' : ' is-system'}${info.available ? '' : ' is-unavailable'}`}
      onClick={onClick}
      title={title}
      data-no-drag
    >
      <Cube size={11} weight="duotone" />
      <span>{label}</span>
      {!info.available && <span className="fs-claude-chip-dot" aria-hidden />}
    </button>
  )
}
