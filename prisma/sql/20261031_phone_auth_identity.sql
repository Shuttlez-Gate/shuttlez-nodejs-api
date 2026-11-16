-- Additive only. Does not rewrite or delete users, tokens, rides, or wallets.
-- Apply to production only after explicit approval.

ALTER TABLE "UsersSet"
  ADD COLUMN IF NOT EXISTS "FirebasePhoneUid" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "IX_UsersSet_FirebasePhoneUid"
  ON "UsersSet" ("FirebasePhoneUid");

ALTER TABLE "RefreshTokensSet"
  ADD COLUMN IF NOT EXISTS "DeviceId" VARCHAR(128);

ALTER TABLE "RefreshTokensSet"
  ADD COLUMN IF NOT EXISTS "Platform" VARCHAR(32);
