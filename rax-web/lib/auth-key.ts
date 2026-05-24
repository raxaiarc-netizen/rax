import { hashApiKey } from './api-key'
import { supabaseAdmin } from './supabase-admin'

export type ResolvedKey = {
  key_id: string
  user_id: string
}

/** Look up a rax_sk_* key. Returns null if missing or revoked. */
export async function resolveApiKey(plaintext: string): Promise<ResolvedKey | null> {
  const hash = hashApiKey(plaintext)
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('api_keys')
    .select('id, user_id, revoked_at')
    .eq('key_hash', hash)
    .maybeSingle()
  if (error || !data) return null
  if (data.revoked_at) return null
  // Best-effort last_used_at touch (don't await — it's not on the hot path).
  void db.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id)
  return { key_id: data.id, user_id: data.user_id }
}
