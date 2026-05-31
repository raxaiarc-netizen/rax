'use client'

import { useState } from 'react'

type Row = {
  id: string
  prefix: string
  name: string | null
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

function ago(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function KeysClient({ initial }: { initial: Row[] }) {
  const [keys, setKeys] = useState<Row[]>(initial)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [reveal, setReveal] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const res = await fetch('/api/keys')
    if (res.ok) setKeys((await res.json()).keys)
  }

  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null)
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name || 'web' }),
    })
    const j = await res.json()
    setBusy(false)
    if (!res.ok) { setErr(j.error ?? 'failed'); return }
    setReveal(j.key); setCopied(false); setName('')
    refresh()
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this key? Any device using it will stop working.')) return
    await fetch('/api/keys', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    refresh()
  }

  const active = keys.filter(k => !k.revoked_at).length

  return (
    <div className="space-y-16">
      {/* Page header */}
      <div className="enter enter-d1 space-y-3">
        <div className="ribbon">
          <span className="num">02</span>
          <span className="rule" />
          <span className="label">keystore · device tokens</span>
        </div>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <h1 className="display-xl">
            API keys<span className="text-lime-deep">.</span>
          </h1>
          <div className="flex items-center gap-3 font-mono text-[11px] tracking-[0.18em] uppercase">
            <span className="inline-flex items-center gap-2 text-ink">
              <span className="dot" /> {active} active
            </span>
            <span className="text-soft">·</span>
            <span className="text-muted">{keys.length - active} revoked</span>
          </div>
        </div>
      </div>

      {/* Create panel */}
      <section className="enter enter-d2 card overflow-hidden p-6 sm:p-8 bg-paper">
        <div className="space-y-2 mb-6">
          <div className="ribbon mb-0">
            <span className="num">▸</span>
            <span className="rule" />
            <span className="label">new token</span>
          </div>
          <h2 className="display-lg">
            Mint a key<span className="text-lime-deep">.</span>
          </h2>
          <p className="text-[14px] text-muted max-w-[50ch]">
            Name it after the device or environment that will hold it.
          </p>
        </div>

        <form onSubmit={create} className="flex flex-col sm:flex-row gap-2.5 max-w-xl">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-lime-deep text-[13px] select-none pointer-events-none">
              ▸
            </span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="MacBook Air · home rig · prod"
              className="field w-full pl-8 pr-3 py-3 text-[14px]"
            />
          </div>
          <button disabled={busy} className="btn-primary !py-3 !text-[14px] whitespace-nowrap">
            {busy ? 'minting…' : 'mint key →'}
          </button>
        </form>

        {err && (
          <div className="mt-3 text-[12.5px] text-coral flex items-center gap-2">
            <span className="dot dot-coral" /> {err}
          </div>
        )}

        {reveal && (
          <div className="mt-6 rounded-2xl border border-butter bg-[rgba(254,223,111,0.18)] p-5 space-y-3">
            <div className="flex items-center gap-2 text-ink font-mono text-[10.5px] tracking-[0.2em] uppercase">
              <span className="dot dot-butter" />
              copy now · shown once
            </div>
            <code className="block break-all font-mono text-[13px] bg-ink-900 text-lime-soft border border-ink-800 p-4 rounded-xl">
              {reveal}
            </code>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted">
                Paste this into <span className="text-ink font-medium">Rax → Settings → API key</span>.
              </span>
              <button
                className="btn-ghost !py-2 !px-4 font-mono !text-[11px] tracking-[0.16em] uppercase"
                onClick={() => {
                  navigator.clipboard.writeText(reveal)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                }}
              >
                {copied ? '✓ copied' : 'copy ⌘C'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Keys list */}
      <section className="enter enter-d3 space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="space-y-3">
            <div className="ribbon mb-0">
              <span className="num">03</span>
              <span className="rule" />
              <span className="label">ledger · your keys</span>
            </div>
            <h2 className="display-lg">
              Your keys<span className="text-lime-deep">.</span>
            </h2>
          </div>
        </div>

        {keys.length === 0 ? (
          <div className="card p-12 text-center space-y-3 bg-paper">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-soft">// keystore empty</div>
            <p className="text-[14px] text-muted max-w-md mx-auto leading-relaxed">
              No keys yet. Mint one above to start signing requests from a device.
            </p>
          </div>
        ) : (
          <div className="card overflow-hidden bg-paper">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-[26%]">name</th>
                  <th className="w-[24%]">prefix</th>
                  <th className="w-[16%]">created</th>
                  <th className="w-[18%]">last used</th>
                  <th className="text-right w-[16%]">state</th>
                </tr>
              </thead>
              <tbody>
                {keys.map(k => {
                  const revoked = !!k.revoked_at
                  return (
                    <tr key={k.id} className={revoked ? 'opacity-50' : ''}>
                      <td className="text-ink">
                        <span className="inline-flex items-center gap-2.5 font-medium">
                          <span className={revoked ? 'dot dot-idle' : 'dot'} />
                          {k.name ?? '—'}
                        </span>
                      </td>
                      <td>
                        <code className="font-mono text-[12px] text-ink bg-cream2 border border-line px-2 py-0.5 rounded">
                          {k.prefix}…
                        </code>
                      </td>
                      <td className="text-muted text-[12.5px]">{new Date(k.created_at).toLocaleDateString()}</td>
                      <td className="text-muted text-[12.5px]">{ago(k.last_used_at)}</td>
                      <td className="text-right">
                        {revoked ? (
                          <span className="pill">revoked</span>
                        ) : (
                          <button
                            onClick={() => revoke(k.id)}
                            className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-muted hover:text-coral transition-colors px-3 py-1.5 rounded-full border border-line hover:border-coral/40 bg-paper"
                          >
                            revoke ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
