-- Trip history list indexes.
-- Justified by the history queries:
--   rider shuttle: BookingsSet.UserId + IsDeleted = false, then TripsSet by primary key
--   captain shuttle: TripsSet.DriverId + IsDeleted = false ORDER BY ScheduledAt DESC, Id DESC
--   rides: RiderUserId or DriverId + IsDeleted = false
--          ORDER BY COALESCE(ScheduledFor, StartedAt, CreatedAt) DESC, Id DESC
--   groups: DriverId or member UserId + IsDeleted = false
-- Additive. Does not rewrite or delete rows.

CREATE INDEX IF NOT EXISTS "IX_TripsSet_Driver_Schedule"
  ON "TripsSet" ("DriverId", "ScheduledAt" DESC, "Id" DESC)
  WHERE "IsDeleted" = false AND "DriverId" IS NOT NULL;

-- Rider history filters UserId + IsDeleted, then joins TripsSet by TripId.
-- Page order is the trip departure, so CreatedAt is not the sort key.
-- Existing IX_BookingsSet_UserId_CreatedAt already starts with UserId.
-- This partial index matches the join used after that filter.
CREATE INDEX IF NOT EXISTS "IX_BookingsSet_User_Active"
  ON "BookingsSet" ("UserId", "TripId")
  WHERE "IsDeleted" = false;

CREATE INDEX IF NOT EXISTS "IX_RideRequestsSet_Rider_Sort"
  ON "RideRequestsSet" (
    "RiderUserId",
    (COALESCE("ScheduledFor", "StartedAt", "CreatedAt")) DESC,
    "Id" DESC
  )
  WHERE "IsDeleted" = false;

CREATE INDEX IF NOT EXISTS "IX_RideRequestsSet_Driver_Sort"
  ON "RideRequestsSet" (
    "DriverId",
    (COALESCE("ScheduledFor", "StartedAt", "CreatedAt")) DESC,
    "Id" DESC
  )
  WHERE "IsDeleted" = false AND "DriverId" IS NOT NULL;

-- Captain group history sorts by COALESCE(StartedAt, CreatedAt), not CreatedAt alone.
CREATE INDEX IF NOT EXISTS "IX_GroupRequestsSet_Driver_Sort"
  ON "GroupRequestsSet" (
    "DriverId",
    (COALESCE("StartedAt", "CreatedAt")) DESC,
    "Id" DESC
  )
  WHERE "IsDeleted" = false AND "DriverId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "IX_GroupMembersSet_User_Active"
  ON "GroupMembersSet" ("UserId", "GroupRequestId")
  WHERE "IsDeleted" = false;
