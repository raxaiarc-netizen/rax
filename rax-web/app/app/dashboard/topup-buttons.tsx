'use client'

import { useState } from 'react'

type Option = {
  readonly label: string
  readonly cents: number
  readonly tier: string
}

const TIER_BLURB: Record<string, string> = {
  Pro:    'kick the tires',
  'Pro+': 'balanced choice',
  Ultra:  'for serious shipping',
}

const TIER_BG: Record<string, string> = {
  Pro:    'bg-paper',
  'Pro+': 'bg-[#eaf0ff]',
  Ultra:  'bg-paper',
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
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {options.map((o, i) => {
          const popular = o.tier === 'Pro+'
          const isBusy = busy === o.cents
          return (
            <button
              key={o.cents}
              disabled={busy !== null}
              onClick={() => subscribe(o.cents)}
              className={
                'group relative text-left rounded-3xl border transition-all duration-200 p-6 ' +
                TIER_BG[o.tier] + ' ' +
                (popular
                  ? 'border-lime-deep ring-2 ring-lime-deep/40'
                  : 'border-line-2 hover:border-line-3') +
                ' hover:-translate-y-0.5 disabled:opacity-50 disabled:translate-y-0 disabled:cursor-wait'
              }
            >
              {popular && (
                <div className="absolute -top-3 left-6">
                  <span className="sticker sticker-lime">balanced ★</span>
                </div>
              )}

              <div className="flex items-baseline justify-between mb-5">
                <span className="font-mono text-[10.5px] tracking-[0.22em] uppercase text-muted">
                  tier · 0{i + 1}
                </span>
                {popular && (
                  <span className="font-mono text-[10.5px] tracking-[0.2em] uppercase text-lime-deep">★ recommended</span>
                )}
              </div>

              <div className="space-y-3">
                <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink">{o.tier}</div>
                <div className="flex items-baseline gap-2">
                  <span className="font-display font-bold text-[clamp(2.6rem,4.2vw,3.6rem)] leading-none tabular-nums tracking-[-0.04em] text-ink">
                    {o.label}
                  </span>
                  <span className="font-mono text-[12px] text-muted tracking-tight">/ mo</span>
                </div>
                <div className="script text-[18px] text-lime-deep">{TIER_BLURB[o.tier] ?? '—'}</div>
              </div>

              <div className="mt-6 pt-4 border-t border-line space-y-2 text-[13px] text-muted">
                <div className="flex items-center justify-between">
                  <span>credits / mo</span>
                  <span className="text-ink font-medium tabular-nums">{o.label}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>cancel</span>
                  <span className="text-ink">any time</span>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between">
                <span className={
                  'font-mono text-[11px] tracking-[0.18em] uppercase ' +
                  (popular ? 'text-lime-deep' : 'text-muted group-hover:text-ink')
                }>
                  {isBusy ? 'opening…' : 'subscribe →'}
                </span>
                {isBusy && <span className="caret" style={{ height: '0.8em', width: '0.4ch' }} />}
              </div>
            </button>
          )
        })}
      </div>
      {err && (
        <div className="text-[12.5px] text-coral flex items-center gap-2">
          <span className="dot dot-coral" />
          {err}
        </div>
      )}
    </div>
  )
}
