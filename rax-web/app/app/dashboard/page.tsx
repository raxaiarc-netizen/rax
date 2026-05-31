import { supabaseServer } from '@/lib/supabase-server'
import { TOPUP_OPTIONS } from '@/lib/pricing'
import TopupButtons from './topup-buttons'

function fmtUsd(cents: number): { whole: string; frac: string } {
  const usd = cents / 100
  const whole = Math.trunc(usd).toLocaleString()
  const frac = (Math.abs(usd) - Math.trunc(Math.abs(usd))).toFixed(2).slice(2)
  return { whole, frac }
}

function fmtUsdShort(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function ago(iso: string): string {
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

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-(\d{8})$/, '')
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

  const [{ data: profile }, { data: recent }, { data: freeUsage }] = await Promise.all([
    sb.from('profiles').select('balance_cents').eq('user_id', userId).single(),
    sb.from('request_logs')
      .select('id, model, input_tokens, output_tokens, cost_cents, status, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
    sb.rpc('free_usage_summary', { p_user_id: userId }),
  ])

  // The underlying cents stay server-side; we only forward percentages.
  const usageRow = Array.isArray(freeUsage) ? freeUsage[0] : freeUsage
  const dayPct   = pctFromCents(usageRow?.day_cents,   usageRow?.day_limit_cents)
  const monthPct = pctFromCents(usageRow?.month_cents, usageRow?.month_limit_cents)

  const balance = profile?.balance_cents ?? 0
  const { whole, frac } = fmtUsd(balance)

  const totalRequests = recent?.length ?? 0
  const totalTokens = recent?.reduce((s, r) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0) ?? 0
  const totalSpent = recent?.reduce((s, r) => s + (r.cost_cents ?? 0), 0) ?? 0

  return (
    <div className="space-y-16">
      {/* Status banners */}
      {sp.topup === 'success' && (
        <div className="enter rounded-2xl border border-lime-deep/30 bg-[rgba(207,255,186,0.45)] px-5 py-4 text-[14px] flex items-center gap-3">
          <span className="dot" />
          <span className="text-lime-deep font-mono tracking-[0.18em] uppercase text-[10.5px]">ack ·</span>
          <span className="text-ink">Top-up succeeded. Your balance reflects the new credit.</span>
        </div>
      )}
      {sp.topup === 'cancel' && (
        <div className="enter rounded-2xl border border-line-2 bg-paper px-5 py-4 text-[14px] flex items-center gap-3">
          <span className="dot dot-idle" />
          <span className="text-muted font-mono tracking-[0.18em] uppercase text-[10.5px]">cancel ·</span>
          <span className="text-ink">Top-up cancelled. No changes were made.</span>
        </div>
      )}

      {/* Page header */}
      <div className="enter enter-d1 space-y-3">
        <div className="ribbon">
          <span className="num">01</span>
          <span className="rule" />
          <span className="label">ledger · live balance + activity</span>
        </div>
        <h1 className="display-xl">
          Dashboard<span className="text-lime-deep">.</span>
        </h1>
      </div>

      {/* Balance hero */}
      <section className="enter enter-d2 card overflow-hidden p-8 sm:p-12 bg-paper">
        <div className="grid lg:grid-cols-[1.5fr_1fr] gap-10 items-end">
          <div className="space-y-5">
            <div className="flex items-center gap-2.5">
              <span className="dot" />
              <span className="kicker">balance · live</span>
              <span className="text-soft">·</span>
              <span className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-muted">usd</span>
            </div>

            <div className="flex items-baseline leading-none">
              <span className="font-display font-bold text-lime-deep text-[clamp(2.4rem,5vw,3.6rem)] mr-3 -translate-y-2 inline-block tracking-[-0.04em]">
                $
              </span>
              <span className="readout text-[clamp(5rem,14vw,9rem)] leading-none">{whole}</span>
              <span className="readout text-[clamp(2.2rem,5.5vw,3.5rem)] leading-none ml-1 opacity-90">.{frac}</span>
              <span className="caret -translate-y-2" aria-hidden />
            </div>

            <p className="text-[14px] text-muted max-w-[48ch] leading-relaxed">
              Credits remaining. Anthropic published rates plus 30%. Subscribe to a tier
              below and your credits land next month — cancel any time, your balance
              never expires.
            </p>
          </div>

          <div className="grid grid-cols-3 lg:grid-cols-1 gap-3 lg:border-l lg:border-line lg:pl-10">
            <Stat label="requests · 50" value={totalRequests.toString()} />
            <Stat label="tokens billed" value={totalTokens.toLocaleString()} />
            <Stat label="spent · window" value={fmtUsdShort(totalSpent)} />
          </div>
        </div>
      </section>

      {/* Rax Default limits — percent-only, no $ */}
      <section className="enter enter-d2 card overflow-hidden p-7 sm:p-9 bg-paper">
        <div className="flex items-end justify-between gap-4 flex-wrap mb-6">
          <div className="space-y-2">
            <div className="font-mono text-[10.5px] tracking-[0.2em] uppercase text-muted">
              rax default · usage
            </div>
            <h2 className="display-md">Limits<span className="text-lime-deep">.</span></h2>
          </div>
          <span className="hidden sm:flex items-center gap-2 font-mono text-[11px] text-muted tracking-[0.12em]">
            <span className="dot" /> resets automatically
          </span>
        </div>
        <div className="grid sm:grid-cols-2 gap-8 sm:gap-12">
          <LimitBar label="daily limit"   pct={dayPct}   sub="rolls over every 24h" />
          <LimitBar label="monthly limit" pct={monthPct} sub="rolls over on the 1st" />
        </div>
      </section>

      {/* Tiers */}
      <section className="enter enter-d3 space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="space-y-3">
            <div className="ribbon mb-0">
              <span className="num">02</span>
              <span className="rule" />
              <span className="label">refuel · subscribe</span>
            </div>
            <h2 className="display-lg">
              Pick a tier<span className="text-lime-deep">.</span>
            </h2>
          </div>
          <span className="hidden sm:block font-mono text-[11px] text-muted tracking-[0.12em]">
            credits land each month · cancel anytime
          </span>
        </div>
        <TopupButtons options={TOPUP_OPTIONS} />
      </section>

      {/* Recent requests */}
      <section className="enter enter-d4 space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="space-y-3">
            <div className="ribbon mb-0">
              <span className="num">03</span>
              <span className="rule" />
              <span className="label">activity · request tail</span>
            </div>
            <h2 className="display-lg">
              Recent requests<span className="text-lime-deep">.</span>
            </h2>
          </div>
          <span className="hidden sm:flex items-center gap-2 font-mono text-[11px] text-muted tracking-[0.12em]">
            <span className="dot" /> tail · last 50
          </span>
        </div>

        {!recent || recent.length === 0 ? (
          <div className="card p-12 text-center space-y-3 bg-paper">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-soft">// no traffic yet</div>
            <p className="text-[14px] text-muted max-w-md mx-auto leading-relaxed">
              Sign in to Rax from the desktop app and run a Claude Code
              conversation — every request shows up here.
            </p>
          </div>
        ) : (
          <div className="card overflow-hidden bg-paper">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-[14%]">time</th>
                  <th className="w-[24%]">model</th>
                  <th className="text-right w-[14%]">input</th>
                  <th className="text-right w-[14%]">output</th>
                  <th className="text-right w-[14%]">cost</th>
                  <th className="text-right w-[20%]">status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(r => (
                  <tr key={r.id}>
                    <td className="text-muted">{ago(r.created_at)}</td>
                    <td>
                      <span className="text-ink font-medium">{shortModel(r.model)}</span>
                    </td>
                    <td className="text-right text-muted">{r.input_tokens.toLocaleString()}</td>
                    <td className="text-right text-muted">{r.output_tokens.toLocaleString()}</td>
                    <td className="text-right text-ink font-semibold">{fmtUsdShort(r.cost_cents)}</td>
                    <td className="text-right">
                      <StatusPill status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function pctFromCents(used: unknown, limit: unknown): number {
  const u = Number(used ?? 0)
  const l = Number(limit ?? 0)
  if (l <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((u / l) * 100)))
}

function LimitBar({ label, pct, sub }: { label: string; pct: number; sub: string }) {
  // Colour shifts as the bar fills so the user feels the gauge running out
  // without ever seeing a number larger than 100.
  const tone =
    pct >= 95 ? 'bg-coral'
    : pct >= 80 ? 'bg-butter'
    : 'bg-lime'
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[10.5px] tracking-[0.2em] uppercase text-muted">{label}</div>
        <div className="font-display font-bold text-[22px] tabnums text-ink leading-none tracking-[-0.02em]">
          {pct}<span className="text-[14px] text-muted font-normal ml-0.5">%</span>
        </div>
      </div>
      <div className="relative h-2 rounded-full bg-cream2 overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 ${tone} rounded-full transition-all duration-500`}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-soft">{sub}</div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5 py-2">
      <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-muted">{label}</div>
      <div className="font-display font-bold text-[clamp(1.8rem,2.8vw,2.6rem)] tabnums text-ink leading-none tracking-[-0.03em]">
        {value}
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  if (status === 'ok') {
    return (
      <span className="pill pill-ok">
        <span className="dot" /> ok
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="pill pill-error">
        <span className="dot dot-coral" /> err
      </span>
    )
  }
  if (status === 'aborted') {
    return (
      <span className="pill pill-warn">
        <span className="dot dot-butter" /> abort
      </span>
    )
  }
  return (
    <span className="pill">
      <span className="dot dot-idle" /> {status}
    </span>
  )
}
