-- Free tier: the "Rax Default" model (any model id starting with `kimi-`)
-- is free for every signed-in user, capped at:
--   - 100 cents of raw upstream cost per rolling 24h
--   - 400 cents of raw upstream cost per calendar month (UTC)
--
-- Limits are exposed to the renderer as percentages only; the cent figures
-- live server-side and are never sent to the desktop or dashboard. Cents
-- here are RAW Moonshot cost (what we actually pay upstream), not the
-- marked-up customer-facing price — free-tier requests don't bill credits.

set search_path = public;

-- ─── helpers ─────────────────────────────────────────────────────────────

-- Sum raw upstream cost for a user's free-tier requests within a window.
-- Includes 'pending' rows so an in-flight request still counts against the
-- cap (prevents a user from spamming concurrent requests to bypass).
create or replace function free_usage_window_cents(
  p_user_id uuid,
  p_since   timestamptz
) returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(anthropic_cost_cents), 0)::bigint
    from request_logs
   where user_id = p_user_id
     and model like 'kimi-%'
     and status in ('ok', 'pending', 'aborted')
     and created_at >= p_since
$$;

-- Convenience wrapper returning both windows + the limits in one round-trip.
-- The route hands these straight back to the client as percentages.
create or replace function free_usage_summary(
  p_user_id uuid
) returns table (
  day_cents          bigint,
  month_cents        bigint,
  day_limit_cents    bigint,
  month_limit_cents  bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    free_usage_window_cents(p_user_id, now() - interval '24 hours')      as day_cents,
    free_usage_window_cents(p_user_id, date_trunc('month', now() at time zone 'utc')) as month_cents,
    100::bigint  as day_limit_cents,
    400::bigint  as month_limit_cents
$$;

-- ─── quota check + reservation (atomic) ─────────────────────────────────

-- Free-tier analogue of debit_or_reject. Checks both windows; if the new
-- request's estimate fits under both caps, inserts a 'pending' request_log
-- row and returns its id. Returns NULL if either cap would be exceeded.
--
-- Estimate cents passed in is the RAW upstream estimate (not marked up).
-- The pending row records it in anthropic_cost_cents so concurrent requests
-- see the in-flight cost. reconcile_request later updates to the actual.
create or replace function free_quota_check_or_reject(
  p_user_id     uuid,
  p_api_key_id  uuid,
  p_model       text,
  p_estimate    bigint
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id      uuid := gen_random_uuid();
  v_day_cents       bigint;
  v_month_cents     bigint;
  v_day_limit       bigint := 100;
  v_month_limit     bigint := 400;
begin
  -- Sum existing usage (pending + completed) within each window.
  v_day_cents   := free_usage_window_cents(p_user_id, now() - interval '24 hours');
  v_month_cents := free_usage_window_cents(p_user_id, date_trunc('month', now() at time zone 'utc'));

  -- Reject if adding this request's estimate would breach either cap.
  if (v_day_cents   + p_estimate) > v_day_limit   then return null; end if;
  if (v_month_cents + p_estimate) > v_month_limit then return null; end if;

  -- Reserve: insert a pending row carrying the estimate in
  -- anthropic_cost_cents so concurrent quota checks see it.
  -- cost_cents stays 0 — free tier never bills the user.
  insert into request_logs (
    id, user_id, api_key_id, model, cost_cents, anthropic_cost_cents, status
  ) values (
    v_request_id, p_user_id, p_api_key_id, p_model, 0, p_estimate, 'pending'
  );

  return v_request_id;
end
$$;

-- RLS not added to the new functions — they're `security definer` so the
-- service-role route can call them; renderer never invokes them directly.
