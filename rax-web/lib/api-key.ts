import { createHash, randomBytes } from 'crypto'

/**
 * Format: rax_sk_<32 url-safe base64 chars>
 * The plaintext is shown to the user once at creation and never persisted.
 * We store only sha256(plaintext) and a 12-char display prefix.
 */
export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const raw = randomBytes(24).toString('base64url') // 32 chars
  const plaintext = `rax_sk_${raw}`
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: hashApiKey(plaintext),
  }
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

/** Extract a bearer token from common header shapes. */
export function extractKey(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m) return m[1].trim()
  }
  const xkey = req.headers.get('x-api-key')
  if (xkey) return xkey.trim()
  return null
}
