-- Whop subscriptions → monthly credit deposits.
--
-- The flow:
--   1. User clicks "Subscribe — $20/mo" on the dashboard. We open
--      https://whop.com/checkout/<plan>?metadata[user_id]=<uuid>.
--   2. They pay. Whop fires `membership_activated` with our metadata —
--      we INSERT INTO memberships(whop_membership_id, user_id, …).
--   3. Whop also fires `invoice_paid` for the initial charge. We
--      DEPOSIT `amount` cents into credit_ledger.
--   4. Each month, Whop fires another `invoice_paid` (same
--      membership, new invoice id). The membership row gives us the
--      user_id, so we deposit again.
--   5. When the user cancels, Whop fires `membership_deactivated`. We
--      mark the row inactive; no more deposits will land because no
--      more `invoice_paid` events fire for an inactive membership.

create table memberships (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users on delete cascade,
  whop_membership_id  text not null unique,
  whop_product_id     text,
  status              text not null default 'active' check (status in ('active','inactive')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index memberships_user_idx on memberships (user_id);

-- RLS: a signed-in user can read their own memberships row from the
-- dashboard. The service-role webhook handler bypasses RLS to write.
alter table memberships enable row level security;
create policy "own membership r" on memberships for select using (auth.uid() = user_id);
