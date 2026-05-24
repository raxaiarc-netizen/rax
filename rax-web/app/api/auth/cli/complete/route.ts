import { NextResponse } from 'next/server'
import { generateApiKey } from '@/lib/api-key'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { supabaseServer } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const port = url.searchParams.get('port')
  const device = url.searchParams.get('device') ?? 'cli'
  if (!port || !/^\d{2,5}$/.test(port)) {
    return NextResponse.json({ error: 'invalid port' }, { status: 400 })
  }

  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL(`/?next=${encodeURIComponent(url.pathname + url.search)}`, url.origin))
  }

  const { plaintext, prefix, hash } = generateApiKey()
  const db = supabaseAdmin()
  const { error } = await db.from('api_keys').insert({
    user_id: user.id,
    prefix,
    key_hash: hash,
    name: device,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Redirect back to the local loopback. Localhost only — the Electron
  // app shuts the server down as soon as it captures the key.
  const callback = `http://127.0.0.1:${port}/callback?key=${encodeURIComponent(plaintext)}`
  return NextResponse.redirect(callback)
}
