-- Captain-route generated trips, including an admin schedule on a captain-owned route.
-- Identity is the route plus the Africa/Cairo minute of ScheduledAt.
-- Cancelled trips (Status 5) and deleted trips may share that minute so a
-- departure can be generated again. Platform, corridor, route-demand, and
-- shuttle trips on a platform route leave DepartureSlot null and may share a time.
-- Group trips are GroupRequest rows and are not stored here.
-- Safe to re-run. Raises instead of deleting or merging existing duplicates.
-- Do not apply with prisma migrate or prisma db push. prisma db push does not
-- create this partial unique index and can drop it. Run this file manually.

ALTER TABLE "TripsSet"
  ADD COLUMN IF NOT EXISTS "DepartureSlot" character varying(32);

DO $$
DECLARE
  duplicate_count integer;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT t."RouteId",
           to_char(t."ScheduledAt" AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS slot
    FROM "TripsSet" t
    JOIN "RoutesSet" r ON r."Id" = t."RouteId"
    WHERE t."IsDeleted" = false
      AND t."Status" <> 5
      AND r."OwnerType" = 1
    GROUP BY t."RouteId", slot
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'captain route departure duplicates exist (%). Reconcile them before creating the unique index',
      duplicate_count;
  END IF;

  UPDATE "TripsSet" t
  SET "DepartureSlot" = to_char(t."ScheduledAt" AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI')
  FROM "RoutesSet" r
  WHERE t."RouteId" = r."Id"
    AND r."OwnerType" = 1
    AND t."IsDeleted" = false
    AND t."Status" <> 5
    AND t."DepartureSlot" IS NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "UX_TripsSet_Route_DepartureSlot"
  ON "TripsSet" ("RouteId", "DepartureSlot")
  WHERE "IsDeleted" = false
    AND "Status" <> 5
    AND "DepartureSlot" IS NOT NULL;
