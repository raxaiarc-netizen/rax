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

export default function KeysClient({ initial }: { initial: Row[] }) {
  const [keys, setKeys] = useState<Row[]>(initial)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [reveal, setReveal] = useState<string | null>(null)
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
    setReveal(j.key); setName('')
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

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <div className="text-xs uppercase text-neutral-500 tracking-wide">Create a key</div>
        <form onSubmit={create} className="flex gap-2 max-w-md">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Key name (e.g. MacBook Air)"
            className="flex-1 rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-600"
          />
          <button
            disabled={busy}
            className="rounded-md bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? '…' : 'Create'}
          </button>
        </form>
        {err && <p className="text-xs text-red-400">{err}</p>}
        {reveal && (
          <div className="rounded-md border border-amber-700/50 bg-amber-900/20 px-4 py-3 text-sm space-y-2">
            <p>Copy this key now — you won't see it again:</p>
            <code className="block break-all font-mono text-xs bg-neutral-950 border border-neutral-800 rounded p-2">{reveal}</code>
            <button
              className="text-xs underline"
              onClick={() => { navigator.clipboard.writeText(reveal); }}
            >
              Copy to clipboard
            </button>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="text-xs uppercase text-neutral-500 tracking-wide">Your keys</div>
        {keys.length === 0 ? (
          <p className="text-sm text-neutral-500">No keys yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-neutral-500 text-left">
              <tr>
                <th className="py-2 font-normal">Name</th>
                <th className="font-normal">Prefix</th>
                <th className="font-normal">Created</th>
                <th className="font-normal">Last used</th>
                <th className="font-normal text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {keys.map(k => (
                <tr key={k.id} className={k.revoked_at ? 'opacity-50' : ''}>
                  <td className="py-2">{k.name ?? '—'}</td>
                  <td className="font-mono text-xs">{k.prefix}…</td>
                  <td className="text-neutral-400">{new Date(k.created_at).toLocaleDateString()}</td>
                  <td className="text-neutral-400">
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}
                  </td>
                  <td className="text-right">
                    {k.revoked_at
                      ? <span className="text-xs text-neutral-500">revoked</span>
                      : <button onClick={() => revoke(k.id)} className="text-xs text-red-400 hover:underline">Revoke</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
