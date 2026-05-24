import { NextResponse } from 'next/server'
import { extractKey } from '@/lib/api-key'
import { resolveApiKey } from '@/lib/auth-key'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const ANTHROPIC = 'https://api.anthropic.com/v1/messages/count_tokens'

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 })
}

export async function POST(req: Request) {
  const upstreamKey = process.env.ANTHROPIC_API_KEY
  if (!upstreamKey) {
    return NextResponse.json(
      { type: 'error', error: { type: 'server_misconfigured' } },
      { status: 500 },
    )
  }
  const plaintext = extractKey(req)
  if (!plaintext || !plaintext.startsWith('rax_sk_')) {
    return NextResponse.json(
      { type: 'error', error: { type: 'invalid_api_key' } },
      { status: 401 },
    )
  }
  const resolved = await resolveApiKey(plaintext)
  if (!resolved) {
    return NextResponse.json(
      { type: 'error', error: { type: 'invalid_api_key' } },
      { status: 401 },
    )
  }

  // Free passthrough — Anthropic does not bill count_tokens.
  const body = await req.text()
  const upstream = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': upstreamKey,
      'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01',
    },
    body,
  })
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  })
}
