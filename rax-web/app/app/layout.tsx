import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase-server'
import SignOutButton from './sign-out-button'
import Nav from './nav'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) redirect('/')

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 backdrop-blur-xl bg-[rgba(245,241,232,0.78)] border-b border-line">
        <div className="max-w-[1240px] mx-auto px-5 sm:px-8 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/app/dashboard" className="flex items-center gap-3">
              <span className="brand-mark" aria-hidden />
              <span className="font-display font-bold text-[16px] tracking-[-0.02em] text-ink">rax</span>
              <span className="hidden md:inline-flex items-center gap-1.5 ml-2">
                <span className="dot" />
                <span className="font-mono tracking-[0.18em] text-[10px] uppercase text-muted">online</span>
              </span>
            </Link>
            <span className="hidden md:block text-soft">│</span>
            <Nav />
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-full border border-line bg-paper text-[12px] font-mono">
              <span className="text-soft">◉</span>
              <span className="text-ink">{user.email}</span>
            </div>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="flex-1 px-5 sm:px-8 py-12 sm:py-16 max-w-[1240px] mx-auto w-full">
        {children}
      </main>

      <footer className="px-5 sm:px-8 py-5 border-t border-line bg-paper">
        <div className="max-w-[1240px] mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 font-mono text-[10.5px] tracking-[0.18em] uppercase text-muted">
          <div className="flex items-center gap-3">
            <span>━━</span>
            <span>rax · session active</span>
          </div>
          <div className="flex items-center gap-4">
            <span>v1.0.0</span>
            <span className="text-soft">·</span>
            <Link href="/terms" className="btn-link">terms</Link>
            <Link href="/privacy" className="btn-link">privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
