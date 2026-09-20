-- Additive Captain Routes Marketplace schema.
-- Run manually against Neon. Do NOT prisma db push or prisma migrate reset.

BEGIN;

ALTER TABLE "RoutesSet" ADD COLUMN IF NOT EXISTS "OwnerType" integer NOT NULL DEFAULT 0;
ALTER TABLE "RoutesSet" ADD COLUMN IF NOT EXISTS "OwnerDriverId" uuid;
ALTER TABLE "RoutesSet" ADD COLUMN IF NOT EXISTS "PublishStatus" integer NOT NULL DEFAULT 1;
ALTER TABLE "RoutesSet" ADD COLUMN IF NOT EXISTS "ShareToken" varchar(64);
ALTER TABLE "RoutesSet" ADD COLUMN IF NOT EXISTS "VehicleKind" text;
ALTER TABLE "RoutesSet" ADD COLUMN IF NOT EXISTS "Capacity" integer;

CREATE UNIQUE INDEX IF NOT EXISTS "IX_RoutesSet_ShareToken"
  ON "RoutesSet" ("ShareToken")
  WHERE "ShareToken" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "IX_RoutesSet_OwnerDriverId"
  ON "RoutesSet" ("OwnerDriverId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_RoutesSet_DriversSet_OwnerDriverId'
  ) THEN
    ALTER TABLE "RoutesSet"
      ADD CONSTRAINT "FK_RoutesSet_DriversSet_OwnerDriverId"
      FOREIGN KEY ("OwnerDriverId") REFERENCES "DriversSet"("Id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

ALTER TABLE "TripsSet" ADD COLUMN IF NOT EXISTS "ParentTripId" uuid;
ALTER TABLE "TripsSet" ADD COLUMN IF NOT EXISTS "RecurrenceKind" integer NOT NULL DEFAULT 0;
ALTER TABLE "TripsSet" ADD COLUMN IF NOT EXISTS "RecurrenceDaysOfWeek" varchar(32);
ALTER TABLE "TripsSet" ADD COLUMN IF NOT EXISTS "RecurrenceStartDate" date;
ALTER TABLE "TripsSet" ADD COLUMN IF NOT EXISTS "RecurrenceEndDate" date;

CREATE INDEX IF NOT EXISTS "IX_TripsSet_ParentTripId" ON "TripsSet" ("ParentTripId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_TripsSet_TripsSet_ParentTripId'
  ) THEN
    ALTER TABLE "TripsSet"
      ADD CONSTRAINT "FK_TripsSet_TripsSet_ParentTripId"
      FOREIGN KEY ("ParentTripId") REFERENCES "TripsSet"("Id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

ALTER TABLE "BookingsSet" ADD COLUMN IF NOT EXISTS "OriginStopId" uuid;
ALTER TABLE "BookingsSet" ADD COLUMN IF NOT EXISTS "DestinationStopId" uuid;

CREATE INDEX IF NOT EXISTS "IX_BookingsSet_OriginStopId" ON "BookingsSet" ("OriginStopId");
CREATE INDEX IF NOT EXISTS "IX_BookingsSet_DestinationStopId" ON "BookingsSet" ("DestinationStopId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_BookingsSet_StopsSet_OriginStopId'
  ) THEN
    ALTER TABLE "BookingsSet"
      ADD CONSTRAINT "FK_BookingsSet_StopsSet_OriginStopId"
      FOREIGN KEY ("OriginStopId") REFERENCES "StopsSet"("Id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_BookingsSet_StopsSet_DestinationStopId'
  ) THEN
    ALTER TABLE "BookingsSet"
      ADD CONSTRAINT "FK_BookingsSet_StopsSet_DestinationStopId"
      FOREIGN KEY ("DestinationStopId") REFERENCES "StopsSet"("Id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

ALTER TABLE "RouteRequestsSet"
  ADD COLUMN IF NOT EXISTS "Kind" varchar(16) NOT NULL DEFAULT 'request';

CREATE TABLE IF NOT EXISTS "TripSegmentInventorySet" (
  "Id" uuid NOT NULL,
  "TripId" uuid NOT NULL,
  "FromStopId" uuid NOT NULL,
  "ToStopId" uuid NOT NULL,
  "FromOrder" integer NOT NULL,
  "ToOrder" integer NOT NULL,
  "Capacity" integer NOT NULL,
  "RemainingSeats" integer NOT NULL,
  "CreatedAt" timestamptz(6) NOT NULL,
  "UpdatedAt" timestamptz(6),
  "IsDeleted" boolean NOT NULL,
  CONSTRAINT "PK_TripSegmentInventorySet" PRIMARY KEY ("Id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_TripSegmentInventorySet_Trip_From_To"
  ON "TripSegmentInventorySet" ("TripId", "FromStopId", "ToStopId")
  WHERE "IsDeleted" = false;

CREATE INDEX IF NOT EXISTS "IX_TripSegmentInventorySet_TripId"
  ON "TripSegmentInventorySet" ("TripId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_TripSegmentInventorySet_TripsSet_TripId'
  ) THEN
    ALTER TABLE "TripSegmentInventorySet"
      ADD CONSTRAINT "FK_TripSegmentInventorySet_TripsSet_TripId"
      FOREIGN KEY ("TripId") REFERENCES "TripsSet"("Id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_TripSegmentInventorySet_StopsSet_FromStopId'
  ) THEN
    ALTER TABLE "TripSegmentInventorySet"
      ADD CONSTRAINT "FK_TripSegmentInventorySet_StopsSet_FromStopId"
      FOREIGN KEY ("FromStopId") REFERENCES "StopsSet"("Id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_TripSegmentInventorySet_StopsSet_ToStopId'
  ) THEN
    ALTER TABLE "TripSegmentInventorySet"
      ADD CONSTRAINT "FK_TripSegmentInventorySet_StopsSet_ToStopId"
      FOREIGN KEY ("ToStopId") REFERENCES "StopsSet"("Id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CancellationRequestsSet" (
  "Id" uuid NOT NULL,
  "TripId" uuid NOT NULL,
  "DriverId" uuid NOT NULL,
  "Reason" text,
  "Status" integer NOT NULL DEFAULT 0,
  "AdminNotes" text,
  "CreatedAt" timestamptz(6) NOT NULL,
  "UpdatedAt" timestamptz(6),
  "IsDeleted" boolean NOT NULL,
  CONSTRAINT "PK_CancellationRequestsSet" PRIMARY KEY ("Id")
);

CREATE INDEX IF NOT EXISTS "IX_CancellationRequestsSet_TripId"
  ON "CancellationRequestsSet" ("TripId");
CREATE INDEX IF NOT EXISTS "IX_CancellationRequestsSet_DriverId"
  ON "CancellationRequestsSet" ("DriverId");
CREATE INDEX IF NOT EXISTS "IX_CancellationRequestsSet_Status"
  ON "CancellationRequestsSet" ("Status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_CancellationRequestsSet_TripsSet_TripId'
  ) THEN
    ALTER TABLE "CancellationRequestsSet"
      ADD CONSTRAINT "FK_CancellationRequestsSet_TripsSet_TripId"
      FOREIGN KEY ("TripId") REFERENCES "TripsSet"("Id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_CancellationRequestsSet_DriversSet_DriverId'
  ) THEN
    ALTER TABLE "CancellationRequestsSet"
      ADD CONSTRAINT "FK_CancellationRequestsSet_DriversSet_DriverId"
      FOREIGN KEY ("DriverId") REFERENCES "DriversSet"("Id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

COMMIT;
