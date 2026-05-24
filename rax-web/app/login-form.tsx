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
      <div className="rounded-md border border-neutral-800 p-4 text-sm">
        Magic link sent to <span className="font-medium">{email}</span>. Open it on this device to finish signing in.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <form onSubmit={magicLink} className="space-y-2">
        <input
          type="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-600"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-white text-black py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? '…' : 'Email me a magic link'}
        </button>
      </form>
      <div className="text-center text-xs text-neutral-500">or</div>
      <button
        onClick={google}
        disabled={busy}
        className="w-full rounded-md border border-neutral-800 py-2 text-sm hover:bg-neutral-900"
      >
        Continue with Google
      </button>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  )
}
