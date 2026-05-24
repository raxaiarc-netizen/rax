import { supabaseServer } from '@/lib/supabase-server'
import KeysClient from './keys-client'

export default async function KeysPage() {
  const sb = await supabaseServer()
  const { data } = await sb
    .from('api_keys')
    .select('id, prefix, name, last_used_at, revoked_at, created_at')
    .order('created_at', { ascending: false })
  return <KeysClient initial={data ?? []} />
}
