import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { groupStatusLabel, rideStatusLabel } from '../../common/utils/enums-map';
import { money } from '../../common/utils/money';
import { historyPageRequest, logHistoryPerf } from './history-page';

export type HistoryBucket = 'upcoming' | 'past';

export type HistoryPageQuery = {
  bucket: HistoryBucket;
  page?: number;
  pageSize?: number;
  date?: string;
  from?: string;
  to?: string;
  status?: string;
  product?: string;
};

type HistoryEntry =
  | { product: 'trip'; booking: Record<string, unknown> }
  | { product: 'ride'; ride: Record<string, unknown> }
  | { product: 'group'; group: Record<string, unknown> };

export type RiderHistoryPage = {
  items: HistoryEntry[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasNextPage: boolean;
  current: HistoryEntry | null;
  hasAny: boolean;
};

type BucketName = HistoryBucket | 'current';

export async function loadRiderHistoryPage(
  prisma: PrismaService,
  userId: string,
  query: HistoryPageQuery,
): Promise<RiderHistoryPage> {
  const paging = historyPageRequest(query.page, query.pageSize);
  const pageSize = paging.pageSize;
  const page = paging.page;
  const skip = paging.skip;
  const date = normalizeDate(query.date);
  const range = normalizeRange(query.from, query.to);
  const bucket = query.bucket;
  const status = normalizeHistoryStatus(query.status);
  const product = normalizeHistoryProduct(query.product);
  const started = performance.now();
  const branches = historyBranches(
    userId,
    bucket,
    date,
    range.from,
    range.to,
    skip + pageSize,
    status,
    product,
  );
  const countBranches = historyBranches(
    userId,
    bucket,
    date,
    range.from,
    range.to,
    null,
    status,
    product,
  );
  const [[row], [countRow]] = await Promise.all([
    prisma.$queryRaw<
      Array<{ items: unknown; current_item: unknown; has_any: boolean | null }>
    >`
    SELECT
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'product', page_row.product,
            'id', page_row.id,
            'payload', page_row.payload
          )
          ORDER BY page_row.sort_at DESC, page_row.id DESC
        )
        FROM (
          SELECT product, id, sort_at, payload
          FROM (${branches}) merged
          ORDER BY sort_at DESC, id DESC
          OFFSET ${skip}
          LIMIT ${pageSize}
        ) page_row
      ), '[]'::jsonb) AS items,
      ${
        page === 1
          ? Prisma.sql`(
              SELECT jsonb_build_object(
                'product', current_row.product,
                'id', current_row.id,
                'payload', current_row.payload
              )
              FROM (
                SELECT product, id, sort_at, payload
                FROM (${historyBranches(userId, 'current', date, range.from, range.to, 1, status, product)}) current_merged
                ORDER BY sort_at DESC, id DESC
                LIMIT 1
              ) current_row
            )`
          : Prisma.sql`NULL::jsonb`
      } AS current_item,
      ${
        page === 1
          ? hasAnySql(userId)
          : Prisma.sql`true`
      } AS has_any
  `,
    prisma.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total
      FROM (${countBranches}) counted
    `,
  ]);
  const queryMs = Math.round(performance.now() - started);
  const totalCount = Number(countRow?.total ?? 0);
  const rawItems = asArray(row?.items);
  const pageItems = rawItems
    .map(toEntry)
    .filter((entry): entry is HistoryEntry => entry != null);
  const hasNextPage = skip + pageItems.length < totalCount;
  const current = page === 1 ? toEntry(asRecord(row?.current_item)) : null;
  const hasAny = page === 1 ? row?.has_any === true : true;
  const result: RiderHistoryPage = {
    items: pageItems,
    page,
    pageSize,
    totalCount,
    hasNextPage,
    current,
    hasAny,
  };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  logHistoryPerf({
    endpoint: `GET /api/v1/trips/history bucket=${bucket} page=${page}`,
    status: 200,
    queryMs,
    countMs: queryMs,
    queries: 2,
    bytes,
    items: pageItems.length,
    totalCount,
  });
  return result;
}

function historyBranches(
  userId: string,
  bucket: BucketName,
  day: string | null,
  fromDay: string | null,
  toDay: string | null,
  bound: number | null,
  status: 'completed' | 'cancelled' | null,
  product: 'trip' | 'ride' | 'group' | 'private' | null,
): Prisma.Sql {
  return Prisma.sql`
    (
      SELECT product, id, sort_at, payload
      FROM (
        SELECT DISTINCT ON (h."SourceId")
          'trip'::text AS product,
          h."SourceId"::text AS id,
          h."DepartureAt" AS sort_at,
          ${tripPayload()} AS payload
        FROM "BookingsSet" b
        ${tripHistoryJoin()}
        LEFT JOIN "StopsSet" os ON os."Id" = b."OriginStopId"
        LEFT JOIN "StopsSet" ds ON ds."Id" = b."DestinationStopId"
        WHERE b."UserId" = CAST(${userId} AS uuid)
          AND b."IsDeleted" = false
          AND ${branchEnabled('trip', product)}
          AND ${tripStatusSql(status)}
          AND ${tripBucketSql(bucket)}
          AND ${dayMatch(Prisma.raw('h."DepartureAt"'), day, fromDay, toDay)}
        ORDER BY h."SourceId", b."CreatedAt" DESC
      ) trip_deduped
      ORDER BY sort_at DESC, id DESC
      ${limitSql(bound)}
    )
    UNION ALL
    (
      SELECT
        'ride'::text AS product,
        h."SourceId"::text AS id,
        h."DepartureAt" AS sort_at,
        ${ridePayload()} AS payload
      FROM "RideRequestsSet" r
      ${rideHistoryJoin()}
      WHERE r."RiderUserId" = CAST(${userId} AS uuid)
        AND r."IsDeleted" = false
        AND ${branchEnabled('ride', product)}
        AND ${sourceStatusSql(status, 4, 5)}
        AND ${rideBucketSql(bucket)}
        AND ${dayMatch(Prisma.raw('h."DepartureAt"'), day, fromDay, toDay)}
      ORDER BY h."DepartureAt" DESC, h."SourceId" DESC
      ${limitSql(bound)}
    )
    UNION ALL
    (
      SELECT
        'group'::text AS product,
        h."SourceId"::text AS id,
        h."DepartureAt" AS sort_at,
        ${groupPayload()} AS payload
      FROM "GroupMembersSet" m
      INNER JOIN "GroupRequestsSet" g
        ON g."Id" = m."GroupRequestId"
       AND g."IsDeleted" = false
      ${groupHistoryJoin()}
      WHERE m."UserId" = CAST(${userId} AS uuid)
        AND m."IsDeleted" = false
        AND ${branchEnabled('group', product)}
        AND ${sourceStatusSql(status, 5, 6)}
        AND ${groupBucketSql(bucket)}
        AND ${dayMatch(Prisma.raw('h."DepartureAt"'), day, fromDay, toDay)}
      ORDER BY h."DepartureAt" DESC, h."SourceId" DESC
      ${limitSql(bound)}
    )
  `;
}

function hasAnySql(userId: string): Prisma.Sql {
  return Prisma.sql`(
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM "BookingsSet" b
        WHERE b."UserId" = CAST(${userId} AS uuid) AND b."IsDeleted" = false
      ) OR EXISTS (
        SELECT 1
        FROM "RideRequestsSet" r
        WHERE r."RiderUserId" = CAST(${userId} AS uuid) AND r."IsDeleted" = false
      ) OR EXISTS (
        SELECT 1
        FROM "GroupMembersSet" m
        WHERE m."UserId" = CAST(${userId} AS uuid) AND m."IsDeleted" = false
      )
      THEN true ELSE false
    END
  )`;
}

function limitSql(bound: number | null): Prisma.Sql {
  return bound == null ? Prisma.empty : Prisma.sql`LIMIT ${bound}`;
}

function branchEnabled(
  name: 'trip' | 'ride' | 'group',
  product: 'trip' | 'ride' | 'group' | 'private' | null,
): Prisma.Sql {
  if (product == null) return Prisma.sql`true`;
  if (product === 'private') return name === 'trip' ? Prisma.sql`false` : Prisma.sql`true`;
  return product === name ? Prisma.sql`true` : Prisma.sql`false`;
}

function tripStatusSql(status: 'completed' | 'cancelled' | null): Prisma.Sql {
  if (status == null) return Prisma.sql`true`;
  if (status === 'cancelled') {
    return Prisma.sql`(h."Status" = 5 OR b."Status" = 3)`;
  }
  return Prisma.sql`(h."Status" = 4 AND b."Status" NOT IN (3, 4))`;
}

function sourceStatusSql(
  status: 'completed' | 'cancelled' | null,
  completed: number,
  cancelled: number,
): Prisma.Sql {
  if (status == null) return Prisma.sql`true`;
  return status === 'cancelled'
    ? Prisma.sql`h."Status" = ${cancelled}`
    : Prisma.sql`h."Status" = ${completed}`;
}

function normalizeHistoryStatus(value?: string): 'completed' | 'cancelled' | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'completed' || raw === 'finished') return 'completed';
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled';
  return null;
}

function normalizeHistoryProduct(
  value?: string,
): 'trip' | 'ride' | 'group' | 'private' | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'trip' || raw === 'shuttle' || raw === 'route' || raw === 'routes') return 'trip';
  if (raw === 'ride') return 'ride';
  if (raw === 'group') return 'group';
  if (raw === 'private') return 'private';
  return null;
}

function tripHistoryJoin(): Prisma.Sql {
  return Prisma.sql`
    INNER JOIN "TripsSet" t
      ON t."Id" = b."TripId"
     AND t."IsDeleted" = false
    LEFT JOIN "RoutesSet" rt ON rt."Id" = t."RouteId"
    LEFT JOIN "DriversSet" d ON d."Id" = t."DriverId"
    LEFT JOIN "UsersSet" du ON du."Id" = d."UserId"
    LEFT JOIN "TripHistoryReadModel" hm
      ON hm."SourceType" = 'trip'
     AND hm."SourceId" = t."Id"
     AND hm."IsDeleted" = false
    CROSS JOIN LATERAL (
      SELECT
        t."Id" AS "SourceId",
        COALESCE(hm."DepartureAt", t."ScheduledAt") AS "DepartureAt",
        COALESCE(hm."Status", t."Status") AS "Status",
        COALESCE(hm."StartedAt", t."StartedAt") AS "StartedAt",
        COALESCE(hm."SourceCreatedAt", t."CreatedAt") AS "SourceCreatedAt",
        NULL::timestamptz AS "ScheduledFor",
        COALESCE(hm."ReferenceCode", t."ReferenceCode") AS "ReferenceCode",
        COALESCE(hm."RouteName", rt."Name") AS "RouteName",
        COALESCE(hm."OwnerType", rt."OwnerType") AS "OwnerType",
        COALESCE(hm."RouteVehicleKind", rt."VehicleKind") AS "RouteVehicleKind",
        COALESCE(hm."RouteStartLatitude", rt."StartLatitude") AS "RouteStartLatitude",
        COALESCE(hm."RouteStartLongitude", rt."StartLongitude") AS "RouteStartLongitude",
        COALESCE(hm."RouteEndLatitude", rt."EndLatitude") AS "RouteEndLatitude",
        COALESCE(hm."RouteEndLongitude", rt."EndLongitude") AS "RouteEndLongitude",
        COALESCE(hm."DriverId", d."Id") AS "DriverId",
        COALESCE(hm."DriverName", du."FullName") AS "DriverName",
        COALESCE(
          hm."DriverPhotoUrl",
          CASE
            WHEN du."AvatarUrl" IS NULL OR du."AvatarUrl" LIKE 'data:%' THEN NULL
            ELSE du."AvatarUrl"
          END
        ) AS "DriverPhotoUrl",
        COALESCE(hm."VehicleKind", NULLIF(btrim(COALESCE(d."VehicleKind", '')), '')) AS "VehicleKind",
        COALESCE(hm."VehicleModel", NULLIF(btrim(COALESCE(d."VehicleModelName", '')), '')) AS "VehicleModel",
        COALESCE(hm."VehicleColor", NULLIF(btrim(COALESCE(d."VehicleColor", '')), '')) AS "VehicleColor",
        COALESCE(hm."PlateNumber", NULLIF(btrim(COALESCE(d."PlateNumber", '')), '')) AS "PlateNumber",
        hm."DriverRatingAverage" AS "DriverRatingAverage",
        hm."DriverRatingCount" AS "DriverRatingCount"
    ) h
  `;
}

function rideHistoryJoin(): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN "DriversSet" d ON d."Id" = r."DriverId"
    LEFT JOIN "UsersSet" du ON du."Id" = d."UserId"
    LEFT JOIN "TripHistoryReadModel" hm
      ON hm."SourceType" = 'ride'
     AND hm."SourceId" = r."Id"
     AND hm."IsDeleted" = false
    CROSS JOIN LATERAL (
      SELECT
        r."Id" AS "SourceId",
        COALESCE(hm."DepartureAt", COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt")) AS "DepartureAt",
        COALESCE(hm."Status", r."Status") AS "Status",
        COALESCE(hm."OriginLatitude", r."PickupLatitude") AS "OriginLatitude",
        COALESCE(hm."OriginLongitude", r."PickupLongitude") AS "OriginLongitude",
        COALESCE(hm."OriginName", r."PickupAddress") AS "OriginName",
        COALESCE(hm."DestinationLatitude", r."DestinationLatitude") AS "DestinationLatitude",
        COALESCE(hm."DestinationLongitude", r."DestinationLongitude") AS "DestinationLongitude",
        COALESCE(hm."DestinationName", r."DestinationAddress") AS "DestinationName",
        COALESCE(hm."TotalAmount", r."TotalAmount") AS "TotalAmount",
        COALESCE(hm."FareAmount", r."FareAmount") AS "FareAmount",
        COALESCE(hm."PaymentMethod", r."PaymentMethod") AS "PaymentMethod",
        COALESCE(hm."ScheduledFor", r."ScheduledFor") AS "ScheduledFor",
        COALESCE(hm."StartedAt", r."StartedAt") AS "StartedAt",
        COALESCE(hm."SourceCreatedAt", r."CreatedAt") AS "SourceCreatedAt",
        COALESCE(hm."ReferenceCode", r."ReferenceCode") AS "ReferenceCode",
        COALESCE(hm."RequestedVehicleKind", r."RequestedVehicleKind") AS "RequestedVehicleKind",
        COALESCE(hm."DriverId", r."DriverId") AS "DriverId",
        COALESCE(hm."DriverName", du."FullName") AS "DriverName",
        COALESCE(
          hm."DriverPhotoUrl",
          CASE
            WHEN du."AvatarUrl" IS NULL OR du."AvatarUrl" LIKE 'data:%' THEN NULL
            ELSE du."AvatarUrl"
          END
        ) AS "DriverPhotoUrl",
        COALESCE(hm."DriverRatingAverage", d."RatingAverage") AS "DriverRatingAverage",
        COALESCE(hm."DriverRatingCount", d."RatingCount") AS "DriverRatingCount",
        COALESCE(hm."VehicleKind", NULLIF(btrim(COALESCE(d."VehicleKind", '')), '')) AS "VehicleKind",
        COALESCE(hm."VehicleModel", NULLIF(btrim(COALESCE(d."VehicleModelName", '')), '')) AS "VehicleModel",
        COALESCE(hm."VehicleColor", NULLIF(btrim(COALESCE(d."VehicleColor", '')), '')) AS "VehicleColor",
        COALESCE(hm."PlateNumber", NULLIF(btrim(COALESCE(d."PlateNumber", '')), '')) AS "PlateNumber"
    ) h
  `;
}

function groupHistoryJoin(): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN "DriversSet" d ON d."Id" = g."DriverId"
    LEFT JOIN "UsersSet" du ON du."Id" = d."UserId"
    LEFT JOIN "TripHistoryReadModel" hm
      ON hm."SourceType" = 'group'
     AND hm."SourceId" = g."Id"
     AND hm."IsDeleted" = false
    CROSS JOIN LATERAL (
      SELECT
        g."Id" AS "SourceId",
        COALESCE(hm."DepartureAt", COALESCE(g."StartedAt", g."CreatedAt")) AS "DepartureAt",
        COALESCE(hm."Status", g."Status") AS "Status",
        COALESCE(hm."OriginLatitude", g."PickupLatitude") AS "OriginLatitude",
        COALESCE(hm."OriginLongitude", g."PickupLongitude") AS "OriginLongitude",
        COALESCE(hm."OriginName", g."PickupAddress") AS "OriginName",
        COALESCE(hm."DestinationLatitude", g."DestinationLatitude") AS "DestinationLatitude",
        COALESCE(hm."DestinationLongitude", g."DestinationLongitude") AS "DestinationLongitude",
        COALESCE(hm."DestinationName", g."DestinationAddress") AS "DestinationName",
        COALESCE(hm."TotalAmount", g."TotalAmount") AS "TotalAmount",
        COALESCE(hm."FareAmount", g."FareAmount") AS "FareAmount",
        COALESCE(hm."PaymentMethod", g."PaymentMethod") AS "PaymentMethod",
        COALESCE(hm."StartedAt", g."StartedAt") AS "StartedAt",
        COALESCE(hm."SourceCreatedAt", g."CreatedAt") AS "SourceCreatedAt",
        COALESCE(hm."ReferenceCode", g."ReferenceCode") AS "ReferenceCode",
        COALESCE(hm."DriverId", g."DriverId") AS "DriverId",
        COALESCE(hm."DriverName", du."FullName") AS "DriverName",
        COALESCE(
          hm."DriverPhotoUrl",
          CASE
            WHEN du."AvatarUrl" IS NULL OR du."AvatarUrl" LIKE 'data:%' THEN NULL
            ELSE du."AvatarUrl"
          END
        ) AS "DriverPhotoUrl",
        COALESCE(hm."DriverRatingAverage", d."RatingAverage") AS "DriverRatingAverage",
        COALESCE(hm."DriverRatingCount", d."RatingCount") AS "DriverRatingCount",
        COALESCE(hm."VehicleKind", NULLIF(btrim(COALESCE(d."VehicleKind", '')), '')) AS "VehicleKind",
        COALESCE(hm."Capacity", g."Capacity") AS "Capacity"
    ) h
  `;
}

function tripPayload(): Prisma.Sql {
  return Prisma.sql`jsonb_build_object(
    'tripId', h."SourceId",
    'id', b."Id",
    'status', b."Status",
    'seatCount', b."SeatCount",
    'referenceCode', b."ReferenceCode",
    'vehicleKind', b."VehicleKind",
    'totalAmount', b."TotalAmount",
    'paymentMethod', b."PaymentMethod",
    'createdAt', b."CreatedAt",
    'originStop', CASE WHEN os."Id" IS NULL THEN NULL ELSE jsonb_build_object(
      'id', os."Id", 'name', os."Name", 'latitude', os."Latitude",
      'longitude', os."Longitude", 'order', os."Order"
    ) END,
    'destinationStop', CASE WHEN ds."Id" IS NULL THEN NULL ELSE jsonb_build_object(
      'id', ds."Id", 'name', ds."Name", 'latitude', ds."Latitude",
      'longitude', ds."Longitude", 'order', ds."Order"
    ) END,
    'trip', jsonb_build_object(
      'id', h."SourceId",
      'status', h."Status",
      'scheduledAt', h."DepartureAt",
      'referenceCode', h."ReferenceCode",
      'route', jsonb_build_object(
        'name', h."RouteName",
        'ownerType', h."OwnerType",
        'vehicleKind', h."RouteVehicleKind",
        'startLatitude', h."RouteStartLatitude",
        'startLongitude', h."RouteStartLongitude",
        'endLatitude', h."RouteEndLatitude",
        'endLongitude', h."RouteEndLongitude"
      ),
      'driver', CASE WHEN h."DriverId" IS NULL THEN NULL ELSE jsonb_build_object(
        'id', h."DriverId",
        'vehicleKind', h."VehicleKind",
        'name', h."DriverName",
        'photoUrl', h."DriverPhotoUrl",
        'user', jsonb_build_object(
          'fullName', h."DriverName",
          'avatarUrl', h."DriverPhotoUrl"
        )
      ) END
    )
  )`;
}

function ridePayload(): Prisma.Sql {
  return Prisma.sql`jsonb_build_object(
    'id', h."SourceId",
    'status', h."Status",
    'pickupLatitude', h."OriginLatitude",
    'pickupLongitude', h."OriginLongitude",
    'pickupAddress', h."OriginName",
    'destinationLatitude', h."DestinationLatitude",
    'destinationLongitude', h."DestinationLongitude",
    'destinationAddress', h."DestinationName",
    'totalAmount', h."TotalAmount",
    'fareAmount', h."FareAmount",
    'paymentMethod', h."PaymentMethod",
    'scheduledFor', h."ScheduledFor",
    'startedAt', h."StartedAt",
    'createdAt', h."SourceCreatedAt",
    'referenceCode', h."ReferenceCode",
    'requestedVehicleKind', h."RequestedVehicleKind",
    'driverId', h."DriverId",
    'driverName', h."DriverName",
    'driverPhotoUrl', h."DriverPhotoUrl",
    'driverRatingAverage', h."DriverRatingAverage",
    'driverRatingCount', h."DriverRatingCount",
    'vehicleKind', h."VehicleKind",
    'vehicleModel', h."VehicleModel",
    'vehicleColor', h."VehicleColor",
    'plateNumber', h."PlateNumber"
  )`;
}

function groupPayload(): Prisma.Sql {
  return Prisma.sql`jsonb_build_object(
    'id', h."SourceId",
    'status', h."Status",
    'pickupLatitude', h."OriginLatitude",
    'pickupLongitude', h."OriginLongitude",
    'pickupAddress', h."OriginName",
    'destinationLatitude', h."DestinationLatitude",
    'destinationLongitude', h."DestinationLongitude",
    'destinationAddress', h."DestinationName",
    'capacity', h."Capacity",
    'totalAmount', h."TotalAmount",
    'fareAmount', h."FareAmount",
    'paymentMethod', h."PaymentMethod",
    'startedAt', h."StartedAt",
    'createdAt', h."SourceCreatedAt",
    'referenceCode', h."ReferenceCode",
    'driverId', h."DriverId",
    'driverName', h."DriverName",
    'driverPhotoUrl', h."DriverPhotoUrl",
    'driverRatingAverage', h."DriverRatingAverage",
    'driverRatingCount', h."DriverRatingCount",
    'vehicleKind', h."VehicleKind"
  )`;
}

function normalizeDate(value?: string): string | null {
  const raw = (value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function normalizeRange(from?: string, to?: string): { from: string | null; to: string | null } {
  let start = normalizeDate(from);
  let end = normalizeDate(to);
  if (start && end && start > end) {
    const swap = start;
    start = end;
    end = swap;
  }
  if (start && !end) end = start;
  return { from: start, to: end };
}

function dayMatch(
  sortSql: Prisma.Sql,
  day: string | null,
  fromDay: string | null,
  toDay: string | null,
): Prisma.Sql {
  return Prisma.sql`(
    (
      CAST(${fromDay} AS date) IS NULL
      AND (
        CAST(${day} AS date) IS NULL
        OR (${sortSql} AT TIME ZONE 'Africa/Cairo')::date = CAST(${day} AS date)
      )
    )
    OR (
      CAST(${fromDay} AS date) IS NOT NULL
      AND (${sortSql} AT TIME ZONE 'Africa/Cairo')::date >= CAST(${fromDay} AS date)
      AND (${sortSql} AT TIME ZONE 'Africa/Cairo')::date <= COALESCE(CAST(${toDay} AS date), CAST(${fromDay} AS date))
    )
  )`;
}

function tripBucketSql(bucket: BucketName): Prisma.Sql {
  const open = Prisma.sql`b."Status" NOT IN (3, 4) AND h."Status" NOT IN (4, 5)`;
  const sameDay = Prisma.sql`(h."DepartureAt" AT TIME ZONE 'Africa/Cairo')::date
        = (now() AT TIME ZONE 'Africa/Cairo')::date`;
  if (bucket === 'current') {
    return Prisma.sql`${open}
      AND ${sameDay}
      AND (
        h."Status" = 3
        OR h."DepartureAt" <= now()
      )`;
  }
  if (bucket === 'upcoming') {
    return Prisma.sql`${open}
      AND h."DepartureAt" > now()
      AND NOT (
        h."Status" = 3
        AND (h."DepartureAt" AT TIME ZONE 'Africa/Cairo')::date
          = (now() AT TIME ZONE 'Africa/Cairo')::date
      )`;
  }
  return Prisma.sql`(
    b."Status" IN (3, 4)
    OR h."Status" IN (4, 5)
    OR (
      h."DepartureAt" <= now()
      AND NOT (
        ${open}
        AND (h."DepartureAt" AT TIME ZONE 'Africa/Cairo')::date
          = (now() AT TIME ZONE 'Africa/Cairo')::date
      )
    )
  )`;
}

function rideBucketSql(bucket: BucketName): Prisma.Sql {
  const scheduled = Prisma.sql`COALESCE(h."ScheduledFor", h."StartedAt")`;
  const onSchedule = Prisma.sql`(
    h."ScheduledFor" IS NOT NULL
    OR (h."Status" = 3 AND h."StartedAt" IS NOT NULL)
  )`;
  const sameCairoDay = Prisma.sql`(
    h."Status" = 3
    AND (${scheduled} AT TIME ZONE 'Africa/Cairo')::date
      = (now() AT TIME ZONE 'Africa/Cairo')::date
  )`;
  const createdToday = Prisma.sql`(
    (h."SourceCreatedAt" AT TIME ZONE 'Africa/Cairo')::date
      >= (now() AT TIME ZONE 'Africa/Cairo')::date
  )`;
  if (bucket === 'current') {
    return Prisma.sql`h."Status" NOT IN (4, 5) AND (
      (${onSchedule} AND ${sameCairoDay})
      OR (NOT ${onSchedule} AND ${createdToday} AND h."Status" = 3)
    )`;
  }
  if (bucket === 'upcoming') {
    return Prisma.sql`h."Status" NOT IN (4, 5) AND (
      (
        ${onSchedule}
        AND NOT ${sameCairoDay}
        AND ${scheduled} > now()
      )
      OR (
        NOT ${onSchedule}
        AND ${createdToday}
        AND h."Status" <> 3
      )
    )`;
  }
  return Prisma.sql`(
    h."Status" IN (4, 5)
    OR (
      ${onSchedule}
      AND NOT ${sameCairoDay}
      AND ${scheduled} <= now()
    )
    OR (
      NOT ${onSchedule}
      AND NOT ${createdToday}
    )
  )`;
}

function groupBucketSql(bucket: BucketName): Prisma.Sql {
  const started = Prisma.sql`(h."Status" = 4 AND h."StartedAt" IS NOT NULL)`;
  const startedToday = Prisma.sql`(
    (h."StartedAt" AT TIME ZONE 'Africa/Cairo')::date
      = (now() AT TIME ZONE 'Africa/Cairo')::date
  )`;
  const createdToday = Prisma.sql`(
    (h."SourceCreatedAt" AT TIME ZONE 'Africa/Cairo')::date
      >= (now() AT TIME ZONE 'Africa/Cairo')::date
  )`;
  if (bucket === 'current') {
    return Prisma.sql`h."Status" NOT IN (5, 6) AND (
      (${started} AND ${startedToday})
      OR (NOT ${started} AND ${createdToday} AND h."Status" = 4)
    )`;
  }
  if (bucket === 'upcoming') {
    return Prisma.sql`h."Status" NOT IN (5, 6) AND (
      (${started} AND NOT ${startedToday} AND h."StartedAt" > now())
      OR (NOT ${started} AND ${createdToday} AND h."Status" <> 4)
    )`;
  }
  return Prisma.sql`(
    h."Status" IN (5, 6)
    OR (${started} AND NOT ${startedToday} AND h."StartedAt" <= now())
    OR (NOT ${started} AND NOT ${createdToday})
  )`;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  return null;
}

function toEntry(raw: unknown): HistoryEntry | null {
  const row = asRecord(raw);
  if (!row) return null;
  const payload = asRecord(row.payload);
  if (!payload) return null;
  if (row.product === 'trip') return { product: 'trip', booking: mapBooking(payload) };
  if (row.product === 'ride') return { product: 'ride', ride: mapRide(payload) };
  if (row.product === 'group') return { product: 'group', group: mapGroup(payload) };
  return null;
}

function mapBooking(payload: Record<string, unknown>): Record<string, unknown> & { tripId: string } {
  return {
    ...payload,
    tripId: String(payload.tripId),
    totalAmount: money(payload.totalAmount as number),
  };
}

function mapRide(payload: Record<string, unknown>): Record<string, unknown> & { id: string } {
  const ratingCount = Number(payload.driverRatingCount ?? 0);
  return {
    ...payload,
    id: String(payload.id),
    status: rideStatusLabel(Number(payload.status)),
    totalAmount: money(payload.totalAmount as number),
    fareAmount: money(payload.fareAmount as number),
    driverRatingAverage: ratingCount > 0 ? money(payload.driverRatingAverage as number) : null,
    driverRatingCount: ratingCount > 0 ? ratingCount : null,
  };
}

function mapGroup(payload: Record<string, unknown>): Record<string, unknown> & { id: string } {
  const ratingCount = Number(payload.driverRatingCount ?? 0);
  return {
    ...payload,
    id: String(payload.id),
    status: groupStatusLabel(Number(payload.status)),
    totalAmount: money(payload.totalAmount as number),
    fareAmount: money(payload.fareAmount as number),
    driverRatingAverage: ratingCount > 0 ? money(payload.driverRatingAverage as number) : null,
    driverRatingCount: ratingCount > 0 ? ratingCount : null,
  };
}
