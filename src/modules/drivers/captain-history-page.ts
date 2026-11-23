import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  GroupRequestStatus,
  RideRequestStatus,
  TripStatus,
} from '../../common/enums';
import { money, platformCut } from '../../common/utils/money';
import { vehicleTypeLabel } from '../../common/utils/enums-map';
import { cairoDateKey } from '../bookings/rider-history-bucket';
import { historyPageRequest, logHistoryPerf } from '../bookings/history-page';

export type CaptainHistoryBucket = 'today' | 'upcoming' | 'past';

export type CaptainHistoryQuery = {
  bucket?: string;
  page?: number;
  pageSize?: number;
  kind?: string;
  status?: string;
  date?: string;
};

type CaptainHistoryItem = Record<string, unknown>;

function bucketOf(value?: string): CaptainHistoryBucket {
  if (value === 'upcoming') return 'upcoming';
  if (value === 'past' || value === 'finished' || value === 'cancelled') return 'past';
  return 'today';
}

function kindOf(value?: string): 'shuttle' | 'route' | 'private' | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'shuttle') return 'shuttle';
  if (raw === 'route' || raw === 'routes') return 'route';
  if (raw === 'private' || raw === 'ride' || raw === 'group') return 'private';
  return null;
}

function statusOf(value?: string): 'finished' | 'cancelled' | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'finished' || raw === 'completed') return 'finished';
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled';
  return null;
}

function normalizeDate(value?: string): string | null {
  const raw = (value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

export async function loadCaptainHistoryPage(
  prisma: PrismaService,
  driverId: string,
  query: CaptainHistoryQuery,
) {
  const paging = historyPageRequest(query.page, query.pageSize);
  const bucket = bucketOf(query.bucket);
  const kind = kindOf(query.kind);
  const status = statusOf(query.status);
  const day = normalizeDate(query.date);
  const started = performance.now();
  const args = { driverId, bucket, kind, status, day };
  const [[row], [countRow]] = await Promise.all([
    prisma.$queryRaw<Array<{ items: unknown }>>`
      SELECT COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('product', page_row.product, 'payload', page_row.payload)
          ORDER BY page_row.sort_at DESC, page_row.id DESC
        )
        FROM (
          SELECT product, id, sort_at, payload
          FROM (${captainBranches({ ...args, bound: paging.skip + paging.pageSize })}) merged
          ORDER BY sort_at DESC, id DESC
          OFFSET ${paging.skip}
          LIMIT ${paging.pageSize}
        ) page_row
      ), '[]'::jsonb) AS items
    `,
    prisma.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total
      FROM (${captainCountBranches(args)}) counted
    `,
  ]);
  const queryMs = Math.round(performance.now() - started);
  const totalCount = Number(countRow?.total ?? 0);
  const items = asArray(row?.items)
    .map((entry) => toCaptainItem(entry))
    .filter((entry): entry is CaptainHistoryItem => entry != null);
  const result = {
    items,
    page: paging.page,
    pageSize: paging.pageSize,
    totalCount,
    hasNextPage: paging.skip + items.length < totalCount,
  };
  logHistoryPerf({
    endpoint: `GET /api/v1/drivers/me/trips/history bucket=${bucket} page=${paging.page}`,
    status: 200,
    queryMs,
    countMs: queryMs,
    queries: 2,
    bytes: Buffer.byteLength(JSON.stringify(result)),
    items: items.length,
    totalCount,
  });
  return result;
}

function captainCountBranches(input: {
  driverId: string;
  bucket: CaptainHistoryBucket;
  kind: 'shuttle' | 'route' | 'private' | null;
  status: 'finished' | 'cancelled' | null;
  day: string | null;
}): Prisma.Sql {
  const { driverId, bucket, kind, status, day } = input;
  const tripsOn = kind == null || kind === 'shuttle' || kind === 'route';
  const privateOn = kind == null || kind === 'private';
  return Prisma.sql`
    SELECT t."Id"
    FROM "TripsSet" t
    INNER JOIN "RoutesSet" rt ON rt."Id" = t."RouteId"
    WHERE t."DriverId" = CAST(${driverId} AS uuid)
      AND t."IsDeleted" = false
      AND ${tripsOn ? Prisma.sql`true` : Prisma.sql`false`}
      AND ${tripKindSql(kind)}
      AND ${tripBucketSql(bucket)}
      AND ${tripUiStatusSql(status)}
      AND ${daySql(Prisma.raw('t."ScheduledAt"'), day)}
    UNION ALL
    SELECT r."Id"
    FROM "RideRequestsSet" r
    WHERE r."DriverId" = CAST(${driverId} AS uuid)
      AND r."IsDeleted" = false
      AND ${privateOn ? Prisma.sql`true` : Prisma.sql`false`}
      AND ${openBucketSql(bucket, Prisma.raw('COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt")'), Prisma.raw('r."Status"'), 4, 5)}
      AND ${terminalStatusSql(status, Prisma.raw('r."Status"'), 4, 5)}
      AND ${daySql(Prisma.raw('COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt")'), day)}
    UNION ALL
    SELECT g."Id"
    FROM "GroupRequestsSet" g
    WHERE g."DriverId" = CAST(${driverId} AS uuid)
      AND g."IsDeleted" = false
      AND ${privateOn ? Prisma.sql`true` : Prisma.sql`false`}
      AND ${openBucketSql(bucket, Prisma.raw('COALESCE(g."StartedAt", g."CreatedAt")'), Prisma.raw('g."Status"'), 5, 6)}
      AND ${terminalStatusSql(status, Prisma.raw('g."Status"'), 5, 6)}
      AND ${daySql(Prisma.raw('COALESCE(g."StartedAt", g."CreatedAt")'), day)}
  `;
}

function captainBranches(input: {
  driverId: string;
  bucket: CaptainHistoryBucket;
  kind: 'shuttle' | 'route' | 'private' | null;
  status: 'finished' | 'cancelled' | null;
  day: string | null;
  bound: number | null;
}): Prisma.Sql {
  const { driverId, bucket, kind, status, day, bound } = input;
  const limit = bound == null ? Prisma.empty : Prisma.sql`LIMIT ${bound}`;
  const tripsOn = kind == null || kind === 'shuttle' || kind === 'route';
  const privateOn = kind == null || kind === 'private';
  return Prisma.sql`
    (
      SELECT product, id, sort_at, payload
      FROM (
        SELECT
          'trip'::text AS product,
          t."Id"::text AS id,
          t."ScheduledAt" AS sort_at,
          jsonb_build_object(
            'id', t."Id",
            'referenceCode', t."ReferenceCode",
            'scheduledAt', t."ScheduledAt",
            'statusCode', t."Status",
            'routeId', t."RouteId",
            'routeName', rt."Name",
            'routeDescription', rt."Description",
            'ownerType', rt."OwnerType",
            'ownerDriverId', rt."OwnerDriverId",
            'durationSeconds', rt."DurationSeconds",
            'pricePerSeat', t."PricePerSeat",
            'availableSeats', t."AvailableSeats",
            'startedAt', t."StartedAt",
            'completedAt', t."CompletedAt",
            'driverId', t."DriverId",
            'plateNumber', d."PlateNumber",
            'vehicleColor', d."VehicleColor",
            'vehicleKind', d."VehicleKind",
            'vehicleTypeCode', v."Type",
            'passengers', COALESCE(stats.passengers, 0),
            'earnings', COALESCE(stats.earnings, 0),
            'collected', COALESCE(stats.collected, 0),
            'stations', COALESCE(stats.stations, 0),
            'destination', stats.destination
          ) AS payload
        FROM (
          SELECT t."Id"
          FROM "TripsSet" t
          INNER JOIN "RoutesSet" rt ON rt."Id" = t."RouteId"
          WHERE t."DriverId" = CAST(${driverId} AS uuid)
            AND t."IsDeleted" = false
            AND ${tripsOn ? Prisma.sql`true` : Prisma.sql`false`}
            AND ${tripKindSql(kind)}
            AND ${tripBucketSql(bucket)}
            AND ${tripUiStatusSql(status)}
            AND ${daySql(Prisma.raw('t."ScheduledAt"'), day)}
          ORDER BY t."ScheduledAt" DESC, t."Id" DESC
          ${limit}
        ) picked
        INNER JOIN "TripsSet" t ON t."Id" = picked."Id"
        INNER JOIN "RoutesSet" rt ON rt."Id" = t."RouteId"
        LEFT JOIN "DriversSet" d ON d."Id" = t."DriverId"
        LEFT JOIN "VehiclesSet" v ON v."Id" = d."VehicleId"
        LEFT JOIN LATERAL (
          SELECT
            (
              SELECT COALESCE(SUM(b."SeatCount"), 0)
              FROM "BookingsSet" b
              WHERE b."TripId" = t."Id"
                AND b."IsDeleted" = false
                AND b."Status" = 2
            ) AS passengers,
            (
              SELECT COALESCE(SUM(b."CaptainEarnings"), 0)
              FROM "BookingsSet" b
              WHERE b."TripId" = t."Id"
                AND b."IsDeleted" = false
                AND b."Status" = 2
                AND b."UsesSubscriptionCredit" = false
                AND b."PaymentMethod" NOT IN ('subscription', 'package')
            ) AS earnings,
            (
              SELECT COALESCE(SUM(
                CASE
                  WHEN b."TotalAmount" > 0 THEN b."TotalAmount"
                  ELSE b."PricePerSeat" * b."SeatCount"
                END
              ), 0)
              FROM "BookingsSet" b
              WHERE b."TripId" = t."Id"
                AND b."IsDeleted" = false
                AND b."Status" = 2
                AND b."UsesSubscriptionCredit" = false
                AND b."PaymentMethod" NOT IN ('subscription', 'package')
            ) AS collected,
            (
              SELECT COUNT(*)
              FROM "StopsSet" s
              WHERE s."RouteId" = t."RouteId" AND s."IsDeleted" = false
            ) AS stations,
            (
              SELECT s."Name"
              FROM "StopsSet" s
              WHERE s."RouteId" = t."RouteId" AND s."IsDeleted" = false
              ORDER BY s."Order" DESC
              LIMIT 1
            ) AS destination
        ) stats ON true
      ) trip_rows
      ORDER BY sort_at DESC, id DESC
      ${limit}
    )
    UNION ALL
    (
      SELECT
        'ride'::text AS product,
        r."Id"::text AS id,
        COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt") AS sort_at,
        jsonb_build_object(
          'id', r."Id",
          'referenceCode', r."ReferenceCode",
          'scheduledAt', COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt"),
          'statusCode', r."Status",
          'from', r."PickupAddress",
          'to', r."DestinationAddress",
          'pickupLatitude', r."PickupLatitude",
          'pickupLongitude', r."PickupLongitude",
          'destinationLatitude', r."DestinationLatitude",
          'destinationLongitude', r."DestinationLongitude",
          'fareAmount', r."FareAmount",
          'totalAmount', r."TotalAmount",
          'captainEarnings', r."CaptainEarnings",
          'requestedVehicleKind', r."RequestedVehicleKind",
          'passengerName', u."FullName",
          'startedAt', r."StartedAt",
          'completedAt', r."CompletedAt",
          'plateNumber', d."PlateNumber",
          'vehicleColor', d."VehicleColor"
        ) AS payload
      FROM "RideRequestsSet" r
      LEFT JOIN "UsersSet" u ON u."Id" = r."RiderUserId"
      LEFT JOIN "DriversSet" d ON d."Id" = r."DriverId"
      WHERE r."DriverId" = CAST(${driverId} AS uuid)
        AND r."IsDeleted" = false
        AND ${privateOn ? Prisma.sql`true` : Prisma.sql`false`}
        AND ${openBucketSql(bucket, Prisma.raw('COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt")'), Prisma.raw('r."Status"'), 4, 5)}
        AND ${terminalStatusSql(status, Prisma.raw('r."Status"'), 4, 5)}
        AND ${daySql(Prisma.raw('COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt")'), day)}
      ORDER BY sort_at DESC, id DESC
      ${limit}
    )
    UNION ALL
    (
      SELECT
        'group'::text AS product,
        g."Id"::text AS id,
        COALESCE(g."StartedAt", g."CreatedAt") AS sort_at,
        jsonb_build_object(
          'id', g."Id",
          'referenceCode', g."ReferenceCode",
          'scheduledAt', COALESCE(g."StartedAt", g."CreatedAt"),
          'statusCode', g."Status",
          'from', g."PickupAddress",
          'to', g."DestinationAddress",
          'pickupLatitude', g."PickupLatitude",
          'pickupLongitude', g."PickupLongitude",
          'destinationLatitude', g."DestinationLatitude",
          'destinationLongitude', g."DestinationLongitude",
          'fareAmount', g."FareAmount",
          'totalAmount', g."TotalAmount",
          'captainEarnings', g."CaptainEarnings",
          'passengers', GREATEST(g."JoinedMemberCount", 1),
          'startedAt', g."StartedAt",
          'completedAt', g."CompletedAt",
          'plateNumber', d."PlateNumber",
          'vehicleColor', d."VehicleColor",
          'vehicleKind', d."VehicleKind"
        ) AS payload
      FROM "GroupRequestsSet" g
      LEFT JOIN "DriversSet" d ON d."Id" = g."DriverId"
      WHERE g."DriverId" = CAST(${driverId} AS uuid)
        AND g."IsDeleted" = false
        AND ${privateOn ? Prisma.sql`true` : Prisma.sql`false`}
        AND ${openBucketSql(bucket, Prisma.raw('COALESCE(g."StartedAt", g."CreatedAt")'), Prisma.raw('g."Status"'), 5, 6)}
        AND ${terminalStatusSql(status, Prisma.raw('g."Status"'), 5, 6)}
        AND ${daySql(Prisma.raw('COALESCE(g."StartedAt", g."CreatedAt")'), day)}
      ORDER BY sort_at DESC, id DESC
      ${limit}
    )
  `;
}

function tripKindSql(kind: 'shuttle' | 'route' | 'private' | null): Prisma.Sql {
  const captainRoute = Prisma.sql`rt."OwnerType" = 1 AND rt."OwnerDriverId" = t."DriverId"`;
  if (kind === 'route') return captainRoute;
  if (kind === 'shuttle') return Prisma.sql`NOT (${captainRoute})`;
  return Prisma.sql`true`;
}

function tripBucketSql(bucket: CaptainHistoryBucket): Prisma.Sql {
  const past = Prisma.sql`(
    t."Status" IN (4, 5)
    OR (t."ScheduledAt" AT TIME ZONE 'Africa/Cairo')::date
      < (now() AT TIME ZONE 'Africa/Cairo')::date
  )`;
  if (bucket === 'past') return past;
  if (bucket === 'upcoming') {
    return Prisma.sql`t."Status" NOT IN (4, 5)
      AND t."ScheduledAt" > now()
      AND (t."ScheduledAt" AT TIME ZONE 'Africa/Cairo')::date
        > (now() AT TIME ZONE 'Africa/Cairo')::date`;
  }
  return Prisma.sql`NOT (${past})
    AND (t."ScheduledAt" AT TIME ZONE 'Africa/Cairo')::date
      = (now() AT TIME ZONE 'Africa/Cairo')::date`;
}

function tripUiStatusSql(status: 'finished' | 'cancelled' | null): Prisma.Sql {
  if (status === 'cancelled') return Prisma.sql`t."Status" = 5`;
  if (status === 'finished') return Prisma.sql`t."Status" = 4`;
  return Prisma.sql`true`;
}

function openBucketSql(
  bucket: CaptainHistoryBucket,
  at: Prisma.Sql,
  status: Prisma.Sql,
  completed: number,
  cancelled: number,
): Prisma.Sql {
  const past = Prisma.sql`(
    ${status} IN (${completed}, ${cancelled})
    OR (${at} AT TIME ZONE 'Africa/Cairo')::date
      < (now() AT TIME ZONE 'Africa/Cairo')::date
  )`;
  if (bucket === 'past') return past;
  if (bucket === 'upcoming') {
    return Prisma.sql`${status} NOT IN (${completed}, ${cancelled})
      AND ${at} > now()
      AND (${at} AT TIME ZONE 'Africa/Cairo')::date
        > (now() AT TIME ZONE 'Africa/Cairo')::date`;
  }
  return Prisma.sql`NOT (${past})
    AND (${at} AT TIME ZONE 'Africa/Cairo')::date
      = (now() AT TIME ZONE 'Africa/Cairo')::date`;
}

function terminalStatusSql(
  status: 'finished' | 'cancelled' | null,
  column: Prisma.Sql,
  completed: number,
  cancelled: number,
): Prisma.Sql {
  if (status === 'cancelled') return Prisma.sql`${column} = ${cancelled}`;
  if (status === 'finished') return Prisma.sql`${column} = ${completed}`;
  return Prisma.sql`true`;
}

function daySql(at: Prisma.Sql, day: string | null): Prisma.Sql {
  if (!day) return Prisma.sql`true`;
  return Prisma.sql`(${at} AT TIME ZONE 'Africa/Cairo')::date = CAST(${day} AS date)`;
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

function toCaptainItem(raw: unknown): CaptainHistoryItem | null {
  const row = asRecord(raw);
  const payload = asRecord(row?.payload);
  if (!row || !payload) return null;
  const when = new Date(String(payload.scheduledAt ?? ''));
  if (Number.isNaN(when.getTime())) return null;
  const now = new Date();
  if (row.product === 'ride') return mapRide(payload, when, now);
  if (row.product === 'group') return mapGroup(payload, when, now);
  if (row.product === 'trip') return mapTrip(payload, when, now);
  return null;
}

function stamp(when: Date) {
  return {
    dateLabel: when.toLocaleDateString('en-GB'),
    timeLabel: when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    scheduledAt: when,
  };
}

function uiFromTrip(statusCode: number, when: Date, now: Date): string {
  if (statusCode === TripStatus.Cancelled) return 'cancelled';
  if (statusCode === TripStatus.Completed) return 'finished';
  if (cairoDateKey(when) < cairoDateKey(now)) return 'finished';
  if (statusCode === TripStatus.InProgress) return 'active';
  if (when.getTime() > now.getTime()) return 'upcoming';
  return 'overdue';
}

function uiFromOpen(input: {
  statusCode: number;
  completed: number;
  cancelled: number;
  live: number[];
  when: Date;
  now: Date;
}): string {
  if (input.statusCode === input.cancelled) return 'cancelled';
  if (input.statusCode === input.completed) return 'finished';
  if (cairoDateKey(input.when) < cairoDateKey(input.now)) return 'finished';
  if (input.live.includes(input.statusCode)) return 'active';
  return 'upcoming';
}

function mapTrip(payload: Record<string, unknown>, when: Date, now: Date): CaptainHistoryItem {
  const statusCode = Number(payload.statusCode);
  const ui = uiFromTrip(statusCode, when, now);
  const captainRoute =
    Number(payload.ownerType) === 1 &&
    String(payload.ownerDriverId ?? '') !== '' &&
    String(payload.ownerDriverId) === String(payload.driverId ?? '');
  const collected = money(payload.collected as number);
  const fareCollected = statusCode === TripStatus.Completed && collected > 0;
  const cut = platformCut(fareCollected ? collected : 0);
  const vehicleTypeCode = Number(payload.vehicleTypeCode ?? 1);
  return {
    id: String(payload.id),
    referenceCode: payload.referenceCode ?? null,
    ...stamp(when),
    vehicleType: captainRoute ? 'CaptainRoute' : vehicleTypeLabel(vehicleTypeCode || 1),
    from: String(payload.routeName ?? ''),
    to: String(payload.destination ?? payload.routeDescription ?? 'الوصول'),
    passengers: Number(payload.passengers ?? 0),
    stations: Number(payload.stations ?? 0),
    earnings: money(payload.earnings as number),
    status: ui,
    routeId: payload.routeId ?? null,
    tripStatus: statusCode === TripStatus.Cancelled
      ? 'Cancelled'
      : statusCode === TripStatus.Completed
        ? 'Completed'
        : statusCode === TripStatus.InProgress
          ? 'InProgress'
          : 'Scheduled',
    pricePerSeat: money(payload.pricePerSeat as number),
    availableSeats: Number(payload.availableSeats ?? 0),
    kind: captainRoute ? 'route' : 'shuttle',
    plateNumber: payload.plateNumber ?? null,
    vehicleColor: payload.vehicleColor ?? null,
    durationMinutes: payload.durationSeconds
      ? Math.max(1, Math.round(Number(payload.durationSeconds) / 60))
      : null,
    startedAt: payload.startedAt ?? null,
    completedAt: payload.completedAt ?? null,
    totalAmount: cut.total,
    appCommission: cut.appCommission,
    fareCollected,
  };
}

function mapRide(payload: Record<string, unknown>, when: Date, now: Date): CaptainHistoryItem {
  const statusCode = Number(payload.statusCode);
  const ui = uiFromOpen({
    statusCode,
    completed: RideRequestStatus.Completed,
    cancelled: RideRequestStatus.Cancelled,
    live: [RideRequestStatus.Assigned, RideRequestStatus.InProgress],
    when,
    now,
  });
  const earnings = money(payload.captainEarnings as number) > 0
    ? money(payload.captainEarnings as number)
    : money((payload.fareAmount ?? payload.totalAmount) as number);
  const rideTotal = money(payload.totalAmount as number) || money(payload.fareAmount as number);
  const fareCollected = statusCode === RideRequestStatus.Completed && rideTotal > 0;
  const cut = platformCut(fareCollected ? rideTotal : 0);
  const id = String(payload.id);
  return {
    id,
    referenceCode: payload.referenceCode ?? null,
    ...stamp(when),
    vehicleType: String(payload.requestedVehicleKind ?? 'car'),
    from: String(payload.from ?? 'نقطة الانطلاق'),
    to: String(payload.to ?? 'الوجهة المحددة'),
    passengers: 1,
    stations: 2,
    earnings,
    status: ui,
    routeId: null,
    tripStatus: ui === 'cancelled' ? 'Cancelled' : ui === 'finished' ? 'Completed' : 'Scheduled',
    pricePerSeat: money((payload.fareAmount ?? payload.totalAmount) as number),
    availableSeats: 0,
    kind: 'ride',
    plateNumber: payload.plateNumber ?? null,
    vehicleColor: payload.vehicleColor ?? null,
    passengerName: payload.passengerName ?? null,
    totalAmount: cut.total,
    appCommission: cut.appCommission,
    fareCollected,
    startedAt: payload.startedAt ?? null,
    completedAt: payload.completedAt ?? null,
    stopsList: [
      {
        id: `${id}-pickup`,
        name: String(payload.from ?? 'نقطة الانطلاق'),
        order: 0,
        latitude: payload.pickupLatitude ?? null,
        longitude: payload.pickupLongitude ?? null,
        boarding: 1,
        alighting: 0,
      },
      {
        id: `${id}-dropoff`,
        name: String(payload.to ?? 'الوجهة المحددة'),
        order: 1,
        latitude: payload.destinationLatitude ?? null,
        longitude: payload.destinationLongitude ?? null,
        boarding: 0,
        alighting: 1,
      },
    ],
  };
}

function mapGroup(payload: Record<string, unknown>, when: Date, now: Date): CaptainHistoryItem {
  const statusCode = Number(payload.statusCode);
  const ui = uiFromOpen({
    statusCode,
    completed: GroupRequestStatus.Completed,
    cancelled: GroupRequestStatus.Cancelled,
    live: [GroupRequestStatus.InProgress, GroupRequestStatus.Assigned],
    when,
    now,
  });
  const groupTotal = money(payload.totalAmount as number) || money(payload.fareAmount as number);
  const fareCollected = statusCode === GroupRequestStatus.Completed && groupTotal > 0;
  const cut = platformCut(fareCollected ? groupTotal : 0);
  const id = String(payload.id);
  return {
    id,
    referenceCode: payload.referenceCode ?? null,
    ...stamp(when),
    vehicleType: String(payload.vehicleKind ?? 'car'),
    from: String(payload.from ?? 'نقطة التجمع'),
    to: String(payload.to ?? 'الوجهة المحددة'),
    passengers: Number(payload.passengers ?? 1),
    stations: 2,
    earnings: money(payload.captainEarnings as number) || money(payload.fareAmount as number),
    status: ui,
    routeId: null,
    tripStatus: ui === 'cancelled' ? 'Cancelled' : ui === 'finished' ? 'Completed' : 'Scheduled',
    pricePerSeat: money((payload.fareAmount ?? payload.totalAmount) as number),
    availableSeats: 0,
    kind: 'group',
    plateNumber: payload.plateNumber ?? null,
    vehicleColor: payload.vehicleColor ?? null,
    totalAmount: cut.total,
    appCommission: cut.appCommission,
    fareCollected,
    startedAt: payload.startedAt ?? null,
    completedAt: payload.completedAt ?? null,
    stopsList: [
      {
        id: `${id}-pickup`,
        name: String(payload.from ?? 'نقطة التجمع'),
        order: 0,
        latitude: payload.pickupLatitude ?? null,
        longitude: payload.pickupLongitude ?? null,
        boarding: Number(payload.passengers ?? 1),
        alighting: 0,
      },
      {
        id: `${id}-dropoff`,
        name: String(payload.to ?? 'الوجهة المحددة'),
        order: 1,
        latitude: payload.destinationLatitude ?? null,
        longitude: payload.destinationLongitude ?? null,
        boarding: 0,
        alighting: Number(payload.passengers ?? 1),
      },
    ],
  };
}
