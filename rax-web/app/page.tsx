import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase-server'
import LoginForm from './login-form'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (user) redirect(next ?? '/app/dashboard')

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">rax</h1>
          <p className="text-sm text-neutral-400">
            Claude Code, billed by the token. Sign in to get started.
          </p>
        </div>
        <LoginForm next={next ?? '/app/dashboard'} />
        <p className="text-xs text-neutral-500">
          By signing in you agree to{' '}
          <Link href="/terms" className="underline">terms</Link> and{' '}
          <Link href="/privacy" className="underline">privacy</Link>.
        </p>
      </div>
    </main>
  )
}
