import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

type CookieSetter = Array<{ name: string; value: string; options?: CookieOptions }>

/**
 * Refresh Supabase session cookies on every page navigation so server
 * components see an up-to-date session. The Whop webhook is excluded
 * (it must read raw bytes and has no cookie session).
 */
export async function middleware(req: NextRequest) {
  const res = NextResponse.next()
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet: CookieSetter) => {
          for (const { name, value, options } of toSet) {
            res.cookies.set(name, value, options)
          }
        },
      },
    },
  )
  await sb.auth.getUser()
  return res
}

export const config = {
  matcher: ['/((?!_next/|api/whop/webhook|v1/|favicon).*)'],
}
