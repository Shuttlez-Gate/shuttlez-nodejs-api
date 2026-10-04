-- Unread flag for member-to-member group chat. Additive. Safe to re-run.

ALTER TABLE "GroupMemberMessagesSet"
  ADD COLUMN IF NOT EXISTS "ReadAt" timestamptz;
