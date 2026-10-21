import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { groupStatusLabel, rideStatusLabel } from '../../common/utils/enums-map';
import { money } from '../../common/utils/money';
import { pageRequestFrom } from '../../common/paged-result';

const HISTORY_MAX_PAGE_SIZE = 50;

export type HistoryBucket = 'upcoming' | 'past';

export type HistoryPageQuery = {
  bucket: HistoryBucket;
  page?: number;
  pageSize?: number;
  date?: string;
  from?: string;
  to?: string;
};

type HistoryEntry =
  | { product: 'trip'; booking: Record<string, unknown> }
  | { product: 'ride'; ride: Record<string, unknown> }
  | { product: 'group'; group: Record<string, unknown> };

export type RiderHistoryPage = {
  items: HistoryEntry[];
  page: number;
  pageSize: number;
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
  const paging = pageRequestFrom(query.page, query.pageSize);
  const pageSize = Math.min(paging.pageSize, HISTORY_MAX_PAGE_SIZE);
  const page = paging.page;
  const skip = (page - 1) * pageSize;
  const take = pageSize + 1;
  const date = normalizeDate(query.date);
  const range = normalizeRange(query.from, query.to);
  const bucket = query.bucket;
  const started = performance.now();
  const [row] = await prisma.$queryRaw<
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
          FROM (${historyBranches(userId, bucket, date, range.from, range.to, skip + take)}) merged
          ORDER BY sort_at DESC, id DESC
          OFFSET ${skip}
          LIMIT ${take}
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
                FROM (${historyBranches(userId, 'current', date, range.from, range.to, 1)}) current_merged
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
  `;
  const queryMs = Math.round(performance.now() - started);
  const rawItems = asArray(row?.items);
  const hasNextPage = rawItems.length > pageSize;
  const pageItems = (hasNextPage ? rawItems.slice(0, pageSize) : rawItems)
    .map(toEntry)
    .filter((entry): entry is HistoryEntry => entry != null);
  const current = page === 1 ? toEntry(asRecord(row?.current_item)) : null;
  const hasAny = page === 1 ? row?.has_any === true : true;
  const result: RiderHistoryPage = {
    items: pageItems,
    page,
    pageSize,
    hasNextPage,
    current,
    hasAny,
  };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  console.log(
    `[history] bucket=${bucket} page=${page} items=${pageItems.length} hasNext=${hasNextPage} queryMs=${queryMs} bytes=${bytes}`,
  );
  return result;
}

function historyBranches(
  userId: string,
  bucket: BucketName,
  day: string | null,
  fromDay: string | null,
  toDay: string | null,
  bound: number,
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
        INNER JOIN "TripHistoryReadModel" h
          ON h."SourceType" = 'trip'
         AND h."SourceId" = b."TripId"
         AND h."IsDeleted" = false
        LEFT JOIN "StopsSet" os ON os."Id" = b."OriginStopId"
        LEFT JOIN "StopsSet" ds ON ds."Id" = b."DestinationStopId"
        WHERE b."UserId" = CAST(${userId} AS uuid)
          AND b."IsDeleted" = false
          AND ${tripBucketSql(bucket)}
          AND ${dayMatch(Prisma.raw('h."DepartureAt"'), day, fromDay, toDay)}
        ORDER BY h."SourceId", b."CreatedAt" DESC
      ) trip_deduped
      ORDER BY sort_at DESC, id DESC
      LIMIT ${bound}
    )
    UNION ALL
    (
      SELECT
        'ride'::text AS product,
        h."SourceId"::text AS id,
        h."DepartureAt" AS sort_at,
        ${ridePayload()} AS payload
      FROM "RideRequestsSet" r
      INNER JOIN "TripHistoryReadModel" h
        ON h."SourceType" = 'ride'
       AND h."SourceId" = r."Id"
       AND h."IsDeleted" = false
      WHERE r."RiderUserId" = CAST(${userId} AS uuid)
        AND r."IsDeleted" = false
        AND ${rideBucketSql(bucket)}
        AND ${dayMatch(Prisma.raw('h."DepartureAt"'), day, fromDay, toDay)}
      ORDER BY h."DepartureAt" DESC, h."SourceId" DESC
      LIMIT ${bound}
    )
    UNION ALL
    (
      SELECT
        'group'::text AS product,
        h."SourceId"::text AS id,
        h."DepartureAt" AS sort_at,
        ${groupPayload()} AS payload
      FROM "GroupMembersSet" m
      INNER JOIN "TripHistoryReadModel" h
        ON h."SourceType" = 'group'
       AND h."SourceId" = m."GroupRequestId"
       AND h."IsDeleted" = false
      WHERE m."UserId" = CAST(${userId} AS uuid)
        AND m."IsDeleted" = false
        AND ${groupBucketSql(bucket)}
        AND ${dayMatch(Prisma.raw('h."DepartureAt"'), day, fromDay, toDay)}
      ORDER BY h."DepartureAt" DESC, h."SourceId" DESC
      LIMIT ${bound}
    )
  `;
}

function hasAnySql(userId: string): Prisma.Sql {
  return Prisma.sql`(
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM "BookingsSet" b
        INNER JOIN "TripHistoryReadModel" h
          ON h."SourceType" = 'trip' AND h."SourceId" = b."TripId" AND h."IsDeleted" = false
        WHERE b."UserId" = CAST(${userId} AS uuid) AND b."IsDeleted" = false
      ) OR EXISTS (
        SELECT 1
        FROM "RideRequestsSet" r
        INNER JOIN "TripHistoryReadModel" h
          ON h."SourceType" = 'ride' AND h."SourceId" = r."Id" AND h."IsDeleted" = false
        WHERE r."RiderUserId" = CAST(${userId} AS uuid) AND r."IsDeleted" = false
      ) OR EXISTS (
        SELECT 1
        FROM "GroupMembersSet" m
        INNER JOIN "TripHistoryReadModel" h
          ON h."SourceType" = 'group' AND h."SourceId" = m."GroupRequestId" AND h."IsDeleted" = false
        WHERE m."UserId" = CAST(${userId} AS uuid) AND m."IsDeleted" = false
      )
      THEN true ELSE false
    END
  )`;
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
  if (bucket === 'current') {
    return Prisma.sql`${open}
      AND h."Status" = 3
      AND (h."DepartureAt" AT TIME ZONE 'Africa/Cairo')::date
        = (now() AT TIME ZONE 'Africa/Cairo')::date`;
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
        h."Status" = 3
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
