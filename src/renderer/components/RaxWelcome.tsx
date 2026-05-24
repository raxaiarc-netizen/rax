import { useEffect, useState } from 'react'
import './rax-welcome.css'

/**
 * First-launch onboarding overlay. Renders once per install — the
 * "completed" flag is persisted in `<userData>/onboarding.json` by the
 * main-process onboarding module. The user picks one of three paths:
 *
 *   1. "Use Rax"        → triggers the Rax loopback OAuth + lands them
 *                         in Rax mode with credits ready to top up
 *   2. "Use my Claude"  → triggers `claude login` and leaves Rax mode off
 *   3. "Maybe later"    → dismisses the welcome; same as #2 minus the login
 *
 * The component checks `getOnboarding().completed` on mount and renders
 * nothing if the user has already finished onboarding.
 */

type Choice = 'rax' | 'own-claude' | 'skip'

export function RaxWelcome() {
  const [visible, setVisible] = useState(false)
  const [busy, setBusy]       = useState<Choice | null>(null)
  const [err, setErr]         = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.rax.getOnboarding(),
      window.rax.getRaxAuthStatus(),
    ]).then(([ob, rax]) => {
      if (cancelled) return
      // Already onboarded — never show.
      if (ob.completed) return
      // Already signed in to Rax — auto-complete and skip the screen.
      if (rax.signedIn) {
        window.rax.completeOnboarding('rax').catch(() => {})
        return
      }
      setVisible(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!visible) return null

  const finish = async (choice: Choice) => {
    await window.rax.completeOnboarding(choice).catch(() => {})
    setVisible(false)
  }

  const pickRax = async () => {
    setBusy('rax'); setErr(null)
    try {
      const res = await window.rax.raxAuthSignIn()
      if (!res.ok) {
        setErr(`Sign-in didn't finish: ${res.reason}. You can try again from Settings.`)
        return
      }
      await finish('rax')
    } finally { setBusy(null) }
  }

  const pickOwnClaude = async () => {
    setBusy('own-claude'); setErr(null)
    try {
      const res = await window.rax.startClaudeLogin()
      if (!res.ok) {
        setErr(`Could not start Claude login: ${res.error}`)
        return
      }
      // Dismiss right away — the user finishes the CLI login in their
      // own time and can still hit Cancel from Settings.
      await finish('own-claude')
    } finally { setBusy(null) }
  }

  const skip = () => finish('skip')

  return (
    <div className="rax-welcome-overlay" role="dialog" aria-modal="true">
      <div className="rax-welcome-card">
        <div className="rax-welcome-eyebrow">Welcome to Rax</div>
        <div className="rax-welcome-title">How do you want to use Claude?</div>
        <div className="rax-welcome-sub">
          Rax wraps Claude Code with a desktop UI, voice orb, and a permission layer.
          Pick how Claude is billed — you can switch any time from Settings.
        </div>

        <div className="rax-welcome-choices">
          <ChoiceCard
            recommended
            badge="Recommended"
            title="Use Rax credits"
            blurb="No Anthropic account needed. Pay as you go with prepaid credits — $20, $50, or $100 top-ups. Every chat, voice turn, and tool call is billed transparently. Top up later from Settings."
            cta={busy === 'rax' ? 'Opening browser…' : 'Sign in to Rax'}
            disabled={busy !== null}
            primary
            onClick={pickRax}
          />
          <ChoiceCard
            title="Bring your own Claude"
            blurb="If you already pay Anthropic directly (API key or Claude.ai subscription), keep using your own credentials. We'll launch the standard `claude login` flow."
            cta={busy === 'own-claude' ? 'Starting login…' : 'Use my own Claude'}
            disabled={busy !== null}
            onClick={pickOwnClaude}
          />
        </div>

        <div className="rax-welcome-footer">
          <button onClick={skip} disabled={busy !== null} className="rax-welcome-skip">
            Maybe later
          </button>
        </div>

        {err && <div className="rax-welcome-error">{err}</div>}
      </div>
    </div>
  )
}

function ChoiceCard(props: {
  title: string
  blurb: string
  cta: string
  onClick: () => void
  disabled: boolean
  recommended?: boolean
  badge?: string
  primary?: boolean
}) {
  return (
    <button
      className={`rax-choice ${props.recommended ? 'is-recommended' : ''}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <div className="rax-choice-head">
        <div className="rax-choice-title">{props.title}</div>
        {props.badge && <div className="rax-choice-badge">{props.badge}</div>}
      </div>
      <div className="rax-choice-blurb">{props.blurb}</div>
      <div className={`rax-choice-cta ${props.primary ? 'is-primary' : ''}`}>
        {props.cta}
        <span aria-hidden="true">→</span>
      </div>
    </button>
  )
}
