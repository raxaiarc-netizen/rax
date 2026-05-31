'use client'

import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase-browser'

export default function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const redirectTo = `${typeof window !== 'undefined' ? window.location.origin : ''}/auth/callback?next=${encodeURIComponent(next)}`

  async function magicLink(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(null)
    const sb = supabaseBrowser()
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } })
    setBusy(false)
    if (error) setErr(error.message); else setSent(true)
  }

  async function google() {
    setBusy(true); setErr(null)
    const sb = supabaseBrowser()
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })
    if (error) { setErr(error.message); setBusy(false) }
  }

  if (sent) {
    return (
      <div className="rounded-2xl border border-lime-deep/30 bg-[rgba(207,255,186,0.4)] p-5 text-[14px] space-y-2">
        <div className="flex items-center gap-2 text-lime-deep font-mono text-[10.5px] tracking-[0.2em] uppercase">
          <span className="dot" /> link dispatched
        </div>
        <p className="text-ink leading-relaxed">
          Magic link sent to <span className="font-semibold">{email}</span>.
        </p>
        <p className="text-muted text-[12.5px]">
          Open it on this device to finish signing in.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <form onSubmit={magicLink} className="space-y-3">
        <label className="block font-mono text-[10px] tracking-[0.2em] uppercase text-muted">
          email
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-lime-deep text-[13px] select-none pointer-events-none">
            ▸
          </span>
          <input
            type="email"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="field w-full pl-8 pr-3 py-3 text-[14px]"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="btn-primary w-full !py-3 !text-[14px]"
        >
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <span className="caret caret-light" style={{ height: '0.8em' }} />
              <span>dispatching…</span>
            </span>
          ) : (
            <span>email me a magic link →</span>
          )}
        </button>
      </form>

      <div className="divider-x">or</div>

      <button
        onClick={google}
        disabled={busy}
        className="btn-ghost w-full !py-3 !text-[14px]"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden>
          <path fill="#0c0c0c" d="M21.35 11.1H12v2.8h5.35c-.23 1.5-1.6 4.4-5.35 4.4-3.22 0-5.85-2.66-5.85-5.95s2.63-5.95 5.85-5.95c1.83 0 3.06.78 3.77 1.45l2.57-2.48C16.78 3.95 14.6 3 12 3 6.93 3 3 6.93 3 12s3.93 9 9 9c5.2 0 8.64-3.65 8.64-8.79 0-.6-.07-1.06-.16-1.51z" />
        </svg>
        continue with Google
      </button>

      {err && (
        <div className="text-[12.5px] text-coral flex items-center gap-2">
          <span className="dot dot-coral" />
          {err}
        </div>
      )}
    </div>
  )
}
