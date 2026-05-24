import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase-server'
import SignOutButton from './sign-out-button'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) redirect('/')

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-900 px-6 py-3 flex items-center justify-between text-sm">
        <div className="flex items-center gap-6">
          <Link href="/app/dashboard" className="font-semibold">rax</Link>
          <Link href="/app/dashboard" className="text-neutral-400 hover:text-neutral-100">Dashboard</Link>
          <Link href="/app/keys"      className="text-neutral-400 hover:text-neutral-100">API keys</Link>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-neutral-500">{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 px-6 py-8 max-w-4xl mx-auto w-full">{children}</main>
    </div>
  )
}
