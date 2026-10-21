-- Additive Trip History read model.
-- One row per shuttle trip, ride, or group. Safe to re-run.
-- Does not delete operational data.

CREATE TABLE IF NOT EXISTS "TripHistoryReadModel" (
  "Id" uuid PRIMARY KEY,
  "SourceType" character varying(16) NOT NULL,
  "SourceId" uuid NOT NULL,
  "OriginName" character varying(512),
  "OriginLatitude" double precision,
  "OriginLongitude" double precision,
  "DestinationName" character varying(512),
  "DestinationLatitude" double precision,
  "DestinationLongitude" double precision,
  "DepartureAt" timestamp with time zone NOT NULL,
  "Status" integer NOT NULL,
  "DriverId" uuid,
  "DriverUserId" uuid,
  "DriverName" character varying(256),
  "DriverPhotoUrl" text,
  "VehicleKind" character varying(40),
  "VehicleModel" character varying(128),
  "VehicleColor" character varying(64),
  "PlateNumber" character varying(32),
  "VehicleSummary" character varying(256),
  "FareAmount" numeric(18, 2),
  "TotalAmount" numeric(18, 2),
  "Currency" character varying(3) NOT NULL DEFAULT 'EGP',
  "SyncedAt" timestamp with time zone NOT NULL,
  "IsDeleted" boolean NOT NULL,
  "StartedAt" timestamp with time zone,
  "SourceCreatedAt" timestamp with time zone NOT NULL,
  "ScheduledFor" timestamp with time zone,
  "ReferenceCode" character varying(64),
  "RouteName" character varying(256),
  "OwnerType" integer,
  "RouteVehicleKind" character varying(40),
  "RequestedVehicleKind" character varying(40),
  "PaymentMethod" character varying(32),
  "Capacity" integer,
  "RouteId" uuid,
  "RouteStartLatitude" double precision,
  "RouteStartLongitude" double precision,
  "RouteEndLatitude" double precision,
  "RouteEndLongitude" double precision,
  "DriverRatingAverage" numeric(18, 2),
  "DriverRatingCount" integer
);

CREATE UNIQUE INDEX IF NOT EXISTS "UX_TripHistoryReadModel_Source"
  ON "TripHistoryReadModel" ("SourceType", "SourceId");

CREATE INDEX IF NOT EXISTS "IX_TripHistoryReadModel_Source_Departure"
  ON "TripHistoryReadModel" ("SourceType", "IsDeleted", "DepartureAt" DESC);

CREATE INDEX IF NOT EXISTS "IX_TripHistoryReadModel_DriverId"
  ON "TripHistoryReadModel" ("DriverId");

CREATE INDEX IF NOT EXISTS "IX_TripHistoryReadModel_DriverUserId"
  ON "TripHistoryReadModel" ("DriverUserId");

CREATE INDEX IF NOT EXISTS "IX_TripHistoryReadModel_RouteId"
  ON "TripHistoryReadModel" ("RouteId");

CREATE OR REPLACE FUNCTION shuttlez_vehicle_summary(
  kind text,
  model text,
  color text,
  plate text
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(concat_ws(' - ',
    NULLIF(btrim(COALESCE(kind, '')), ''),
    NULLIF(btrim(COALESCE(model, '')), ''),
    NULLIF(btrim(COALESCE(color, '')), ''),
    NULLIF(btrim(COALESCE(plate, '')), '')
  ), '');
$$;

CREATE OR REPLACE FUNCTION shuttlez_upsert_trip_history_trip(p_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO "TripHistoryReadModel" (
    "Id", "SourceType", "SourceId",
    "OriginName", "OriginLatitude", "OriginLongitude",
    "DestinationName", "DestinationLatitude", "DestinationLongitude",
    "DepartureAt", "Status",
    "DriverId", "DriverUserId", "DriverName", "DriverPhotoUrl",
    "VehicleKind", "VehicleModel", "VehicleColor", "PlateNumber", "VehicleSummary",
    "FareAmount", "TotalAmount", "Currency", "SyncedAt", "IsDeleted",
    "StartedAt", "SourceCreatedAt", "ScheduledFor", "ReferenceCode",
    "RouteName", "OwnerType", "RouteVehicleKind", "RequestedVehicleKind",
    "PaymentMethod", "Capacity", "RouteId",
    "RouteStartLatitude", "RouteStartLongitude", "RouteEndLatitude", "RouteEndLongitude",
    "DriverRatingAverage", "DriverRatingCount"
  )
  SELECT
    gen_random_uuid(), 'trip', t."Id",
    NULL, rt."StartLatitude", rt."StartLongitude",
    NULL, rt."EndLatitude", rt."EndLongitude",
    t."ScheduledAt", t."Status",
    d."Id", d."UserId", u."FullName",
    CASE WHEN u."AvatarUrl" IS NULL OR u."AvatarUrl" LIKE 'data:%' THEN NULL ELSE u."AvatarUrl" END,
    COALESCE(NULLIF(btrim(COALESCE(d."VehicleKind", '')), ''), v."Type"::text),
    COALESCE(NULLIF(btrim(COALESCE(d."VehicleModelName", '')), ''), v."Model"),
    NULLIF(btrim(COALESCE(d."VehicleColor", '')), ''),
    COALESCE(NULLIF(btrim(COALESCE(d."PlateNumber", '')), ''), v."PlateNumber"),
    shuttlez_vehicle_summary(
      COALESCE(NULLIF(btrim(COALESCE(d."VehicleKind", '')), ''), v."Type"::text),
      COALESCE(NULLIF(btrim(COALESCE(d."VehicleModelName", '')), ''), v."Model"),
      d."VehicleColor",
      COALESCE(NULLIF(btrim(COALESCE(d."PlateNumber", '')), ''), v."PlateNumber")
    ),
    t."PricePerSeat", NULL, 'EGP', clock_timestamp(), t."IsDeleted",
    t."StartedAt", t."CreatedAt", NULL, t."ReferenceCode",
    rt."Name", rt."OwnerType", rt."VehicleKind", NULL,
    NULL, NULL, rt."Id",
    rt."StartLatitude", rt."StartLongitude", rt."EndLatitude", rt."EndLongitude",
    CASE WHEN d."RatingCount" > 0 THEN d."RatingAverage" ELSE NULL END,
    CASE WHEN d."RatingCount" > 0 THEN d."RatingCount" ELSE NULL END
  FROM "TripsSet" t
  INNER JOIN "RoutesSet" rt ON rt."Id" = t."RouteId"
  LEFT JOIN "DriversSet" d ON d."Id" = t."DriverId"
  LEFT JOIN "UsersSet" u ON u."Id" = d."UserId"
  LEFT JOIN "VehiclesSet" v ON v."Id" = d."VehicleId"
  WHERE t."Id" = p_id
  ON CONFLICT ("SourceType", "SourceId") DO UPDATE SET
    "OriginLatitude" = EXCLUDED."OriginLatitude",
    "OriginLongitude" = EXCLUDED."OriginLongitude",
    "DestinationLatitude" = EXCLUDED."DestinationLatitude",
    "DestinationLongitude" = EXCLUDED."DestinationLongitude",
    "DepartureAt" = EXCLUDED."DepartureAt",
    "Status" = EXCLUDED."Status",
    "DriverId" = EXCLUDED."DriverId",
    "DriverUserId" = EXCLUDED."DriverUserId",
    "DriverName" = EXCLUDED."DriverName",
    "DriverPhotoUrl" = EXCLUDED."DriverPhotoUrl",
    "VehicleKind" = EXCLUDED."VehicleKind",
    "VehicleModel" = EXCLUDED."VehicleModel",
    "VehicleColor" = EXCLUDED."VehicleColor",
    "PlateNumber" = EXCLUDED."PlateNumber",
    "VehicleSummary" = EXCLUDED."VehicleSummary",
    "FareAmount" = EXCLUDED."FareAmount",
    "TotalAmount" = EXCLUDED."TotalAmount",
    "Currency" = EXCLUDED."Currency",
    "SyncedAt" = EXCLUDED."SyncedAt",
    "IsDeleted" = EXCLUDED."IsDeleted",
    "StartedAt" = EXCLUDED."StartedAt",
    "SourceCreatedAt" = EXCLUDED."SourceCreatedAt",
    "ScheduledFor" = EXCLUDED."ScheduledFor",
    "ReferenceCode" = EXCLUDED."ReferenceCode",
    "RouteName" = EXCLUDED."RouteName",
    "OwnerType" = EXCLUDED."OwnerType",
    "RouteVehicleKind" = EXCLUDED."RouteVehicleKind",
    "RequestedVehicleKind" = EXCLUDED."RequestedVehicleKind",
    "PaymentMethod" = EXCLUDED."PaymentMethod",
    "Capacity" = EXCLUDED."Capacity",
    "RouteId" = EXCLUDED."RouteId",
    "RouteStartLatitude" = EXCLUDED."RouteStartLatitude",
    "RouteStartLongitude" = EXCLUDED."RouteStartLongitude",
    "RouteEndLatitude" = EXCLUDED."RouteEndLatitude",
    "RouteEndLongitude" = EXCLUDED."RouteEndLongitude",
    "DriverRatingAverage" = EXCLUDED."DriverRatingAverage",
    "DriverRatingCount" = EXCLUDED."DriverRatingCount";
$$;

CREATE OR REPLACE FUNCTION shuttlez_upsert_trip_history_ride(p_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO "TripHistoryReadModel" (
    "Id", "SourceType", "SourceId",
    "OriginName", "OriginLatitude", "OriginLongitude",
    "DestinationName", "DestinationLatitude", "DestinationLongitude",
    "DepartureAt", "Status",
    "DriverId", "DriverUserId", "DriverName", "DriverPhotoUrl",
    "VehicleKind", "VehicleModel", "VehicleColor", "PlateNumber", "VehicleSummary",
    "FareAmount", "TotalAmount", "Currency", "SyncedAt", "IsDeleted",
    "StartedAt", "SourceCreatedAt", "ScheduledFor", "ReferenceCode",
    "RouteName", "OwnerType", "RouteVehicleKind", "RequestedVehicleKind",
    "PaymentMethod", "Capacity", "RouteId",
    "RouteStartLatitude", "RouteStartLongitude", "RouteEndLatitude", "RouteEndLongitude",
    "DriverRatingAverage", "DriverRatingCount"
  )
  SELECT
    gen_random_uuid(), 'ride', r."Id",
    r."PickupAddress", r."PickupLatitude", r."PickupLongitude",
    r."DestinationAddress", r."DestinationLatitude", r."DestinationLongitude",
    COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt"), r."Status",
    d."Id", d."UserId", u."FullName",
    CASE WHEN u."AvatarUrl" IS NULL OR u."AvatarUrl" LIKE 'data:%' THEN NULL ELSE u."AvatarUrl" END,
    COALESCE(NULLIF(btrim(COALESCE(d."VehicleKind", '')), ''), v."Type"::text),
    COALESCE(NULLIF(btrim(COALESCE(d."VehicleModelName", '')), ''), v."Model"),
    NULLIF(btrim(COALESCE(d."VehicleColor", '')), ''),
    COALESCE(NULLIF(btrim(COALESCE(d."PlateNumber", '')), ''), v."PlateNumber"),
    shuttlez_vehicle_summary(
      COALESCE(NULLIF(btrim(COALESCE(d."VehicleKind", '')), ''), v."Type"::text, r."RequestedVehicleKind"),
      COALESCE(NULLIF(btrim(COALESCE(d."VehicleModelName", '')), ''), v."Model"),
      d."VehicleColor",
      COALESCE(NULLIF(btrim(COALESCE(d."PlateNumber", '')), ''), v."PlateNumber")
    ),
    r."FareAmount", r."TotalAmount", 'EGP', clock_timestamp(), r."IsDeleted",
    r."StartedAt", r."CreatedAt", r."ScheduledFor", r."ReferenceCode",
    NULL, NULL, NULL, r."RequestedVehicleKind",
    r."PaymentMethod", NULL, NULL,
    NULL, NULL, NULL, NULL,
    CASE WHEN d."RatingCount" > 0 THEN d."RatingAverage" ELSE NULL END,
    CASE WHEN d."RatingCount" > 0 THEN d."RatingCount" ELSE NULL END
  FROM "RideRequestsSet" r
  LEFT JOIN "DriversSet" d ON d."Id" = r."DriverId"
  LEFT JOIN "UsersSet" u ON u."Id" = d."UserId"
  LEFT JOIN "VehiclesSet" v ON v."Id" = d."VehicleId"
  WHERE r."Id" = p_id
  ON CONFLICT ("SourceType", "SourceId") DO UPDATE SET
    "OriginName" = EXCLUDED."OriginName",
    "OriginLatitude" = EXCLUDED."OriginLatitude",
    "OriginLongitude" = EXCLUDED."OriginLongitude",
    "DestinationName" = EXCLUDED."DestinationName",
    "DestinationLatitude" = EXCLUDED."DestinationLatitude",
    "DestinationLongitude" = EXCLUDED."DestinationLongitude",
    "DepartureAt" = EXCLUDED."DepartureAt",
    "Status" = EXCLUDED."Status",
    "DriverId" = EXCLUDED."DriverId",
    "DriverUserId" = EXCLUDED."DriverUserId",
    "DriverName" = EXCLUDED."DriverName",
    "DriverPhotoUrl" = EXCLUDED."DriverPhotoUrl",
    "VehicleKind" = EXCLUDED."VehicleKind",
    "VehicleModel" = EXCLUDED."VehicleModel",
    "VehicleColor" = EXCLUDED."VehicleColor",
    "PlateNumber" = EXCLUDED."PlateNumber",
    "VehicleSummary" = EXCLUDED."VehicleSummary",
    "FareAmount" = EXCLUDED."FareAmount",
    "TotalAmount" = EXCLUDED."TotalAmount",
    "Currency" = EXCLUDED."Currency",
    "SyncedAt" = EXCLUDED."SyncedAt",
    "IsDeleted" = EXCLUDED."IsDeleted",
    "StartedAt" = EXCLUDED."StartedAt",
    "SourceCreatedAt" = EXCLUDED."SourceCreatedAt",
    "ScheduledFor" = EXCLUDED."ScheduledFor",
    "ReferenceCode" = EXCLUDED."ReferenceCode",
    "RouteName" = EXCLUDED."RouteName",
    "OwnerType" = EXCLUDED."OwnerType",
    "RouteVehicleKind" = EXCLUDED."RouteVehicleKind",
    "RequestedVehicleKind" = EXCLUDED."RequestedVehicleKind",
    "PaymentMethod" = EXCLUDED."PaymentMethod",
    "Capacity" = EXCLUDED."Capacity",
    "RouteId" = EXCLUDED."RouteId",
    "RouteStartLatitude" = EXCLUDED."RouteStartLatitude",
    "RouteStartLongitude" = EXCLUDED."RouteStartLongitude",
    "RouteEndLatitude" = EXCLUDED."RouteEndLatitude",
    "RouteEndLongitude" = EXCLUDED."RouteEndLongitude",
    "DriverRatingAverage" = EXCLUDED."DriverRatingAverage",
    "DriverRatingCount" = EXCLUDED."DriverRatingCount";
$$;

CREATE OR REPLACE FUNCTION shuttlez_upsert_trip_history_group(p_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO "TripHistoryReadModel" (
    "Id", "SourceType", "SourceId",
    "OriginName", "OriginLatitude", "OriginLongitude",
    "DestinationName", "DestinationLatitude", "DestinationLongitude",
    "DepartureAt", "Status",
    "DriverId", "DriverUserId", "DriverName", "DriverPhotoUrl",
    "VehicleKind", "VehicleModel", "VehicleColor", "PlateNumber", "VehicleSummary",
    "FareAmount", "TotalAmount", "Currency", "SyncedAt", "IsDeleted",
    "StartedAt", "SourceCreatedAt", "ScheduledFor", "ReferenceCode",
    "RouteName", "OwnerType", "RouteVehicleKind", "RequestedVehicleKind",
    "PaymentMethod", "Capacity", "RouteId",
    "RouteStartLatitude", "RouteStartLongitude", "RouteEndLatitude", "RouteEndLongitude",
    "DriverRatingAverage", "DriverRatingCount"
  )
  SELECT
    gen_random_uuid(), 'group', g."Id",
    g."PickupAddress", g."PickupLatitude", g."PickupLongitude",
    g."DestinationAddress", g."DestinationLatitude", g."DestinationLongitude",
    COALESCE(g."StartedAt", g."CreatedAt"), g."Status",
    d."Id", d."UserId", u."FullName",
    CASE WHEN u."AvatarUrl" IS NULL OR u."AvatarUrl" LIKE 'data:%' THEN NULL ELSE u."AvatarUrl" END,
    COALESCE(NULLIF(btrim(COALESCE(d."VehicleKind", '')), ''), NULL),
    NULLIF(btrim(COALESCE(d."VehicleModelName", '')), ''),
    NULLIF(btrim(COALESCE(d."VehicleColor", '')), ''),
    NULLIF(btrim(COALESCE(d."PlateNumber", '')), ''),
    shuttlez_vehicle_summary(d."VehicleKind", d."VehicleModelName", d."VehicleColor", d."PlateNumber"),
    g."FareAmount", g."TotalAmount", 'EGP', clock_timestamp(), g."IsDeleted",
    g."StartedAt", g."CreatedAt", NULL, g."ReferenceCode",
    NULL, NULL, NULL, NULL,
    g."PaymentMethod", g."Capacity", NULL,
    NULL, NULL, NULL, NULL,
    CASE WHEN d."RatingCount" > 0 THEN d."RatingAverage" ELSE NULL END,
    CASE WHEN d."RatingCount" > 0 THEN d."RatingCount" ELSE NULL END
  FROM "GroupRequestsSet" g
  LEFT JOIN "DriversSet" d ON d."Id" = g."DriverId"
  LEFT JOIN "UsersSet" u ON u."Id" = d."UserId"
  WHERE g."Id" = p_id
  ON CONFLICT ("SourceType", "SourceId") DO UPDATE SET
    "OriginName" = EXCLUDED."OriginName",
    "OriginLatitude" = EXCLUDED."OriginLatitude",
    "OriginLongitude" = EXCLUDED."OriginLongitude",
    "DestinationName" = EXCLUDED."DestinationName",
    "DestinationLatitude" = EXCLUDED."DestinationLatitude",
    "DestinationLongitude" = EXCLUDED."DestinationLongitude",
    "DepartureAt" = EXCLUDED."DepartureAt",
    "Status" = EXCLUDED."Status",
    "DriverId" = EXCLUDED."DriverId",
    "DriverUserId" = EXCLUDED."DriverUserId",
    "DriverName" = EXCLUDED."DriverName",
    "DriverPhotoUrl" = EXCLUDED."DriverPhotoUrl",
    "VehicleKind" = EXCLUDED."VehicleKind",
    "VehicleModel" = EXCLUDED."VehicleModel",
    "VehicleColor" = EXCLUDED."VehicleColor",
    "PlateNumber" = EXCLUDED."PlateNumber",
    "VehicleSummary" = EXCLUDED."VehicleSummary",
    "FareAmount" = EXCLUDED."FareAmount",
    "TotalAmount" = EXCLUDED."TotalAmount",
    "Currency" = EXCLUDED."Currency",
    "SyncedAt" = EXCLUDED."SyncedAt",
    "IsDeleted" = EXCLUDED."IsDeleted",
    "StartedAt" = EXCLUDED."StartedAt",
    "SourceCreatedAt" = EXCLUDED."SourceCreatedAt",
    "ScheduledFor" = EXCLUDED."ScheduledFor",
    "ReferenceCode" = EXCLUDED."ReferenceCode",
    "RouteName" = EXCLUDED."RouteName",
    "OwnerType" = EXCLUDED."OwnerType",
    "RouteVehicleKind" = EXCLUDED."RouteVehicleKind",
    "RequestedVehicleKind" = EXCLUDED."RequestedVehicleKind",
    "PaymentMethod" = EXCLUDED."PaymentMethod",
    "Capacity" = EXCLUDED."Capacity",
    "RouteId" = EXCLUDED."RouteId",
    "RouteStartLatitude" = EXCLUDED."RouteStartLatitude",
    "RouteStartLongitude" = EXCLUDED."RouteStartLongitude",
    "RouteEndLatitude" = EXCLUDED."RouteEndLatitude",
    "RouteEndLongitude" = EXCLUDED."RouteEndLongitude",
    "DriverRatingAverage" = EXCLUDED."DriverRatingAverage",
    "DriverRatingCount" = EXCLUDED."DriverRatingCount";
$$;

CREATE OR REPLACE FUNCTION shuttlez_trip_history_trip_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "TripHistoryReadModel"
    SET "IsDeleted" = true, "SyncedAt" = clock_timestamp()
    WHERE "SourceType" = 'trip' AND "SourceId" = OLD."Id";
    RETURN OLD;
  END IF;
  PERFORM shuttlez_upsert_trip_history_trip(NEW."Id");
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION shuttlez_trip_history_ride_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "TripHistoryReadModel"
    SET "IsDeleted" = true, "SyncedAt" = clock_timestamp()
    WHERE "SourceType" = 'ride' AND "SourceId" = OLD."Id";
    RETURN OLD;
  END IF;
  PERFORM shuttlez_upsert_trip_history_ride(NEW."Id");
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION shuttlez_trip_history_group_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "TripHistoryReadModel"
    SET "IsDeleted" = true, "SyncedAt" = clock_timestamp()
    WHERE "SourceType" = 'group' AND "SourceId" = OLD."Id";
    RETURN OLD;
  END IF;
  PERFORM shuttlez_upsert_trip_history_group(NEW."Id");
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION shuttlez_refresh_history_for_driver(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE rec record;
BEGIN
  FOR rec IN SELECT "Id" FROM "TripsSet" WHERE "DriverId" = p_driver_id LOOP
    PERFORM shuttlez_upsert_trip_history_trip(rec."Id");
  END LOOP;
  FOR rec IN SELECT "Id" FROM "RideRequestsSet" WHERE "DriverId" = p_driver_id LOOP
    PERFORM shuttlez_upsert_trip_history_ride(rec."Id");
  END LOOP;
  FOR rec IN SELECT "Id" FROM "GroupRequestsSet" WHERE "DriverId" = p_driver_id LOOP
    PERFORM shuttlez_upsert_trip_history_group(rec."Id");
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION shuttlez_trip_history_driver_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM shuttlez_refresh_history_for_driver(NEW."Id");
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION shuttlez_trip_history_user_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE rec record;
BEGIN
  IF NEW."FullName" IS NOT DISTINCT FROM OLD."FullName"
     AND NEW."AvatarUrl" IS NOT DISTINCT FROM OLD."AvatarUrl" THEN
    RETURN NEW;
  END IF;
  FOR rec IN SELECT "Id" FROM "DriversSet" WHERE "UserId" = NEW."Id" LOOP
    PERFORM shuttlez_refresh_history_for_driver(rec."Id");
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION shuttlez_trip_history_route_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE rec record;
BEGIN
  FOR rec IN SELECT "Id" FROM "TripsSet" WHERE "RouteId" = NEW."Id" LOOP
    PERFORM shuttlez_upsert_trip_history_trip(rec."Id");
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION shuttlez_trip_history_vehicle_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE rec record;
BEGIN
  FOR rec IN SELECT "Id" FROM "DriversSet" WHERE "VehicleId" = NEW."Id" LOOP
    PERFORM shuttlez_refresh_history_for_driver(rec."Id");
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "TR_TripHistory_Trips" ON "TripsSet";
CREATE TRIGGER "TR_TripHistory_Trips"
AFTER INSERT OR UPDATE OR DELETE ON "TripsSet"
FOR EACH ROW EXECUTE FUNCTION shuttlez_trip_history_trip_trigger();

DROP TRIGGER IF EXISTS "TR_TripHistory_Rides" ON "RideRequestsSet";
CREATE TRIGGER "TR_TripHistory_Rides"
AFTER INSERT OR UPDATE OR DELETE ON "RideRequestsSet"
FOR EACH ROW EXECUTE FUNCTION shuttlez_trip_history_ride_trigger();

DROP TRIGGER IF EXISTS "TR_TripHistory_Groups" ON "GroupRequestsSet";
CREATE TRIGGER "TR_TripHistory_Groups"
AFTER INSERT OR UPDATE OR DELETE ON "GroupRequestsSet"
FOR EACH ROW EXECUTE FUNCTION shuttlez_trip_history_group_trigger();

DROP TRIGGER IF EXISTS "TR_TripHistory_Drivers" ON "DriversSet";
CREATE TRIGGER "TR_TripHistory_Drivers"
AFTER UPDATE ON "DriversSet"
FOR EACH ROW EXECUTE FUNCTION shuttlez_trip_history_driver_trigger();

DROP TRIGGER IF EXISTS "TR_TripHistory_Users" ON "UsersSet";
CREATE TRIGGER "TR_TripHistory_Users"
AFTER UPDATE ON "UsersSet"
FOR EACH ROW EXECUTE FUNCTION shuttlez_trip_history_user_trigger();

DROP TRIGGER IF EXISTS "TR_TripHistory_Routes" ON "RoutesSet";
CREATE TRIGGER "TR_TripHistory_Routes"
AFTER UPDATE ON "RoutesSet"
FOR EACH ROW EXECUTE FUNCTION shuttlez_trip_history_route_trigger();

DROP TRIGGER IF EXISTS "TR_TripHistory_Vehicles" ON "VehiclesSet";
CREATE TRIGGER "TR_TripHistory_Vehicles"
AFTER UPDATE ON "VehiclesSet"
FOR EACH ROW EXECUTE FUNCTION shuttlez_trip_history_vehicle_trigger();

DO $$
DECLARE rec record;
BEGIN
  FOR rec IN SELECT "Id" FROM "TripsSet" LOOP
    PERFORM shuttlez_upsert_trip_history_trip(rec."Id");
  END LOOP;
  FOR rec IN SELECT "Id" FROM "RideRequestsSet" LOOP
    PERFORM shuttlez_upsert_trip_history_ride(rec."Id");
  END LOOP;
  FOR rec IN SELECT "Id" FROM "GroupRequestsSet" LOOP
    PERFORM shuttlez_upsert_trip_history_group(rec."Id");
  END LOOP;
END $$;
