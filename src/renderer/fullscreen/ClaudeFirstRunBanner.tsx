import React, { useEffect, useState } from 'react'
import { X, SignIn, Wrench } from '@phosphor-icons/react'
import type { ClaudeInstanceInfo } from '../../shared/types'

interface Props {
  onGoToSettings: () => void
}

const DISMISS_KEY = 'rax:claude-firstrun-dismissed'

/**
 * One-time banner shown when the app is in bundled mode but no one has signed
 * in to Rax's Claude yet. Two CTAs: open Settings to sign in, or flip to the
 * user's system Claude.
 *
 * Stays visible across launches until either dismissed or auth resolves. Once
 * dismissed, never returns (state lives in localStorage).
 */
export function ClaudeFirstRunBanner({ onGoToSettings }: Props): React.ReactElement | null {
  const [info, setInfo] = useState<ClaudeInstanceInfo | null>(null)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.rax.getClaudeInstanceInfo().then((i) => { if (!cancelled) setInfo(i) }).catch(() => {})
    const unsub = window.rax.onClaudeModeChanged((next) => setInfo(next))
    return () => { cancelled = true; unsub() }
  }, [])

  if (!info || dismissed) return null
  if (info.mode !== 'bundled') return null
  if (!info.available) return null
  if (info.auth?.signedIn) return null

  const handleDismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch {}
    setDismissed(true)
  }

  const handleUseSystem = async () => {
    if (switching) return
    setSwitching(true)
    try {
      await window.rax.setClaudeMode('system')
      handleDismiss()
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="fs-claude-firstrun">
      <div className="fs-claude-firstrun-body">
        <div className="fs-claude-firstrun-title">
          Sign in to Rax's Claude
        </div>
        <div className="fs-claude-firstrun-desc">
          Rax ships its own Claude — your history, memory, MCP servers, and plugins
          live here, fully separate from your personal <code>~/.claude</code>. Sign in once
          to activate it. Prefer your existing setup? Switch to the system <code>claude</code>.
        </div>
      </div>
      <div className="fs-claude-firstrun-actions">
        <button
          className="fs-button is-primary"
          onClick={onGoToSettings}
        >
          <SignIn size={12} /> Sign in
        </button>
        <button
          className="fs-button"
          onClick={handleUseSystem}
          disabled={switching}
        >
          <Wrench size={12} /> Use my system Claude
        </button>
        <button
          className="fs-claude-firstrun-close"
          onClick={handleDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X size={12} weight="bold" />
        </button>
      </div>
    </div>
  )
}
