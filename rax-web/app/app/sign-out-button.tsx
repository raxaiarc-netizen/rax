'use client'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase-browser'

export default function SignOutButton() {
  const router = useRouter()
  return (
    <button
      className="text-xs text-neutral-400 hover:text-neutral-100"
      onClick={async () => {
        await supabaseBrowser().auth.signOut()
        router.push('/')
        router.refresh()
      }}
    >
      Sign out
    </button>
  )
}
