-- Each participant's confirmed pickup. Additive. Safe to re-run.

ALTER TABLE "GroupMembersSet"
  ADD COLUMN IF NOT EXISTS "PickupLatitude" double precision;

ALTER TABLE "GroupMembersSet"
  ADD COLUMN IF NOT EXISTS "PickupLongitude" double precision;

ALTER TABLE "GroupMembersSet"
  ADD COLUMN IF NOT EXISTS "PickupAddress" character varying(512);
