import { useEffect, useState } from 'react'
import type { ClaudeLoginEvent, RaxAuthStatus, RaxAccountInfo } from '../../shared/types'

type Choice = 'rax' | 'own-claude'
type Phase =
  | 'rax-signin'             // step 1: prompt user to sign in to Rax
  | 'rax-signing-in'         // step 1: in-flight loopback OAuth
  | 'choose'                 // step 2: pick Rax-credits vs own-Claude
  | 'own-claude-signing-in'  // step 2 → system claude login flow
  | 'success'                // step 3: confirmation + "Launch Rax" button

/**
 * Two-step onboarding window.
 *
 *   Step 1 — sign in to Rax (universal: every customer gets a Rax account,
 *            even if they later choose to use their own Claude credentials).
 *
 *   Step 2 — pick how Claude is billed:
 *              · "Top up Rax credits"   → opens the dashboard top-up flow
 *              · "Use my own Claude"   → switches to system Claude and
 *                                         runs `claude login` if needed
 *
 * The Rax account stays signed in either way — that's what lets the user
 * flip between modes later without re-onboarding.
 *
 * If the welcome opens when the user is already signed in to Rax (e.g.
 * they crashed mid-onboarding), we skip step 1 and go straight to step 2.
 */
export function WelcomeApp() {
  const [phase, setPhase] = useState<Phase>('rax-signin')
  const [chosenPath, setChosenPath] = useState<Choice | null>(null)
  const [raxStatus, setRaxStatus] = useState<RaxAuthStatus | null>(null)
  const [account, setAccount] = useState<RaxAccountInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [output, setOutput] = useState<string>('')

  // Determine initial phase from main-process state. If the user is already
  // signed in to Rax, jump straight to step 2.
  useEffect(() => {
    window.rax.getRaxAuthStatus().then((status) => {
      setRaxStatus(status)
      if (status.signedIn) {
        setPhase('choose')
        void refreshAccount()
      }
    }).catch(() => {})
  }, [])

  // Live updates if rax auth state changes elsewhere.
  useEffect(() => {
    return window.rax.onRaxAuthChanged((status) => {
      setRaxStatus(status)
      if (status.signedIn && phase === 'rax-signing-in') {
        setPhase('choose')
        void refreshAccount()
      }
    })
  }, [phase])

  // Subscribe to claude-login events for the own-Claude path. Set up
  // once so events can't race the listener.
  useEffect(() => {
    return window.rax.onClaudeLoginEvent((ev: ClaudeLoginEvent) => {
      if (ev.kind === 'output') {
        setOutput((prev) => (prev + ev.text).slice(-1500))
      } else if (ev.kind === 'error') {
        setErr(ev.message || 'login error')
        setPhase('choose')
      } else if (ev.kind === 'exit') {
        if (ev.signedIn) {
          void markChoiceAndAdvance('own-claude')
        } else {
          setErr(`Sign-in didn't finish (exit ${ev.code ?? '?'}). You can try again from Settings.`)
          setPhase('choose')
        }
      }
    })
  }, [])

  const refreshAccount = async () => {
    const info = await window.rax.raxAuthFetchAccount().catch(() => null)
    if (info) setAccount(info)
  }

  /** Persist the user's choice and advance to the success screen. The
   *  pill is only created when the user clicks "Launch Rax" on success. */
  const markChoiceAndAdvance = async (choice: Choice) => {
    setChosenPath(choice)
    await window.rax.completeOnboarding(choice).catch(() => {})
    // Refresh balance one more time so the success screen reflects any
    // top-up that just happened in the browser.
    if (choice === 'rax') await refreshAccount()
    setPhase('success')
  }

  const launchRax = async () => {
    await window.rax.launchPill().catch(() => {})
  }

  // ─── Step 1 actions ────────────────────────────────────────────────
  const signIntoRax = async () => {
    setPhase('rax-signing-in'); setErr(null)
    const res = await window.rax.raxAuthSignIn()
    if (!res.ok) {
      setErr(`Sign-in didn't finish: ${res.reason}.`)
      setPhase('rax-signin')
      return
    }
    setPhase('choose')
    await refreshAccount()
  }

  // ─── Step 2 actions ────────────────────────────────────────────────
  const pickRax = async () => {
    // Open the dashboard in their browser so they can top up if they want,
    // then advance to the success screen. The Launch button on that
    // screen creates the pill.
    const base = raxStatus?.baseUrl ?? 'https://rax-ai.com'
    await window.rax.openExternal(`${base}/app/dashboard?topup=open`).catch(() => {})
    await markChoiceAndAdvance('rax')
  }

  const pickOwnClaude = async () => {
    setPhase('own-claude-signing-in'); setErr(null); setOutput('')

    // "Bring your own Claude" → switch to system-installed Claude.
    const info = await window.rax.setClaudeMode('system').catch(() => null)
    if (!info || !info.available) {
      setErr(
        `Couldn't find Claude on your PATH.\n` +
        `Install it first: npm install -g @anthropic-ai/claude-code`,
      )
      setPhase('choose')
      return
    }
    // Also turn OFF Rax proxy mode — own-claude path means user is using
    // their own Anthropic creds for billing.
    await window.rax.raxAuthSetEnabled(false).catch(() => {})

    if (info.auth?.signedIn) {
      await markChoiceAndAdvance('own-claude')
      return
    }
    const res = await window.rax.startClaudeLogin()
    if (!res.ok) {
      setErr(`Could not start \`claude login\`: ${res.error}`)
      setPhase('choose')
    }
  }

  const cancelClaudeLogin = async () => {
    await window.rax.cancelClaudeLogin().catch(() => {})
    setPhase('choose')
  }

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div className="rax-welcome-window">
      <div className="rax-welcome-titlebar" />

      <div className="rax-welcome-body">
        {phase === 'rax-signin' && <Step1SignIn onSignIn={signIntoRax} />}
        {phase === 'rax-signing-in' && <Spinner title="Sign in to Rax in your browser" subtitle="We opened a tab for you. Finish signing in there — this window will continue automatically." onCancel={() => setPhase('rax-signin')} />}

        {phase === 'choose' && (
          <Step2Choose
            account={account}
            onPickRax={pickRax}
            onPickOwn={pickOwnClaude}
          />
        )}

        {phase === 'own-claude-signing-in' && (
          <Spinner
            title="Sign in to Claude in your browser"
            subtitle="We opened a tab for you. Finish signing in there — this window will move on automatically when you do."
            log={output || undefined}
            onCancel={cancelClaudeLogin}
          />
        )}

        {phase === 'success' && (
          <Step3Success
            choice={chosenPath!}
            account={account}
            onLaunch={launchRax}
          />
        )}

        {err && <div className="rax-welcome-error">{err}</div>}
      </div>
    </div>
  )
}

// ─── Step 1 ───────────────────────────────────────────────────────────
function Step1SignIn({ onSignIn }: { onSignIn: () => void }) {
  return (
    <>
      <div className="rax-welcome-eyebrow">Welcome to Rax</div>
      <div className="rax-welcome-title">Sign in to get started</div>
      <div className="rax-welcome-sub">
        Rax wraps Claude Code with a desktop UI, voice orb, and a permission layer.
        Sign in with your email or Google — your account holds your credits, usage
        history, and lets you switch between Rax-billed and your-own-Claude any
        time.
      </div>

      <div style={{ marginTop: 28 }}>
        <button onClick={onSignIn} className="rax-welcome-primary-button">
          Sign in to Rax
        </button>
      </div>

      <div className="rax-welcome-fineprint">
        A browser tab will open for sign-in. Magic link or Google — your call.
      </div>
    </>
  )
}

// ─── Step 2 ───────────────────────────────────────────────────────────
function Step2Choose({
  account,
  onPickRax,
  onPickOwn,
}: {
  account: RaxAccountInfo | null
  onPickRax: () => void
  onPickOwn: () => void
}) {
  const bal = account?.balanceCents
  const balText =
    typeof bal === 'number'
      ? `$${(bal / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : null

  return (
    <>
      <div className="rax-welcome-eyebrow">
        {account?.email ? `Signed in as ${account.email}` : 'Signed in'}
      </div>
      <div className="rax-welcome-title">How do you want to use Claude?</div>
      <div className="rax-welcome-sub">
        Either way, you stay signed in to Rax — switching between these is one
        click in Settings.
      </div>

      <div className="rax-welcome-choices">
        <ChoiceCard
          recommended
          badge="Recommended"
          title="Top up Rax credits"
          blurb={
            balText && balText !== '$0.00'
              ? `You already have ${balText} in credits. Top up more if you want — we'll open your dashboard.`
              : 'Add $20, $50, or $100 in credits and let Rax bill your requests. No Anthropic account needed.'
          }
          cta="Open dashboard →"
          primary
          onClick={onPickRax}
        />
        <ChoiceCard
          title="Use my own Claude"
          blurb="If you already pay Anthropic directly (API key or Claude.ai subscription), keep using your own credentials. We'll switch to your system Claude and run `claude login` if needed."
          cta="Use my own Claude →"
          onClick={onPickOwn}
        />
      </div>
    </>
  )
}

// ─── Bits ─────────────────────────────────────────────────────────────
function Spinner({
  title,
  subtitle,
  log,
  onCancel,
}: {
  title: string
  subtitle: string
  log?: string
  onCancel: () => void
}) {
  return (
    <>
      <div className="rax-welcome-eyebrow">Welcome to Rax</div>
      <div className="rax-welcome-title">{title}</div>
      <div className="rax-welcome-sub">{subtitle}</div>

      <div className="rax-welcome-progress">
        <div className="rax-welcome-spinner" />
        <div className="rax-welcome-progress-text">Waiting for browser sign-in…</div>
        {log && <pre className="rax-welcome-log">{log}</pre>}
        <div className="rax-welcome-progress-actions">
          <button className="rax-welcome-skip" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </>
  )
}

// ─── Step 3 (success) ────────────────────────────────────────────────
function Step3Success({
  choice,
  account,
  onLaunch,
}: {
  choice: Choice
  account: RaxAccountInfo | null
  onLaunch: () => void
}) {
  const balText =
    typeof account?.balanceCents === 'number'
      ? `$${(account.balanceCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : null

  return (
    <>
      <div className="rax-welcome-eyebrow rax-welcome-success-eyebrow">All set</div>
      <div className="rax-welcome-title">
        {choice === 'rax' ? "You're ready to go" : 'Your Claude is connected'}
      </div>
      <div className="rax-welcome-sub">
        {choice === 'rax'
          ? balText && balText !== '$0.00'
            ? `You have ${balText} in Rax credits. Every chat, voice turn, and tool call will be billed against your balance — switch to your own Claude any time from Settings.`
            : 'Your Rax account is set up. Top up credits any time from Settings or your dashboard — until then, requests will be rejected with an "insufficient credits" error.'
          : `You're using your own Claude installation${account?.email ? ` (Rax account: ${account.email})` : ''}. Rax stays in the background — switch to Rax-billed mode any time from Settings.`}
      </div>

      <div className="rax-welcome-success-summary">
        <div className="rax-welcome-summary-row">
          <span className="rax-welcome-summary-label">Mode</span>
          <span className="rax-welcome-summary-value">
            {choice === 'rax' ? 'Rax credits' : 'Own Claude (system)'}
          </span>
        </div>
        {account?.email && (
          <div className="rax-welcome-summary-row">
            <span className="rax-welcome-summary-label">Account</span>
            <span className="rax-welcome-summary-value">{account.email}</span>
          </div>
        )}
        {choice === 'rax' && balText && (
          <div className="rax-welcome-summary-row">
            <span className="rax-welcome-summary-label">Balance</span>
            <span className="rax-welcome-summary-value">{balText}</span>
          </div>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <button onClick={onLaunch} className="rax-welcome-primary-button">
          Launch Rax →
        </button>
      </div>
      <div className="rax-welcome-fineprint">
        Toggle the pill any time with <kbd className="rax-kbd">⌥ Space</kbd>.
      </div>
    </>
  )
}

function ChoiceCard(props: {
  title: string
  blurb: string
  cta: string
  onClick: () => void
  recommended?: boolean
  badge?: string
  primary?: boolean
}) {
  return (
    <button
      className={`rax-choice ${props.recommended ? 'is-recommended' : ''}`}
      onClick={props.onClick}
    >
      <div className="rax-choice-head">
        <div className="rax-choice-title">{props.title}</div>
        {props.badge && <div className="rax-choice-badge">{props.badge}</div>}
      </div>
      <div className="rax-choice-blurb">{props.blurb}</div>
      <div className={`rax-choice-cta ${props.primary ? 'is-primary' : ''}`}>
        {props.cta}
      </div>
    </button>
  )
}
