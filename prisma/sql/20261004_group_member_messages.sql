-- Shared text chat between two members of the same group. Additive. Safe to re-run.

CREATE TABLE IF NOT EXISTS "GroupMemberMessagesSet" (
  "Id" uuid PRIMARY KEY,
  "GroupRequestId" uuid NOT NULL,
  "SenderUserId" uuid NOT NULL,
  "RecipientUserId" uuid NOT NULL,
  "Body" character varying(2000) NOT NULL,
  "CreatedAt" timestamptz NOT NULL,
  "UpdatedAt" timestamptz,
  "IsDeleted" boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS "IX_GroupMemberMessagesSet_Thread"
  ON "GroupMemberMessagesSet" ("GroupRequestId", "SenderUserId", "RecipientUserId");

CREATE INDEX IF NOT EXISTS "IX_GroupMemberMessagesSet_GroupRequestId_CreatedAt"
  ON "GroupMemberMessagesSet" ("GroupRequestId", "CreatedAt");
