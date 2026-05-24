# Rax Claude — Hosted API Service Design

Date: 2026-05-21
Status: Approved (pending user review)

## Goal

Sell Claude Code usage to customers by routing their requests through a Rax-owned Anthropic API key. Customers who install the existing Rax Electron app can turn on "Rax mode"; in that mode every `claude -p` request goes through `https://rax-ai.com/v1/messages`, billed against prepaid credits. Customers who choose not to use Rax mode continue to use their own Anthropic credentials with no Rax involvement.

## Decisions

| Decision | Choice |
|---|---|
| Customer artifact | Existing Rax Electron app, with a new "Rax mode" toggle |
| Pricing model | Prepaid credits via Whop (USD), tiers: $20 / $50 / $100 |
| Markup | 30% over Anthropic published per-token prices |
| Currency | USD only in v1; all `*_cents` columns are USD cents |
| Auth (web) | Supabase Auth: email magic link + Google OAuth |
| Proxy auth | Auto-provisioned `rax_sk_...` keys, one per device, stored in macOS Keychain |
| Stack | Single Next.js 15 app on Vercel + Supabase Postgres + Whop |
| v1 scope | Lean MVP — no teams, no analytics charts, no admin panel, no landing page polish |

## System architecture

```
┌─────────────────────┐     ┌──────────────────────────────────────┐
│  Rax Electron app   │     │     Vercel: rax-web (Next.js 15)     │
│  (existing repo)    │     │                                       │
│                     │     │  /                  → marketing/login │
│  ┌───────────────┐  │     │  /app/dashboard     → balance, usage  │
│  │ child_process │  │HTTPS│  /app/keys          → manage rax keys │
│  │ claude -p     │──┼─────┼─→ /v1/messages      → Anthropic proxy │
│  │  ANTHROPIC_   │  │ SSE │  /api/auth/cli      → loopback OAuth  │
│  │  BASE_URL=…   │  │     │  /api/stripe/checkout                 │
│  │  AUTH_TOKEN=…│  │     │  /api/stripe/webhook                  │
│  └───────────────┘  │     │  /api/keys (CRUD)                     │
└─────────────────────┘     └──────────────┬───────────────────────┘
         │ keytar                          │ supabase-js (service-role)
         ▼                                 ▼  stripe-node
   macOS Keychain          ┌──────────────────────────────────┐
                           │  Supabase Postgres (RLS on)      │
                           └──────────────────────────────────┘
                                          ▲
                                          │ webhooks
                                 ┌────────┴────────┐
                                 │     Whop       │
                                 └─────────────────┘

                                 ┌─────────────────┐
                                 │  Anthropic API  │  ← Rax-owned key in Vercel env
                                 └─────────────────┘
```

Three actors, one platform: the Electron app, the Vercel app, Supabase. Whop and Anthropic are external. The Electron app never talks to Supabase or Whop directly — only to the Vercel API.

## Database schema (Supabase Postgres)

```sql
-- 1. Profile (1:1 with auth.users)
create table profiles (
  user_id uuid primary key references auth.users on delete cascade,
  display_name text,
  balance_cents bigint not null default 0,
  created_at timestamptz not null default now()
);

-- 2. API keys (rax_sk_...)
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  prefix text not null,
  key_hash text not null unique,
  name text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on api_keys (key_hash) where revoked_at is null;

-- 3. Credit ledger (append-only)
create table credit_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  delta_cents bigint not null,
  reason text not null,  -- 'stripe_topup'|'request_debit'|'request_refund'|'adjustment'
  request_id uuid,
  stripe_event_id text,
  created_at timestamptz not null default now()
);
create unique index on credit_ledger (stripe_event_id) where stripe_event_id is not null;
create index on credit_ledger (user_id, created_at desc);

-- 4. Request logs
create table request_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  api_key_id uuid references api_keys,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_creation_tokens int not null default 0,
  cost_cents int not null default 0,
  anthropic_cost_cents int not null default 0,
  status text not null,  -- 'pending'|'ok'|'error'|'aborted'
  error_code text,
  latency_ms int,
  created_at timestamptz not null default now()
);
create index on request_logs (user_id, created_at desc);

-- 5. Whop events (idempotency)
create table stripe_events (
  event_id text primary key,
  processed_at timestamptz not null default now()
);
```

`profiles.balance_cents` is a denormalised running balance maintained by the atomic `debit_or_reject` and `credit` SQL functions. The ledger is the source of truth and can rebuild the balance at any time.

RLS is enabled on every `public.*` table with policy `user_id = auth.uid()`. The proxy uses the service-role key, which bypasses RLS.

## Proxy request lifecycle

```
POST /v1/messages   Authorization: Bearer rax_sk_...

 1. Auth     Lookup key by sha256(key) == api_keys.key_hash, revoked_at is null.
             Fire-and-forget update of last_used_at.

 2. Estimate Parse body. Tokenize `messages` locally for exact input count.
             estimate_cents = ceil(
               input_tokens * input_rate(model) * 1.30
             + (max_tokens || 4096) * output_rate(model) * 1.30 )

 3. Debit    Call SQL function debit_or_reject(user_id, estimate_cents, request_id):
               BEGIN
                 INSERT request_logs (status='pending', cost_cents=estimate_cents) RETURNING id;
                 INSERT credit_ledger (delta=-estimate_cents, reason='request_debit', request_id);
                 UPDATE profiles SET balance_cents = balance_cents - estimate_cents
                   WHERE user_id = $1 AND balance_cents >= estimate_cents;
                 IF NOT FOUND THEN ROLLBACK; RETURN false; END IF;
               END
             If rejected → return 402 {error: {type:'insufficient_credits', balance_cents, estimated_cents}}.

 4. Forward  fetch('https://api.anthropic.com/v1/messages', {..., stream:true})
             with server-side ANTHROPIC_API_KEY.

 5. Stream   Pipe SSE chunks to client via ReadableStream. Server-side parse:
               - message_start → cache stats + initial input_tokens
               - message_delta → running output_tokens
             Buffer final usage snapshot.

 6. Reconcile  On stream close (or abort):
               actual_cents = ceil(price(model, usage) * 1.30)
               diff = estimate_cents - actual_cents
               INSERT credit_ledger (delta=+diff, reason='request_refund', request_id)
                  -- or delta=-(extra) reason='request_topup' if actual > estimate
               UPDATE profiles SET balance_cents = balance_cents + diff;
               UPDATE request_logs SET status='ok', tokens, cost_cents, latency_ms.
```

Invariants:
- The balance check and debit are atomic in one statement — no race on parallel requests.
- Estimate ≥ actual in nearly all cases because we tokenize input exactly and use `max_tokens || 4096` for output. So reconcile almost always refunds.
- Aborted streams reconcile against last seen usage; aborts are not free for the user but only the tokens already generated are billed.
- Anthropic error before any tokens → full refund.

Pricing table lives in `src/lib/pricing.ts`. Markup applied in exactly one place. Models supported in v1: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` (cache-read/write rates included per Anthropic's published schedule). Updates ship via redeploy.

Endpoints proxied in v1:
- `POST /v1/messages` — debited
- `POST /v1/messages/count_tokens` — free, passthrough, no debit
- Everything else under `/v1/*` → 404

## Electron app integration

Three changes to the existing repo:

1. **Settings UI** — new "Rax mode" toggle and "Sign in to Rax" button in the existing settings panel.
2. **`src/main/auth/rax.ts` (new)** — loopback OAuth:
   - Start one-shot HTTP server on `127.0.0.1:53682`.
   - Open `https://rax-ai.com/api/auth/cli?port=53682&device=<hostname>` in default browser.
   - Web app: user signs in (Supabase magic link or Google), `/api/auth/cli/complete` mints a new `api_keys` row named after the device, redirects to `http://127.0.0.1:53682/callback?key=rax_sk_...`.
   - App captures key, stores via `keytar.setPassword('rax', user_id, key)`, returns success page, shuts down loopback server.
3. **`src/main/claude/spawn.ts` (modify existing)** — env injection:
   ```ts
   const env = { ...process.env };
   if (settings.raxMode && raxKey) {
     env.ANTHROPIC_BASE_URL = 'https://rax-ai.com';
     env.ANTHROPIC_AUTH_TOKEN = raxKey;
     delete env.ANTHROPIC_API_KEY;
   }
   spawn('claude', ['-p', ...args], { env });
   ```

Claude Code CLI already respects `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; no fork is needed.

## Error handling

| Case | Behaviour |
|---|---|
| Invalid / revoked key | 401 `{error: {type:'invalid_api_key'}}` |
| Insufficient credits | 402 `{error: {type:'insufficient_credits', balance_cents, estimated_cents}}` |
| Anthropic upstream error | Pass status + body verbatim; refund full estimate; `request_logs.status='error'` |
| Client disconnect mid-stream | Reconcile against last `message_delta` usage; `status='aborted'` |
| Webhook replay | `stripe_events` PK on `event_id` blocks duplicate credit |
| Key compromise | Dashboard "Revoke" → `revoked_at`; next request 401 |
| Rate limit | 60 req/min per key in-memory v1; upgrade to Upstash Redis if needed |

## Security

- `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` live only in Vercel env. Never shipped to client bundle, never logged.
- API keys stored in DB as `sha256(key)` only; the plaintext is shown to the user once at creation and never again. The Electron app stores it in macOS Keychain via `keytar`.
- RLS on every public table.
- Whop webhook signature verified on every event.
- CORS on `/v1/*` allows any origin (Claude Code is a CLI from arbitrary hosts); auth is bearer-token only.

## Testing strategy

- **Unit:** `pricing.ts` (input/output × cache × model), tokenizer estimate, key hash/verify.
- **Integration:** proxy happy path (Anthropic mocked), insufficient credits, stream abort, reconcile correctness. Run against `supabase start` local DB.
- **Whop:** `stripe listen` + `stripe trigger` against local dev.
- **Manual smoke:** Electron app → Vercel preview → real Anthropic. Run a 5-minute conversation, verify `sum(ledger.delta) == profile.balance` at end.

## Out of scope for v1

Cut: teams/orgs, third-party tool API keys (Cursor/Cline), usage analytics charts (table only in v1), admin panel, automated refunds, referral program, polished marketing landing page (use generic shadcn template at `/`), email receipts (Whop handles).

## Repository layout

New Next.js app lives in a sibling directory or subfolder; the existing Electron repo gets a new `src/main/auth/rax.ts` and an edited `src/main/claude/spawn.ts`. Final layout:

```
rax/
├── (existing Electron app)
└── rax-web/                  ← new Next.js project
    ├── app/
    │   ├── page.tsx           (login)
    │   ├── app/
    │   │   ├── dashboard/page.tsx
    │   │   └── keys/page.tsx
    │   ├── v1/
    │   │   ├── messages/route.ts
    │   │   └── messages/count_tokens/route.ts
    │   └── api/
    │       ├── auth/cli/route.ts
    │       ├── auth/cli/complete/route.ts
    │       ├── keys/route.ts
    │       ├── stripe/checkout/route.ts
    │       └── stripe/webhook/route.ts
    ├── lib/
    │   ├── pricing.ts
    │   ├── supabase-admin.ts
    │   ├── tokenize.ts
    │   └── proxy.ts
    └── supabase/
        └── migrations/
            └── 0001_init.sql
```
