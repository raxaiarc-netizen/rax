import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

type CookieSetter = Array<{ name: string; value: string; options?: CookieOptions }>

/**
 * Per-request Supabase client bound to the user's session cookie. Use in
 * server components and route handlers that need RLS-scoped reads.
 */
export async function supabaseServer() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: CookieSetter) => {
          for (const { name, value, options } of toSet) {
            try {
              cookieStore.set(name, value, options)
            } catch {
              // Server component: cookies are read-only. Caller must use a
              // route handler / middleware to refresh sessions.
            }
          }
        },
      },
    },
  )
}
