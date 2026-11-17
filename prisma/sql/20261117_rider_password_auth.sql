-- Rider password login uses the existing UsersSet.PasswordHash column.
-- This statement is additive. It does not update, reset, or delete any user,
-- booking, trip, wallet, or token row. Accounts with a NULL hash stay NULL.
-- Apply to production only after explicit approval.

ALTER TABLE "UsersSet"
  ADD COLUMN IF NOT EXISTS "PasswordHash" VARCHAR(255);
