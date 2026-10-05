import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { groupStatusLabel, rideStatusLabel } from '../../common/utils/enums-map';
import { money } from '../../common/utils/money';
import { pageRequestFrom } from '../../common/paged-result';
import { closeElapsedHistory } from './close-elapsed-history';

const HISTORY_MAX_PAGE_SIZE = 50;

export type HistoryBucket = 'upcoming' | 'past';

export type HistoryPageQuery = {
  bucket: HistoryBucket;
  page?: number;
  pageSize?: number;
  date?: string;
};

type HistoryKey = {
  product: string;
  id: string;
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

export async function loadRiderHistoryPage(
  prisma: PrismaService,
  userId: string,
  query: HistoryPageQuery,
): Promise<RiderHistoryPage> {
  const paging = pageRequestFrom(query.page, query.pageSize);
  const pageSize = Math.min(paging.pageSize, HISTORY_MAX_PAGE_SIZE);
  const page = paging.page;
  const skip = (page - 1) * pageSize;
  if (page === 1) await closeElapsedHistory(prisma);
  const date = normalizeDate(query.date);
  const bucket = query.bucket;

  const window = await selectWindow(
    prisma,
    userId,
    bucket,
    date,
    skip,
    pageSize + 1,
    page === 1,
  );
  const keys = window.keys;
  const currentKey = page === 1 ? window.current : null;
  const hasAny = page === 1 ? window.hasAny : true;
  const hasNextPage = keys.length > pageSize;
  const pageKeys = hasNextPage ? keys.slice(0, pageSize) : keys;
  const currentIsSeparate =
    currentKey != null &&
    !pageKeys.some((key) => key.product === currentKey.product && key.id === currentKey.id);
  const hydrated = await hydrate(
    prisma,
    userId,
    currentIsSeparate && currentKey ? [...pageKeys, currentKey] : pageKeys,
  );
  const byKey = new Map(hydrated.map((entry) => [entryKey(entry), entry]));
  const items = pageKeys
    .map((key) => byKey.get(`${key.product}:${key.id}`))
    .filter((entry): entry is HistoryEntry => entry != null);
  const current = currentKey
    ? byKey.get(`${currentKey.product}:${currentKey.id}`) ?? null
    : null;
  return { items, page, pageSize, hasNextPage, current, hasAny };
}

function entryKey(entry: HistoryEntry): string {
  if (entry.product === 'trip') return `trip:${String(entry.booking.tripId)}`;
  if (entry.product === 'ride') return `ride:${String(entry.ride.id)}`;
  return `group:${String(entry.group.id)}`;
}

function normalizeDate(value?: string): string | null {
  const raw = (value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

async function selectWindow(
  prisma: PrismaService,
  userId: string,
  bucket: HistoryBucket,
  date: string | null,
  skip: number,
  take: number,
  includeCurrent: boolean,
): Promise<{ keys: HistoryKey[]; current: HistoryKey | null; hasAny: boolean }> {
  const day = date;
  const rows = await prisma.$queryRaw<Array<HistoryKey & { slot: string; pos: number }>>`
    WITH rows AS (
      (
      SELECT DISTINCT ON (t."Id")
        'trip'::text AS product,
        t."Id"::text AS id,
        t."ScheduledAt" AS sort_at,
        CASE
          WHEN b."Status" IN (3, 4) OR t."Status" IN (4, 5) THEN 'past'
          WHEN t."Status" = 3
            AND (t."ScheduledAt" AT TIME ZONE 'Africa/Cairo')::date
              = (now() AT TIME ZONE 'Africa/Cairo')::date
            THEN 'current'
          WHEN t."ScheduledAt" > now() THEN 'upcoming'
          ELSE 'past'
        END AS bucket
      FROM "BookingsSet" b
      INNER JOIN "TripsSet" t ON t."Id" = b."TripId" AND t."IsDeleted" = false
      WHERE b."UserId" = CAST(${userId} AS uuid)
        AND b."IsDeleted" = false
      ORDER BY t."Id", b."CreatedAt" DESC
      )
      UNION ALL
      SELECT
        'ride'::text,
        r."Id"::text,
        COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt"),
        CASE
          WHEN r."Status" IN (4, 5) THEN 'past'
          WHEN r."ScheduledFor" IS NOT NULL OR (r."Status" = 3 AND r."StartedAt" IS NOT NULL) THEN
            CASE
              WHEN r."Status" = 3
                AND (COALESCE(r."ScheduledFor", r."StartedAt") AT TIME ZONE 'Africa/Cairo')::date
                  = (now() AT TIME ZONE 'Africa/Cairo')::date
                THEN 'current'
              WHEN COALESCE(r."ScheduledFor", r."StartedAt") > now() THEN 'upcoming'
              ELSE 'past'
            END
          WHEN (r."CreatedAt" AT TIME ZONE 'Africa/Cairo')::date
            >= (now() AT TIME ZONE 'Africa/Cairo')::date
            THEN CASE WHEN r."Status" = 3 THEN 'current' ELSE 'upcoming' END
          ELSE 'past'
        END
      FROM "RideRequestsSet" r
      WHERE r."RiderUserId" = CAST(${userId} AS uuid)
        AND r."IsDeleted" = false
      UNION ALL
      SELECT
        'group'::text,
        g."Id"::text,
        COALESCE(g."StartedAt", g."CreatedAt"),
        CASE
          WHEN g."Status" IN (5, 6) THEN 'past'
          WHEN g."Status" = 4 AND g."StartedAt" IS NOT NULL THEN
            CASE
              WHEN (g."StartedAt" AT TIME ZONE 'Africa/Cairo')::date
                = (now() AT TIME ZONE 'Africa/Cairo')::date THEN 'current'
              WHEN g."StartedAt" > now() THEN 'upcoming'
              ELSE 'past'
            END
          WHEN (g."CreatedAt" AT TIME ZONE 'Africa/Cairo')::date
            >= (now() AT TIME ZONE 'Africa/Cairo')::date
            THEN CASE WHEN g."Status" = 4 THEN 'current' ELSE 'upcoming' END
          ELSE 'past'
        END
      FROM "GroupMembersSet" m
      INNER JOIN "GroupRequestsSet" g
        ON g."Id" = m."GroupRequestId" AND g."IsDeleted" = false
      WHERE m."UserId" = CAST(${userId} AS uuid)
        AND m."IsDeleted" = false
    )
    SELECT product, id, slot, pos
    FROM (
      SELECT product, id, 'page'::text AS slot, pos
      FROM (
        SELECT
          product,
          id,
          ROW_NUMBER() OVER (ORDER BY sort_at DESC, id DESC) AS pos
        FROM rows
        WHERE bucket = ${bucket}
          AND (
            CAST(${day} AS date) IS NULL
            OR (sort_at AT TIME ZONE 'Africa/Cairo')::date = CAST(${day} AS date)
          )
        ORDER BY sort_at DESC, id DESC
        OFFSET ${skip}
        LIMIT ${take}
      ) page_src
      UNION ALL
      SELECT product, id, 'current'::text, 0
      FROM (
        SELECT product, id
        FROM rows
        WHERE CAST(${includeCurrent} AS boolean)
          AND bucket = 'current'
          AND (
            CAST(${day} AS date) IS NULL
            OR (sort_at AT TIME ZONE 'Africa/Cairo')::date = CAST(${day} AS date)
          )
        ORDER BY sort_at DESC, id DESC
        LIMIT 1
      ) current_src
      UNION ALL
      SELECT
        'meta',
        CASE WHEN EXISTS (SELECT 1 FROM rows) THEN '1' ELSE '0' END,
        'has',
        0
    ) picked
  `;
  const keys = rows
    .filter((row) => row.slot === 'page')
    .sort((left, right) => Number(left.pos) - Number(right.pos))
    .map((row) => ({ product: row.product, id: row.id }));
  const currentRow = rows.find((row) => row.slot === 'current');
  const hasRow = rows.find((row) => row.slot === 'has');
  return {
    keys,
    current: currentRow ? { product: currentRow.product, id: currentRow.id } : null,
    hasAny: hasRow?.id === '1',
  };
}

async function hydrate(
  prisma: PrismaService,
  userId: string,
  keys: HistoryKey[],
): Promise<HistoryEntry[]> {
  if (keys.length === 0) return [];
  const tripIds = keys.filter((key) => key.product === 'trip').map((key) => key.id);
  const rideIds = keys.filter((key) => key.product === 'ride').map((key) => key.id);
  const groupIds = keys.filter((key) => key.product === 'group').map((key) => key.id);
  const rows = await loadCards(prisma, userId, tripIds, rideIds, groupIds);
  const bookings = rows.filter((row) => row.product === 'trip').map((row) => mapBooking(row.payload));
  const rides = rows.filter((row) => row.product === 'ride').map((row) => mapRide(row.payload));
  const groups = rows.filter((row) => row.product === 'group').map((row) => mapGroup(row.payload));
  const byKey = new Map<string, HistoryEntry>();
  for (const booking of bookings) byKey.set(`trip:${booking.tripId}`, { product: 'trip', booking });
  for (const ride of rides) byKey.set(`ride:${ride.id}`, { product: 'ride', ride });
  for (const group of groups) byKey.set(`group:${group.id}`, { product: 'group', group });
  return keys
    .map((key) => byKey.get(`${key.product}:${key.id}`))
    .filter((entry): entry is HistoryEntry => entry != null);
}

type CardRow = { product: string; id: string; payload: Record<string, unknown> };

function uuidIn(columnSql: string, ids: string[]): Prisma.Sql {
  if (ids.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`${Prisma.raw(columnSql)}::text IN (${Prisma.join(ids)})`;
}

async function loadCards(
  prisma: PrismaService,
  userId: string,
  tripIds: string[],
  rideIds: string[],
  groupIds: string[],
): Promise<CardRow[]> {
  return prisma.$queryRaw<CardRow[]>`
    (
      SELECT DISTINCT ON (t."Id")
        'trip'::text AS product,
        t."Id"::text AS id,
        jsonb_build_object(
          'tripId', t."Id",
          'id', b."Id",
          'status', b."Status",
          'seatCount', b."SeatCount",
          'referenceCode', b."ReferenceCode",
          'vehicleKind', b."VehicleKind",
          'totalAmount', b."TotalAmount",
          'paymentMethod', b."PaymentMethod",
          'createdAt', b."CreatedAt",
          'originStop', CASE WHEN os."Id" IS NULL THEN NULL ELSE jsonb_build_object(
            'id', os."Id",
            'name', os."Name",
            'latitude', os."Latitude",
            'longitude', os."Longitude",
            'order', os."Order"
          ) END,
          'destinationStop', CASE WHEN ds."Id" IS NULL THEN NULL ELSE jsonb_build_object(
            'id', ds."Id",
            'name', ds."Name",
            'latitude', ds."Latitude",
            'longitude', ds."Longitude",
            'order', ds."Order"
          ) END,
          'trip', jsonb_build_object(
            'id', t."Id",
            'status', t."Status",
            'scheduledAt', t."ScheduledAt",
            'referenceCode', t."ReferenceCode",
            'route', jsonb_build_object(
              'name', rt."Name",
              'ownerType', rt."OwnerType",
              'vehicleKind', rt."VehicleKind",
              'startLatitude', rt."StartLatitude",
              'startLongitude', rt."StartLongitude",
              'endLatitude', rt."EndLatitude",
              'endLongitude', rt."EndLongitude"
            ),
            'driver', CASE WHEN d."Id" IS NULL THEN NULL ELSE jsonb_build_object(
              'id', d."Id",
              'vehicleKind', d."VehicleKind",
              'name', u."FullName",
              'photoUrl', u."AvatarUrl",
              'user', jsonb_build_object(
                'fullName', u."FullName",
                'avatarUrl', u."AvatarUrl"
              )
            ) END
          )
        ) AS payload
      FROM "BookingsSet" b
      INNER JOIN "TripsSet" t ON t."Id" = b."TripId" AND t."IsDeleted" = false
      INNER JOIN "RoutesSet" rt ON rt."Id" = t."RouteId"
      LEFT JOIN "StopsSet" os ON os."Id" = b."OriginStopId"
      LEFT JOIN "StopsSet" ds ON ds."Id" = b."DestinationStopId"
      LEFT JOIN "DriversSet" d ON d."Id" = t."DriverId"
      LEFT JOIN "UsersSet" u ON u."Id" = d."UserId"
      WHERE b."UserId" = CAST(${userId} AS uuid)
        AND b."IsDeleted" = false
        AND ${uuidIn('t."Id"', tripIds)}
      ORDER BY t."Id", b."CreatedAt" DESC
    )
    UNION ALL
    SELECT
      'ride'::text,
      r."Id"::text,
      jsonb_build_object(
        'id', r."Id",
        'status', r."Status",
        'pickupLatitude', r."PickupLatitude",
        'pickupLongitude', r."PickupLongitude",
        'pickupAddress', r."PickupAddress",
        'destinationLatitude', r."DestinationLatitude",
        'destinationLongitude', r."DestinationLongitude",
        'destinationAddress', r."DestinationAddress",
        'totalAmount', r."TotalAmount",
        'fareAmount', r."FareAmount",
        'paymentMethod', r."PaymentMethod",
        'scheduledFor', r."ScheduledFor",
        'startedAt', r."StartedAt",
        'createdAt', r."CreatedAt",
        'referenceCode', r."ReferenceCode",
        'requestedVehicleKind', r."RequestedVehicleKind",
        'driverId', d."Id",
        'driverName', u."FullName",
        'driverPhotoUrl', u."AvatarUrl",
        'driverRatingAverage', CASE WHEN d."RatingCount" > 0 THEN d."RatingAverage" ELSE NULL END,
        'driverRatingCount', CASE WHEN d."RatingCount" > 0 THEN d."RatingCount" ELSE NULL END,
        'vehicleKind', COALESCE(d."VehicleKind", v."Type"::text),
        'vehicleModel', COALESCE(d."VehicleModelName", v."Model"),
        'vehicleColor', d."VehicleColor",
        'plateNumber', COALESCE(d."PlateNumber", v."PlateNumber")
      )
    FROM "RideRequestsSet" r
    LEFT JOIN "DriversSet" d ON d."Id" = r."DriverId"
    LEFT JOIN "UsersSet" u ON u."Id" = d."UserId"
    LEFT JOIN "VehiclesSet" v ON v."Id" = d."VehicleId"
    WHERE r."IsDeleted" = false
      AND ${uuidIn('r."Id"', rideIds)}
    UNION ALL
    SELECT
      'group'::text,
      g."Id"::text,
      jsonb_build_object(
        'id', g."Id",
        'status', g."Status",
        'pickupLatitude', g."PickupLatitude",
        'pickupLongitude', g."PickupLongitude",
        'pickupAddress', g."PickupAddress",
        'destinationLatitude', g."DestinationLatitude",
        'destinationLongitude', g."DestinationLongitude",
        'destinationAddress', g."DestinationAddress",
        'capacity', g."Capacity",
        'totalAmount', g."TotalAmount",
        'fareAmount', g."FareAmount",
        'paymentMethod', g."PaymentMethod",
        'startedAt', g."StartedAt",
        'createdAt', g."CreatedAt",
        'referenceCode', g."ReferenceCode",
        'driverId', d."Id",
        'driverName', u."FullName",
        'driverPhotoUrl', u."AvatarUrl",
        'driverRatingAverage', CASE WHEN d."RatingCount" > 0 THEN d."RatingAverage" ELSE NULL END,
        'driverRatingCount', CASE WHEN d."RatingCount" > 0 THEN d."RatingCount" ELSE NULL END,
        'vehicleKind', d."VehicleKind"
      )
    FROM "GroupRequestsSet" g
    LEFT JOIN "DriversSet" d ON d."Id" = g."DriverId"
    LEFT JOIN "UsersSet" u ON u."Id" = d."UserId"
    WHERE g."IsDeleted" = false
      AND ${uuidIn('g."Id"', groupIds)}
  `;
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
