import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'
import { tiers, whopCheckoutUrl } from '@/lib/whop'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const { cents } = await req.json().catch(() => ({}))
  const tier = tiers().find((t) => t.cents === Number(cents))
  if (!tier) return NextResponse.json({ error: 'invalid_tier' }, { status: 400 })

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin

  try {
    const url = await whopCheckoutUrl(
      tier.plan_id,
      { user_id: user.id, cents: tier.cents },
      `${origin}/app/dashboard?topup=success`,
    )
    return NextResponse.json({ url })
  } catch (e: any) {
    console.error('[whop/checkout] session create failed:', e?.message ?? e)
    return NextResponse.json({ error: 'checkout_session_failed' }, { status: 502 })
  }
}
