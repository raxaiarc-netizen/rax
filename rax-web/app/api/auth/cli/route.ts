import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'

export const runtime = 'nodejs'

/**
 * Entry point for the Electron loopback OAuth flow.
 *   GET /api/auth/cli?port=53682&device=hostname
 *
 *  - If the visitor is signed in, we forward them straight to /api/auth/cli/complete
 *    which mints a key and redirects to http://127.0.0.1:<port>/callback?key=...
 *  - If not signed in, we redirect to /?next=/api/auth/cli/complete?... so they
 *    can sign in and resume the flow.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const port = url.searchParams.get('port')
  const device = url.searchParams.get('device') ?? 'cli'
  if (!port || !/^\d{2,5}$/.test(port)) {
    return NextResponse.json({ error: 'invalid port' }, { status: 400 })
  }
  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  const completeUrl = `/api/auth/cli/complete?port=${port}&device=${encodeURIComponent(device)}`
  const target = user ? completeUrl : `/?next=${encodeURIComponent(completeUrl)}`
  return NextResponse.redirect(new URL(target, url.origin))
}
