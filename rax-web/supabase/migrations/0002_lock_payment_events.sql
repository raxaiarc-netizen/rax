-- Lock down the payment_events table. It has no user_id column (it's a
-- webhook idempotency ledger used by the proxy alone), so the correct
-- policy is "no one but service-role". With RLS enabled and no policy
-- granting SELECT, every non-service request returns zero rows.

alter table payment_events enable row level security;
