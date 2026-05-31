'use client'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase-browser'

export default function SignOutButton() {
  const router = useRouter()
  return (
    <button
      className="font-mono text-[11px] tracking-[0.18em] uppercase text-muted hover:text-ink transition-colors px-3 py-1.5 rounded-full border border-line hover:border-line-2 bg-paper"
      onClick={async () => {
        await supabaseBrowser().auth.signOut()
        router.push('/')
        router.refresh()
      }}
    >
      sign out ↪
    </button>
  )
}
