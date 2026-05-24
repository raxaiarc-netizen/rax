import { useCallback, useEffect, useState } from 'react'
import type { RaxAuthStatus, RaxAccountInfo } from '../../shared/types'

/**
 * Settings panel section for Rax cloud — the hosted billing mode.
 *
 *  ┌────────────────────────────────────────────────────────────────┐
 *  │  RAX CLOUD                                          [ active ] │
 *  │  Use Rax credits to pay for Claude usage — no Anthropic        │
 *  │  account needed.                                               │
 *  │                                                                │
 *  │  ┌──────────────────────────────────────────────────────────┐  │
 *  │  │  arcrxx@gmail.com                                        │  │
 *  │  │  Balance        $9.34         [ Top up ]                 │  │
 *  │  │  Device key     rax_sk_AbCd…                             │  │
 *  │  │  Status         ● Using Rax           [ Sign out ]       │  │
 *  │  └──────────────────────────────────────────────────────────┘  │
 *  └────────────────────────────────────────────────────────────────┘
 *
 * When the user isn't signed in, the inner card becomes a single CTA.
 */
export function RaxCloudSection() {
  const [status, setStatus]   = useState<RaxAuthStatus | null>(null)
  const [account, setAccount] = useState<RaxAccountInfo | null>(null)
  const [busy, setBusy]       = useState<'signin' | 'signout' | 'toggle' | null>(null)
  const [err, setErr]         = useState<string | null>(null)

  // Keep status fresh — initial load + subscribe to main-process changes.
  useEffect(() => {
    window.rax.getRaxAuthStatus().then(setStatus).catch(() => {})
    return window.rax.onRaxAuthChanged(setStatus)
  }, [])

  // Refresh balance whenever the user becomes signed in, and then poll
  // every 30s while the section is mounted. Polling is light (one tiny
  // request) and means the displayed balance keeps up with charges from
  // the spawned `claude` process without the user clicking "refresh".
  const refreshAccount = useCallback(async () => {
    if (!status?.signedIn) {
      setAccount(null)
      return
    }
    const info = await window.rax.raxAuthFetchAccount()
    setAccount(info)
  }, [status?.signedIn])

  useEffect(() => {
    refreshAccount()
    if (!status?.signedIn) return
    const id = setInterval(refreshAccount, 30_000)
    return () => clearInterval(id)
  }, [refreshAccount, status?.signedIn])

  if (!status) return null

  const signIn = async () => {
    setBusy('signin'); setErr(null)
    try {
      const res = await window.rax.raxAuthSignIn()
      if (!res.ok) setErr(`Sign-in failed: ${res.reason}`)
    } finally { setBusy(null) }
  }

  const signOut = async () => {
    if (!confirm('Sign out of Rax cloud? Your `claude` CLI will fall back to its own credentials.')) return
    setBusy('signout'); setErr(null)
    try {
      await window.rax.raxAuthSignOut()
      setAccount(null)
    } finally { setBusy(null) }
  }

  const toggle = async (next: boolean) => {
    setBusy('toggle'); setErr(null)
    try { await window.rax.raxAuthSetEnabled(next) }
    finally { setBusy(null) }
  }

  const openDashboard = () => window.rax.openExternal(`${status.baseUrl}/app/dashboard`)

  return (
    <div className="fs-settings-section">
      <div className="fs-settings-section-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>Rax cloud</span>
        {status.signedIn && (
          <span className={`fs-pill ${status.enabled ? 'is-on' : 'is-off'}`}>
            {status.enabled ? '● Active' : '○ Paused'}
          </span>
        )}
      </div>
      <div className="fs-settings-section-desc">
        Pay for Claude usage with prepaid Rax credits — no Anthropic account or API key needed.
        We bill the request, you keep the conversation.
      </div>

      <div className="fs-settings-group" style={{ marginTop: 12 }}>
        {!status.signedIn ? (
          <SignedOutCard onSignIn={signIn} busy={busy === 'signin'} />
        ) : (
          <SignedInCard
            email={account?.email ?? null}
            balanceCents={account?.balanceCents ?? null}
            fetchedAt={account?.fetchedAt ?? null}
            error={account?.error ?? null}
            keyPrefix={status.keyPrefix}
            enabled={status.enabled}
            busy={busy}
            onToggle={toggle}
            onRefresh={refreshAccount}
            onOpenDashboard={openDashboard}
            onSignOut={signOut}
          />
        )}

        {err && <div className="fs-settings-error">{err}</div>}
      </div>
    </div>
  )
}

function SignedOutCard({ onSignIn, busy }: { onSignIn: () => void; busy: boolean }) {
  return (
    <div className="fs-settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
      <div className="fs-settings-label" style={{ flex: 'none' }}>
        <div className="fs-settings-name">Sign in to start</div>
        <div className="fs-settings-help">
          One-click sign-in in your browser. We'll mint a device-specific key and
          point your spawned <code>claude</code> at the Rax proxy automatically.
        </div>
      </div>
      <button onClick={onSignIn} disabled={busy} className="fs-button is-primary" style={{ alignSelf: 'flex-start' }}>
        {busy ? 'Opening browser…' : 'Sign in to Rax'}
      </button>
    </div>
  )
}

function SignedInCard(props: {
  email: string | null
  balanceCents: number | null
  fetchedAt: string | null
  error: string | null
  keyPrefix: string | null
  enabled: boolean
  busy: 'signin' | 'signout' | 'toggle' | null
  onToggle: (v: boolean) => void
  onRefresh: () => void
  onOpenDashboard: () => void
  onSignOut: () => void
}) {
  const fmtBalance =
    props.balanceCents == null
      ? '—'
      : `$${(props.balanceCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Identity row */}
      <div className="fs-settings-row">
        <div className="fs-settings-label">
          <div className="fs-settings-name">{props.email ?? 'Signed in'}</div>
          <div className="fs-settings-help">
            {props.keyPrefix && <>Device key <code>{props.keyPrefix}…</code></>}
          </div>
        </div>
        <button onClick={props.onSignOut} disabled={props.busy === 'signout'} className="fs-button">
          {props.busy === 'signout' ? '…' : 'Sign out'}
        </button>
      </div>

      {/* Balance row */}
      <div className="fs-settings-row">
        <div className="fs-settings-label">
          <div className="fs-settings-name" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 22 }}>
            {fmtBalance}
          </div>
          <div className="fs-settings-help">
            Balance{props.fetchedAt ? ` · synced ${relativeTime(props.fetchedAt)}` : ''}
            {props.error ? ` · couldn't refresh (${props.error})` : ''}
            {' '}
            <a onClick={props.onRefresh} style={{ cursor: 'pointer', textDecoration: 'underline' }}>refresh</a>
          </div>
        </div>
        <button onClick={props.onOpenDashboard} className="fs-button is-primary">Top up</button>
      </div>

      {/* Toggle row */}
      <div className="fs-settings-row">
        <div className="fs-settings-label">
          <div className="fs-settings-name">Route Claude through Rax</div>
          <div className="fs-settings-help">
            When on, every spawned <code>claude</code> uses your Rax credits.
            Turn off to use your own Anthropic credentials again — no need to sign out.
          </div>
        </div>
        <input
          type="checkbox"
          checked={props.enabled}
          disabled={props.busy === 'toggle'}
          onChange={(e) => props.onToggle(e.target.checked)}
        />
      </div>
    </div>
  )
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.round(diff / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}
