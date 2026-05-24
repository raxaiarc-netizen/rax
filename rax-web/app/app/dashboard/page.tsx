import { supabaseServer } from '@/lib/supabase-server'
import { TOPUP_OPTIONS } from '@/lib/pricing'
import TopupButtons from './topup-buttons'

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ topup?: string }>
}) {
  const sp = await searchParams
  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  const userId = user!.id

  const [{ data: profile }, { data: recent }] = await Promise.all([
    sb.from('profiles').select('balance_cents').eq('user_id', userId).single(),
    sb.from('request_logs')
      .select('id, model, input_tokens, output_tokens, cost_cents, status, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  const balance = profile?.balance_cents ?? 0

  return (
    <div className="space-y-10">
      {sp.topup === 'success' && (
        <div className="rounded-md border border-emerald-700/50 bg-emerald-900/20 px-4 py-3 text-sm">
          Top-up succeeded. Your balance reflects the new credit.
        </div>
      )}
      {sp.topup === 'cancel' && (
        <div className="rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm">
          Top-up cancelled. No changes were made.
        </div>
      )}

      <section className="space-y-2">
        <div className="text-xs uppercase text-neutral-500 tracking-wide">Balance</div>
        <div className="text-5xl font-semibold tabular-nums">{fmtUsd(balance)}</div>
        <p className="text-sm text-neutral-400">
          Subscribe to a tier and the matching credits land in your balance
          every month. Cancel any time from Whop.
        </p>
        <TopupButtons options={TOPUP_OPTIONS} />
      </section>

      <section className="space-y-3">
        <div className="text-xs uppercase text-neutral-500 tracking-wide">Recent requests</div>
        {(!recent || recent.length === 0) ? (
          <p className="text-sm text-neutral-500">No requests yet. Sign in to Rax from the desktop app and run a Claude Code conversation.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-neutral-500 text-left">
              <tr>
                <th className="py-2 font-normal">Time</th>
                <th className="font-normal">Model</th>
                <th className="font-normal text-right">In</th>
                <th className="font-normal text-right">Out</th>
                <th className="font-normal text-right">Cost</th>
                <th className="font-normal text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {recent.map(r => (
                <tr key={r.id}>
                  <td className="py-2 text-neutral-400">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="font-mono text-xs">{r.model}</td>
                  <td className="text-right tabular-nums">{r.input_tokens.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{r.output_tokens.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{fmtUsd(r.cost_cents)}</td>
                  <td className="text-right text-xs">
                    <span className={
                      r.status === 'ok' ? 'text-emerald-400' :
                      r.status === 'error' ? 'text-red-400' :
                      r.status === 'aborted' ? 'text-amber-400' : 'text-neutral-500'
                    }>{r.status}</span>
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
