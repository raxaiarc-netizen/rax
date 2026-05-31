import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase-server'
import LoginForm from '../login-form'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const target = next ?? '/app/dashboard'

  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (user) redirect(target)

  return (
    <main className="relative min-h-screen flex flex-col overflow-x-hidden">
      <header className="px-5 sm:px-8 pt-5 sm:pt-7 pb-2">
        <div className="max-w-[1240px] mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <span className="brand-mark brand-mark-lg" aria-hidden />
            <span className="font-display font-bold text-[20px] tracking-[-0.02em] text-ink">rax</span>
          </Link>
          <Link href="/" className="btn-link text-[14px]">← home</Link>
        </div>
      </header>

      <section className="px-5 sm:px-8 pt-10 sm:pt-16 pb-20 flex-1">
        <div className="max-w-[640px] mx-auto card p-7 sm:p-8 bg-paper">
          <div className="flex items-center justify-between mb-5">
            <div>
              <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-muted">
                already have an account?
              </div>
              <h1 className="display-md mt-1">Welcome back.</h1>
            </div>
            <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-soft">↳ 0x01</span>
          </div>
          <LoginForm next={target} />
        </div>
      </section>

      <footer className="px-5 sm:px-8 py-8 border-t border-line bg-paper mt-auto">
        <div className="max-w-[1240px] mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 font-mono text-[11.5px] tracking-[0.02em] text-muted">
          <div className="flex items-center gap-3">
            <span className="brand-mark scale-75 origin-left" aria-hidden />
            <span>© {new Date().getFullYear()} rax</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/terms" className="btn-link">terms</Link>
            <Link href="/privacy" className="btn-link">privacy</Link>
            <Link href="/" className="btn-link">home</Link>
          </div>
        </div>
      </footer>
    </main>
  )
}
