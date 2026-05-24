'use client'

import { useState } from 'react'

type Option = {
  readonly label: string
  readonly cents: number
  readonly tier: string
}

export default function TopupButtons({ options }: { options: readonly Option[] }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function subscribe(cents: number) {
    setBusy(cents); setErr(null)
    try {
      const res = await fetch('/api/whop/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cents }),
      })
      const j = await res.json()
      if (!res.ok || !j.url) throw new Error(j.error ?? 'checkout failed')
      window.location.href = j.url
    } catch (e: any) {
      setErr(e?.message ?? 'checkout failed')
      setBusy(null)
    }
  }

  return (
    <div className="pt-4 space-y-2">
      <div className="flex flex-wrap gap-2">
        {options.map(o => (
          <button
            key={o.cents}
            disabled={busy !== null}
            onClick={() => subscribe(o.cents)}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-900 disabled:opacity-50 text-left"
          >
            <div className="font-medium">{o.tier} · {o.label}/mo</div>
            <div className="text-[11px] text-neutral-500">
              {busy === o.cents ? 'opening…' : `${o.label} in credits every month`}
            </div>
          </button>
        ))}
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  )
}
