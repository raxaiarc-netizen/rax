-- Rax cloud schema
-- All money is in USD cents (bigint to be safe with high-volume accounts).

set search_path = public;

create extension if not exists pgcrypto;

-- ─── profiles ─────────────────────────────────────────────────────────────
create table profiles (
  user_id        uuid primary key references auth.users on delete cascade,
  display_name   text,
  balance_cents  bigint not null default 0,
  created_at     timestamptz not null default now()
);

-- ─── api_keys ────────────────────────────────────────────────────────────
create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  prefix       text not null,
  key_hash     text not null unique,
  name         text,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index api_keys_active_hash_idx on api_keys (key_hash) where revoked_at is null;
create index api_keys_user_idx on api_keys (user_id);

-- ─── credit_ledger ───────────────────────────────────────────────────────
create table credit_ledger (
  id              bigserial primary key,
  user_id         uuid not null references auth.users on delete cascade,
  delta_cents     bigint not null,
  reason          text not null check (reason in ('whop_topup','request_debit','request_refund','request_topup','adjustment')),
  request_id      uuid,
  payment_event_id text,
  created_at      timestamptz not null default now()
);
create unique index credit_ledger_payment_event_uq on credit_ledger (payment_event_id) where payment_event_id is not null;
create index credit_ledger_user_time_idx on credit_ledger (user_id, created_at desc);

-- ─── request_logs ────────────────────────────────────────────────────────
create table request_logs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users on delete cascade,
  api_key_id            uuid references api_keys,
  model                 text not null,
  input_tokens          int  not null default 0,
  output_tokens         int  not null default 0,
  cache_read_tokens     int  not null default 0,
  cache_creation_tokens int  not null default 0,
  cost_cents            int  not null default 0,
  anthropic_cost_cents  int  not null default 0,
  status                text not null check (status in ('pending','ok','error','aborted')),
  error_code            text,
  latency_ms            int,
  created_at            timestamptz not null default now()
);
create index request_logs_user_time_idx on request_logs (user_id, created_at desc);

-- ─── payment_events (idempotency across payment providers) ──────────────
create table payment_events (
  event_id     text primary key,
  provider     text not null,
  processed_at timestamptz not null default now()
);

-- ─── atomic billing functions ────────────────────────────────────────────

-- Reserve estimate; create pending request log + matching ledger row.
-- Returns request_id on success, NULL if insufficient balance.
create or replace function debit_or_reject(
  p_user_id      uuid,
  p_api_key_id   uuid,
  p_model        text,
  p_estimate     bigint
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id uuid := gen_random_uuid();
  v_updated    int;
begin
  update profiles
     set balance_cents = balance_cents - p_estimate
   where user_id = p_user_id
     and balance_cents >= p_estimate;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return null;
  end if;

  insert into request_logs (id, user_id, api_key_id, model, cost_cents, status)
  values (v_request_id, p_user_id, p_api_key_id, p_model, p_estimate, 'pending');

  insert into credit_ledger (user_id, delta_cents, reason, request_id)
  values (p_user_id, -p_estimate, 'request_debit', v_request_id);

  return v_request_id;
end
$$;

-- Reconcile a pending request to its actual cost.
create or replace function reconcile_request(
  p_request_id            uuid,
  p_estimate              bigint,
  p_actual_cost_cents     bigint,
  p_anthropic_cost_cents  bigint,
  p_input_tokens          int,
  p_output_tokens         int,
  p_cache_read_tokens     int,
  p_cache_creation_tokens int,
  p_latency_ms            int,
  p_status                text,
  p_error_code            text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_diff    bigint;
begin
  select user_id into v_user_id from request_logs where id = p_request_id;
  if v_user_id is null then return; end if;

  v_diff := p_estimate - p_actual_cost_cents;

  update request_logs
     set status               = p_status,
         error_code           = p_error_code,
         cost_cents           = p_actual_cost_cents,
         anthropic_cost_cents = p_anthropic_cost_cents,
         input_tokens         = p_input_tokens,
         output_tokens        = p_output_tokens,
         cache_read_tokens    = p_cache_read_tokens,
         cache_creation_tokens= p_cache_creation_tokens,
         latency_ms           = p_latency_ms
   where id = p_request_id;

  if v_diff <> 0 then
    insert into credit_ledger (user_id, delta_cents, reason, request_id)
    values (v_user_id,
            v_diff,
            case when v_diff > 0 then 'request_refund' else 'request_topup' end,
            p_request_id);
    update profiles
       set balance_cents = balance_cents + v_diff
     where user_id = v_user_id;
  end if;
end
$$;

-- Idempotent payment top-up (provider = 'whop' today, room for others later).
create or replace function apply_topup(
  p_user_id    uuid,
  p_event_id   text,
  p_amount     bigint,
  p_provider   text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Idempotency guard: if we've already processed this payment event, no-op.
  begin
    insert into payment_events (event_id, provider) values (p_event_id, p_provider);
  exception when unique_violation then
    return false;
  end;

  insert into credit_ledger (user_id, delta_cents, reason, payment_event_id)
  values (p_user_id, p_amount, p_provider || '_topup', p_event_id);

  update profiles set balance_cents = balance_cents + p_amount where user_id = p_user_id;
  return true;
end
$$;

-- Auto-create a profile row when a new auth.user is inserted.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─── RLS ────────────────────────────────────────────────────────────────
alter table profiles       enable row level security;
alter table api_keys       enable row level security;
alter table credit_ledger  enable row level security;
alter table request_logs   enable row level security;

create policy "own profile"   on profiles      for select using (auth.uid() = user_id);
create policy "own keys r"    on api_keys      for select using (auth.uid() = user_id);
create policy "own keys w"    on api_keys      for update using (auth.uid() = user_id);
create policy "own ledger r"  on credit_ledger for select using (auth.uid() = user_id);
create policy "own requests r" on request_logs for select using (auth.uid() = user_id);

-- Service role (used by Next.js server) bypasses RLS automatically.
