-- Additive only. Does not rewrite or delete users, tokens, rides, or wallets.
-- Apply to production only after explicit approval.

ALTER TABLE "UsersSet"
  ADD COLUMN IF NOT EXISTS "PasswordHash" VARCHAR(255);
