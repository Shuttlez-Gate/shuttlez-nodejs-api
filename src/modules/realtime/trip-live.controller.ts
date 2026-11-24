import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  monotonicNow,
  recordPerformanceDiagnostic,
} from '../../common/performance-diagnostics';
import { ApiResponse } from '../../common/api-response';
import { CurrentUserService } from '../../common/current-user.service';
import {
  AppException,
  ForbiddenAppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { newId } from '../../common/utils/date.util';
import { PrismaService } from '../../database/prisma/prisma.service';
import { TripTrackingGateway } from './realtime.gateway';

type AccessRow = {
  bookingId: string | null;
  riderUserId: string | null;
  driverUserId: string | null;
  tripId: string;
};

type ChatRow = {
  id: string;
  tripId: string;
  bookingId: string | null;
  senderUserId: string;
  body: string;
  createdAt: Date;
  fromDriver: boolean;
};

@Controller('api/v1/trips')
export class TripLiveController {
  private tableReady: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly tracking: TripTrackingGateway,
  ) {}

  @Get(':tripId/live')
  live(@Param('tripId') tripId: string) {
    this.currentUser.requireUserId();
    return ApiResponse.ok(this.tracking.snapshot(tripId));
  }

  @Post(':tripId/live')
  async pushLive(
    @Param('tripId') tripId: string,
    @Body()
    body?: {
      stopOrder?: number;
      latitude?: number;
      longitude?: number;
      heading?: number;
      boardedUserIds?: string[];
      boardedBookingIds?: string[];
      notifyUserIds?: string[];
    },
  ) {
    const requestStartedAt = monotonicNow();
    const userId = this.currentUser.requireUserId();
    const tripLookupStartedAt = monotonicNow();
    const rows = await this.tripRows(tripId);
    const tripLookupCompletedAt = monotonicNow();
    const driverUserId = rows[0]?.driverUserId ?? '';
    if (driverUserId.toLowerCase() !== userId.toLowerCase()) {
      throw new ForbiddenAppException('غير مسموح');
    }
    const emissionStartedAt = monotonicNow();
    const progress = this.tracking.applyLive({
      tripId: rows[0].tripId,
      stopOrder: body?.stopOrder ?? 0,
      latitude: body?.latitude,
      longitude: body?.longitude,
      heading: body?.heading ?? 0,
      boardedUserIds: body?.boardedUserIds ?? [],
      boardedBookingIds: body?.boardedBookingIds ?? [],
      notifyUserIds: body?.notifyUserIds ?? [],
    });
    const emissionCompletedAt = monotonicNow();
    recordPerformanceDiagnostic('trip_tracking.live_push', {
      requestStartedAtMonotonicMs: requestStartedAt,
      tripLookupStartedAtMonotonicMs: tripLookupStartedAt,
      tripLookupCompletedAtMonotonicMs: tripLookupCompletedAt,
      emissionStartedAtMonotonicMs: emissionStartedAt,
      emissionCompletedAtMonotonicMs: emissionCompletedAt,
      tripLookupMs: tripLookupCompletedAt - tripLookupStartedAt,
      emissionMs: emissionCompletedAt - emissionStartedAt,
      totalMs: emissionCompletedAt - requestStartedAt,
    });
    return ApiResponse.ok(progress);
  }

  @Get(':tripId/chat/unread')
  async unread(
    @Param('tripId') tripId: string,
    @Query('bookingId') bookingId?: string,
  ) {
    const userId = this.currentUser.requireUserId();
    await this.ensureTable();
    const rows = await this.tripRows(tripId);
    const driverUserId = rows[0]?.driverUserId ?? null;
    const isDriver = driverUserId?.toLowerCase() === userId.toLowerCase();
    if (isDriver && !bookingId?.trim()) {
      const counts = await this.prisma.$queryRaw<{ bookingId: string; count: number }[]>`
        SELECT "BookingId"::text AS "bookingId", COUNT(*)::int AS count
        FROM "TripChatMessagesSet"
        WHERE "TripId" = CAST(${rows[0].tripId} AS uuid)
          AND "IsDeleted" = false
          AND "ReadByDriver" = false
          AND LOWER("SenderUserId"::text) <> LOWER(${userId})
        GROUP BY "BookingId"
      `;
      const map: Record<string, number> = {};
      for (const row of counts) {
        if (row.bookingId) map[row.bookingId.toLowerCase()] = Number(row.count) || 0;
      }
      return ApiResponse.ok({ counts: map });
    }
    const access = await this.access(tripId, bookingId);
    const readerIsDriver =
      access.driverUserId?.toLowerCase() === access.userId.toLowerCase();
    const countRows = readerIsDriver
      ? await this.prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM "TripChatMessagesSet"
          WHERE "TripId" = CAST(${access.tripId} AS uuid)
            AND "BookingId" = CAST(${access.bookingId} AS uuid)
            AND "IsDeleted" = false
            AND "ReadByDriver" = false
            AND LOWER("SenderUserId"::text) <> LOWER(${access.userId})
        `
      : await this.prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM "TripChatMessagesSet"
          WHERE "TripId" = CAST(${access.tripId} AS uuid)
            AND "BookingId" = CAST(${access.bookingId} AS uuid)
            AND "IsDeleted" = false
            AND "ReadByRider" = false
            AND LOWER("SenderUserId"::text) <> LOWER(${access.userId})
        `;
    return ApiResponse.ok({
      counts: {
        [(access.bookingId ?? '').toLowerCase()]: Number(countRows[0]?.count) || 0,
      },
    });
  }

  @Post(':tripId/chat/read')
  async markRead(
    @Param('tripId') tripId: string,
    @Body() body?: { bookingId?: string },
  ) {
    const access = await this.access(tripId, body?.bookingId);
    await this.ensureTable();
    const driver =
      access.driverUserId?.toLowerCase() === access.userId.toLowerCase();
    if (driver) {
      await this.prisma.$executeRaw`
        UPDATE "TripChatMessagesSet"
        SET "ReadByDriver" = true
        WHERE "TripId" = CAST(${access.tripId} AS uuid)
          AND "BookingId" = CAST(${access.bookingId} AS uuid)
          AND "IsDeleted" = false
          AND "ReadByDriver" = false
          AND LOWER("SenderUserId"::text) <> LOWER(${access.userId})
      `;
    } else {
      await this.prisma.$executeRaw`
        UPDATE "TripChatMessagesSet"
        SET "ReadByRider" = true
        WHERE "TripId" = CAST(${access.tripId} AS uuid)
          AND "BookingId" = CAST(${access.bookingId} AS uuid)
          AND "IsDeleted" = false
          AND "ReadByRider" = false
          AND LOWER("SenderUserId"::text) <> LOWER(${access.userId})
      `;
    }
    return ApiResponse.ok({ read: true });
  }

  @Get(':tripId/chat')
  async messages(
    @Param('tripId') tripId: string,
    @Query('bookingId') bookingId?: string,
  ) {
    const access = await this.access(tripId, bookingId);
    await this.ensureTable();
    const rows = await this.prisma.$queryRaw<ChatRow[]>`
      SELECT "Id" AS id,
             "TripId" AS "tripId",
             "BookingId" AS "bookingId",
             "SenderUserId" AS "senderUserId",
             "Body" AS body,
             "CreatedAt" AS "createdAt",
             (LOWER("SenderUserId"::text) = LOWER(${access.driverUserId ?? ''}::text)) AS "fromDriver"
      FROM "TripChatMessagesSet"
      WHERE "TripId" = CAST(${access.tripId} AS uuid)
        AND "IsDeleted" = false
        AND "BookingId" = CAST(${access.bookingId} AS uuid)
      ORDER BY "CreatedAt" ASC
      LIMIT 200
    `;
    return ApiResponse.ok(rows.map(mapChat));
  }

  @Post(':tripId/chat')
  async send(
    @Param('tripId') tripId: string,
    @Body() body?: { bookingId?: string; body?: string },
  ) {
    const text = body?.body?.trim() ?? '';
    if (!text || text.length > 2000) {
      throw new AppException('الرسالة غير صالحة');
    }
    const access = await this.access(tripId, body?.bookingId);
    await this.ensureTable();
    const id = newId();
    const now = new Date();
    const fromDriver =
      access.driverUserId?.toLowerCase() === access.userId.toLowerCase();
    await this.prisma.$executeRaw`
      INSERT INTO "TripChatMessagesSet"
        ("Id", "TripId", "BookingId", "SenderUserId", "Body", "CreatedAt", "IsDeleted", "ReadByDriver", "ReadByRider")
      VALUES (
        CAST(${id} AS uuid),
        CAST(${access.tripId} AS uuid),
        CAST(${access.bookingId} AS uuid),
        CAST(${access.userId} AS uuid),
        ${text},
        ${now},
        false,
        ${fromDriver},
        ${!fromDriver}
      )
    `;
    const message = {
      id,
      tripId: access.tripId,
      bookingId: access.bookingId,
      senderUserId: access.userId,
      fromDriver,
      body: text,
      createdAt: now.toISOString(),
      riderUserId: access.riderUserId,
      driverUserId: access.driverUserId,
    };
    this.tracking.publishChat(message);
    return ApiResponse.ok(message, 'تم إرسال الرسالة');
  }

  private async tripRows(tripId: string) {
    try {
      const rows = await this.prisma.$queryRaw<AccessRow[]>`
        SELECT b."Id" AS "bookingId",
               b."UserId" AS "riderUserId",
               d."UserId" AS "driverUserId",
               t."Id" AS "tripId"
        FROM "TripsSet" t
        LEFT JOIN "DriversSet" d ON d."Id" = t."DriverId"
        LEFT JOIN "BookingsSet" b
          ON b."TripId" = t."Id"
         AND b."IsDeleted" = false
         AND b."Status" IN (1, 2)
        WHERE t."Id" = CAST(${tripId} AS uuid)
          AND t."IsDeleted" = false
      `;
      if (rows.length > 0) return rows;
    } catch {
      // A private ride id is not a shuttle trip.
    }
    return this.rideRows(tripId);
  }

  /// Private rides have one rider. The ride id is the chat thread id.
  private async rideRows(tripId: string) {
    let ride: {
      id: string;
      riderUserId: string;
      driver: { userId: string } | null;
    } | null = null;
    try {
      ride = await this.prisma.rideRequest.findFirst({
        where: { id: tripId, isDeleted: false },
        select: {
          id: true,
          riderUserId: true,
          driver: { select: { userId: true } },
        },
      });
    } catch {
      ride = null;
    }
    if (!ride) {
      throw new NotFoundException('الرحلة غير موجودة');
    }
    return [
      {
        bookingId: ride.id,
        riderUserId: ride.riderUserId,
        driverUserId: ride.driver?.userId ?? null,
        tripId: ride.id,
      },
    ];
  }

  private async access(tripId: string, bookingId?: string) {
    const userId = this.currentUser.requireUserId();
    const rows = await this.tripRows(tripId);
    const driverUserId = rows[0].driverUserId;
    const isDriver = driverUserId?.toLowerCase() === userId.toLowerCase();
    const wanted = bookingId?.trim();
    const same = (left?: string | null, right?: string | null) =>
      (left ?? '').trim().toLowerCase() === (right ?? '').trim().toLowerCase();
    const booking = wanted
      ? rows.find((row) => same(row.bookingId, wanted))
      : rows.find((row) => same(row.riderUserId, userId));
    if (!booking?.bookingId) {
      throw new NotFoundException('الحجز غير موجود');
    }
    if (!isDriver && !same(booking.riderUserId, userId)) {
      throw new ForbiddenAppException('غير مسموح');
    }
    return {
      tripId: rows[0].tripId,
      bookingId: booking.bookingId,
      userId,
      riderUserId: booking.riderUserId,
      driverUserId,
    };
  }

  private ensureTable() {
    this.tableReady ??= (async () => {
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "TripChatMessagesSet" (
          "Id" uuid PRIMARY KEY,
          "TripId" uuid NOT NULL,
          "BookingId" uuid,
          "SenderUserId" uuid NOT NULL,
          "Body" varchar(2000) NOT NULL,
          "CreatedAt" timestamptz NOT NULL,
          "IsDeleted" boolean NOT NULL DEFAULT false,
          "ReadByDriver" boolean NOT NULL DEFAULT false,
          "ReadByRider" boolean NOT NULL DEFAULT false
        )
      `);
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "TripChatMessagesSet"
        ADD COLUMN IF NOT EXISTS "ReadByDriver" boolean NOT NULL DEFAULT false
      `);
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "TripChatMessagesSet"
        ADD COLUMN IF NOT EXISTS "ReadByRider" boolean NOT NULL DEFAULT false
      `);
    })();
    return this.tableReady;
  }
}

function isSqlTrue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const flag = value.trim().toLowerCase();
    return flag === 't' || flag === 'true' || flag === '1';
  }
  return false;
}

function mapChat(row: ChatRow) {
  return {
    id: row.id,
    tripId: row.tripId,
    bookingId: row.bookingId,
    senderUserId: row.senderUserId,
    fromDriver: isSqlTrue(row.fromDriver),
    body: row.body,
    createdAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt),
  };
}
