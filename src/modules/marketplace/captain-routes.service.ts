import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CurrentUserService } from '../../common/current-user.service';
import {
  AppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import {
  BookingStatus,
  CancellationRequestStatus,
  DriverVerificationStatus,
  RecurrenceKind,
  RouteOwnerType,
  RoutePublishStatus,
  RouteRequestKind,
  TripStatus,
} from '../../common/enums';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import { money, refCode } from '../../common/utils/money';
import { SegmentInventoryService } from './segment-inventory.service';
import { PushNotificationService } from './push-notification.service';
import {
  matchOriginDestination,
  remainingForRange,
  type OrderedStop,
} from './segment-occupancy';
import {
  daysOfWeekCsv,
  occurrenceDates,
  parseDaysOfWeek,
  parseRecurrenceKind,
} from './recurrence';
import { randomBytes } from 'crypto';

type StopInput = {
  name: string;
  latitude: number;
  longitude: number;
};

@Injectable()
export class CaptainRoutesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly config: ConfigService,
    private readonly segments: SegmentInventoryService,
    private readonly push: PushNotificationService,
  ) {}

  async listMine() {
    const driver = await this.requireVerifiedDriver();
    const routes = await this.prisma.route.findMany({
      where: {
        ownerDriverId: driver.id,
        ownerType: RouteOwnerType.Captain,
        isDeleted: false,
      },
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        trips: {
          where: { isDeleted: false },
          include: {
            segmentInventories: { where: { isDeleted: false } },
            bookings: {
              where: {
                isDeleted: false,
                status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
              },
            },
          },
          orderBy: { scheduledAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return routes.map((route) => this.mapRoute(route));
  }

  /** Published captain routes for the rider Captain Routes screen. */
  async listPublishedForRiders() {
    const routes = await this.prisma.route.findMany({
      where: {
        isDeleted: false,
        isActive: true,
        ownerType: RouteOwnerType.Captain,
        publishStatus: RoutePublishStatus.Published,
        shareToken: { not: null },
      },
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        trips: {
          where: {
            isDeleted: false,
            status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
            scheduledAt: { gte: utcNow() },
          },
          include: { segmentInventories: { where: { isDeleted: false } } },
          orderBy: { scheduledAt: 'asc' },
          take: 5,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    return routes.map((route) => {
      const stops = route.stops
        .filter((s) => !s.isDeleted)
        .sort((a, b) => a.order - b.order);
      const nextTrip = route.trips[0];
      const remainingSeats = nextTrip
        ? remainingForRange(
            nextTrip.segmentInventories,
            stopsMin(stops),
            stopsMax(stops),
          )
        : 0;
      return {
        id: route.id,
        name: route.name,
        description: route.description,
        vehicleKind: route.vehicleKind,
        capacity: route.capacity,
        shareToken: route.shareToken,
        badgeVariant: 'captain' as const,
        stopsCount: stops.length,
        fromStop: stops[0]?.name ?? route.name,
        toStop: stops[stops.length - 1]?.name ?? route.name,
        remainingSeats,
        nextTripAt: nextTrip?.scheduledAt ?? null,
        pricePerSeat: nextTrip ? money(nextTrip.pricePerSeat) : null,
        hasAvailableSeats: remainingSeats > 0,
      };
    });
  }

  async createRoute(body: {
    name?: string;
    description?: string;
    vehicleKind?: string;
    capacity?: number;
    stops: StopInput[];
  }) {
    const driver = await this.requireVerifiedDriver();
    const stops = this.normalizeStops(body.stops);
    const first = stops[0];
    const last = stops[stops.length - 1];
    const capacity = this.resolveCapacity(body.capacity, driver);
    const created = await this.prisma.route.create({
      data: {
        id: newId(),
        name: (body.name ?? '').trim() || `${first.name} — ${last.name}`,
        description: body.description ?? null,
        startLatitude: first.latitude,
        startLongitude: first.longitude,
        endLatitude: last.latitude,
        endLongitude: last.longitude,
        isActive: false,
        ownerType: RouteOwnerType.Captain,
        ownerDriverId: driver.id,
        publishStatus: RoutePublishStatus.Draft,
        shareToken: this.newShareToken(),
        vehicleKind: body.vehicleKind ?? driver.vehicleKind,
        capacity,
        stops: {
          create: stops.map((stop, index) => ({
            id: newId(),
            name: stop.name,
            latitude: stop.latitude,
            longitude: stop.longitude,
            order: index,
            ...baseFields(),
          })),
        },
        ...baseFields(),
      },
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        trips: true,
      },
    });
    return this.mapRoute(created);
  }

  async updateRoute(
    id: string,
    body: {
      name?: string;
      description?: string;
      vehicleKind?: string;
      capacity?: number;
      stops?: StopInput[];
    },
  ) {
    const driver = await this.requireVerifiedDriver();
    const route = await this.requireOwnedRoute(id, driver.id);
    await this.assertNoActiveBookings(route.id);
    const nextStops = body.stops ? this.normalizeStops(body.stops) : null;
    const first = nextStops?.[0];
    const last = nextStops?.[nextStops.length - 1];
    const capacity = body.capacity ?? route.capacity ?? this.resolveCapacity(undefined, driver);

    await this.prisma.$transaction(async (tx) => {
      await tx.route.update({
        where: { id: route.id },
        data: {
          name: body.name?.trim() || route.name,
          description: body.description ?? route.description,
          vehicleKind: body.vehicleKind ?? route.vehicleKind,
          capacity,
          ...(first && last
            ? {
                startLatitude: first.latitude,
                startLongitude: first.longitude,
                endLatitude: last.latitude,
                endLongitude: last.longitude,
              }
            : {}),
          updatedAt: utcNow(),
        },
      });
      if (!nextStops) {
        return;
      }
      await tx.stop.updateMany({
        where: { routeId: route.id, isDeleted: false },
        data: { isDeleted: true, updatedAt: utcNow() },
      });
      const createdStops: OrderedStop[] = [];
      for (let index = 0; index < nextStops.length; index += 1) {
        const stop = nextStops[index];
        const row = await tx.stop.create({
          data: {
            id: newId(),
            routeId: route.id,
            name: stop.name,
            latitude: stop.latitude,
            longitude: stop.longitude,
            order: index,
            ...baseFields(),
          },
        });
        createdStops.push(row);
      }
      const trips = await tx.trip.findMany({
        where: {
          routeId: route.id,
          isDeleted: false,
          status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
        },
      });
      for (const trip of trips) {
        await this.segments.replaceForTrip(tx, trip.id, createdStops, capacity);
        await tx.trip.update({
          where: { id: trip.id },
          data: { availableSeats: capacity, updatedAt: utcNow() },
        });
      }
    });

    return this.getOwnedMapped(id, driver.id);
  }

  async publish(id: string) {
    const driver = await this.requireVerifiedDriver();
    const route = await this.requireOwnedRoute(id, driver.id);
    const stops = route.stops.filter((s) => !s.isDeleted).sort((a, b) => a.order - b.order);
    if (stops.length < 2) {
      throw new AppException(
        'لا يمكن النشر قبل إضافة محطتين على الأقل',
        400,
        ErrorCodes.RouteNotPublishable,
      );
    }
    const updated = await this.prisma.route.update({
      where: { id: route.id },
      data: {
        publishStatus: RoutePublishStatus.Published,
        isActive: true,
        shareToken: route.shareToken ?? this.newShareToken(),
        updatedAt: utcNow(),
      },
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        trips: true,
      },
    });
    await this.notifyMatchingDemand(updated);
    return this.mapRoute(updated);
  }

  async share(id: string) {
    const driver = await this.requireVerifiedDriver();
    const route = await this.requireOwnedRoute(id, driver.id);
    const token = route.shareToken ?? this.newShareToken();
    if (!route.shareToken) {
      await this.prisma.route.update({
        where: { id: route.id },
        data: { shareToken: token, updatedAt: utcNow() },
      });
    }
    return {
      routeId: route.id,
      name: route.name,
      token,
      url: this.shareUrl(token),
      appUrl: this.appShareUrl(token),
    };
  }

  async createTrips(body: {
    routeId: string;
    scheduledAt: string;
    pricePerSeat: number;
    recurrenceKind?: string;
    daysOfWeek?: number[] | string;
    rangeStart?: string;
    rangeEnd?: string;
    availableSeats?: number;
  }) {
    const driver = await this.requireVerifiedDriver();
    const route = await this.requireOwnedRoute(body.routeId, driver.id);
    const stops = route.stops
      .filter((s) => !s.isDeleted)
      .sort((a, b) => a.order - b.order);
    if (stops.length < 2) {
      throw new AppException(
        'المسار يحتاج محطتين على الأقل',
        400,
        ErrorCodes.InvalidStops,
      );
    }
    const scheduledAt = new Date(body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new AppException('موعد الرحلة غير صالح', 400, ErrorCodes.InvalidRecurrence);
    }
    const kind = parseRecurrenceKind(body.recurrenceKind);
    const days = parseDaysOfWeek(body.daysOfWeek);
    const rangeStart = body.rangeStart ? new Date(body.rangeStart) : null;
    const rangeEnd = body.rangeEnd ? new Date(body.rangeEnd) : null;
    const dates = occurrenceDates({
      kind,
      scheduledAt,
      daysOfWeek: days,
      rangeStart,
      rangeEnd,
    });
    const capacity =
      body.availableSeats ?? route.capacity ?? this.resolveCapacity(undefined, driver);
    const price = Number(body.pricePerSeat);
    if (!(price >= 0)) {
      throw new AppException('السعر غير صالح', 400, ErrorCodes.PricingNotAvailable);
    }

    const createdIds: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      let parentId: string | null = null;
      for (const date of dates) {
        const tripId = newId();
        await tx.trip.create({
          data: {
            id: tripId,
            routeId: route.id,
            driverId: driver.id,
            status: TripStatus.Scheduled,
            scheduledAt: date,
            pricePerSeat: new Prisma.Decimal(price),
            availableSeats: capacity,
            referenceCode: refCode('TR'),
            parentTripId: parentId,
            recurrenceKind: kind,
            recurrenceDaysOfWeek: daysOfWeekCsv(days),
            recurrenceStartDate:
              kind === RecurrenceKind.Once ? null : (rangeStart ?? dates[0]),
            recurrenceEndDate:
              kind === RecurrenceKind.Once ? null : (rangeEnd ?? dates[dates.length - 1]),
            ...baseFields(),
          },
        });
        if (!parentId) {
          parentId = tripId;
        }
        await this.segments.createForTrip(tx, tripId, stops, capacity);
        createdIds.push(tripId);
      }
    });

    return {
      routeId: route.id,
      recurrenceKind: kind,
      count: createdIds.length,
      tripIds: createdIds,
    };
  }

  async requestCancellation(tripId: string, reason?: string) {
    const driver = await this.requireVerifiedDriver();
    const trip = await this.prisma.trip.findFirst({
      where: {
        id: tripId,
        driverId: driver.id,
        isDeleted: false,
      },
      include: {
        bookings: {
          where: {
            isDeleted: false,
            status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
          },
        },
        cancellationRequests: {
          where: {
            isDeleted: false,
            status: CancellationRequestStatus.Pending,
          },
        },
      },
    });
    if (!trip) {
      throw new NotFoundException('الرحلة غير موجودة', ErrorCodes.TripNotFound);
    }
    if (trip.status === TripStatus.Cancelled) {
      return { tripId: trip.id, status: 'cancelled', requestId: null as string | null };
    }
    if (trip.bookings.length === 0) {
      await this.prisma.trip.update({
        where: { id: trip.id },
        data: { status: TripStatus.Cancelled, updatedAt: utcNow() },
      });
      return { tripId: trip.id, status: 'cancelled', requestId: null as string | null };
    }
    if (trip.cancellationRequests.length > 0) {
      throw new AppException(
        'يوجد طلب إلغاء قيد المراجعة',
        400,
        ErrorCodes.CancellationPending,
      );
    }
    const created = await this.prisma.cancellationRequest.create({
      data: {
        id: newId(),
        tripId: trip.id,
        driverId: driver.id,
        reason: reason ?? null,
        status: CancellationRequestStatus.Pending,
        ...baseFields(),
      },
    });
    return {
      tripId: trip.id,
      status: 'pending',
      requestId: created.id,
      activeBookings: trip.bookings.length,
    };
  }

  async listCancellationRequests(status?: number) {
    const where: Prisma.CancellationRequestWhereInput = {
      isDeleted: false,
      ...(status != null ? { status } : {}),
    };
    const items = await this.prisma.cancellationRequest.findMany({
      where,
      include: {
        trip: { include: { route: true, bookings: { where: { isDeleted: false } } } },
        driver: { include: { user: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return items.map((item) => ({
      id: item.id,
      tripId: item.tripId,
      driverId: item.driverId,
      driverName: item.driver.user.fullName,
      driverPhone: item.driver.user.phone,
      routeName: item.trip.route.name,
      scheduledAt: item.trip.scheduledAt,
      reason: item.reason,
      status: item.status,
      adminNotes: item.adminNotes,
      activeBookings: item.trip.bookings.filter((b) =>
        [BookingStatus.Pending, BookingStatus.Confirmed].includes(b.status as 1 | 2),
      ).length,
      createdAt: item.createdAt,
    }));
  }

  async reviewCancellation(
    id: string,
    statusRaw: string,
    adminNotes?: string,
  ) {
    const request = await this.prisma.cancellationRequest.findFirst({
      where: { id, isDeleted: false },
      include: {
        trip: {
          include: {
            bookings: {
              where: {
                isDeleted: false,
                status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
              },
              include: { originStop: true, destinationStop: true },
            },
            driver: { include: { user: true } },
          },
        },
      },
    });
    if (!request) {
      throw new NotFoundException('طلب الإلغاء غير موجود', ErrorCodes.CancellationNotFound);
    }
    const approved = statusRaw.trim().toLowerCase() === 'approved';
    const nextStatus = approved
      ? CancellationRequestStatus.Approved
      : CancellationRequestStatus.Rejected;

    if (!approved) {
      await this.prisma.cancellationRequest.update({
        where: { id: request.id },
        data: {
          status: nextStatus,
          adminNotes: adminNotes ?? request.adminNotes,
          updatedAt: utcNow(),
        },
      });
      if (request.trip.driver?.userId) {
        await this.push.notifyUser(
          request.trip.driver.userId,
          'طلب الإلغاء',
          'تم رفض طلب إلغاء الرحلة',
          'cancellation_rejected',
          { tripId: request.tripId },
        );
      }
      return { id: request.id, status: 'rejected' };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${request.tripId}))`;
      await tx.cancellationRequest.update({
        where: { id: request.id },
        data: {
          status: nextStatus,
          adminNotes: adminNotes ?? request.adminNotes,
          updatedAt: utcNow(),
        },
      });
      await tx.trip.update({
        where: { id: request.tripId },
        data: { status: TripStatus.Cancelled, updatedAt: utcNow() },
      });
      for (const booking of request.trip.bookings) {
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.Cancelled, updatedAt: utcNow() },
        });
        if (booking.originStop && booking.destinationStop) {
          await this.segments.tryIncrementRange(
            tx,
            request.tripId,
            booking.originStop.order,
            booking.destinationStop.order,
            booking.seatCount,
          );
        } else {
          await tx.$executeRaw`
            UPDATE "TripsSet"
            SET "AvailableSeats" = "AvailableSeats" + ${booking.seatCount},
                "UpdatedAt" = NOW()
            WHERE "Id" = ${request.tripId}::uuid AND "IsDeleted" = false`;
        }
      }
      await this.segments.syncTripAvailableSeats(tx, request.tripId);
    });

    const riderIds = [...new Set(request.trip.bookings.map((b) => b.userId))];
    for (const userId of riderIds) {
      await this.push.notifyUser(
        userId,
        'إلغاء الرحلة',
        'تم إلغاء الرحلة بواسطة الإدارة',
        'trip_cancelled',
        { tripId: request.tripId },
      );
    }
    if (request.trip.driver?.userId) {
      await this.push.notifyUser(
        request.trip.driver.userId,
        'طلب الإلغاء',
        'تمت الموافقة على إلغاء الرحلة',
        'cancellation_approved',
        { tripId: request.tripId },
      );
    }
    return { id: request.id, status: 'approved' };
  }

  async getShared(token: string) {
    const route = await this.prisma.route.findFirst({
      where: {
        shareToken: token,
        isDeleted: false,
        isActive: true,
        publishStatus: RoutePublishStatus.Published,
      },
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        trips: {
          where: {
            isDeleted: false,
            status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
            scheduledAt: { gte: utcNow() },
          },
          include: { segmentInventories: { where: { isDeleted: false } } },
          orderBy: { scheduledAt: 'asc' },
          take: 20,
        },
      },
    });
    if (!route) {
      throw new NotFoundException('المسار غير موجود', ErrorCodes.RouteNotFound);
    }
    return {
      id: route.id,
      name: route.name,
      description: route.description,
      vehicleKind: route.vehicleKind,
      capacity: route.capacity,
      badgeVariant: 'captain',
      stops: route.stops.map((stop) => ({
        id: stop.id,
        name: stop.name,
        latitude: stop.latitude,
        longitude: stop.longitude,
        order: stop.order,
      })),
      upcomingTrips: route.trips.map((trip) => ({
        id: trip.id,
        scheduledAt: trip.scheduledAt,
        pricePerSeat: money(trip.pricePerSeat),
        remainingSeats: remainingForRange(
          trip.segmentInventories,
          stopsMin(route.stops),
          stopsMax(route.stops),
        ),
        segments: trip.segmentInventories.map((seg) => ({
          fromOrder: seg.fromOrder,
          toOrder: seg.toOrder,
          remainingSeats: seg.remainingSeats,
          capacity: seg.capacity,
        })),
      })),
    };
  }

  private async notifyMatchingDemand(route: {
    id: string;
    name: string;
    shareToken?: string | null;
    stops: OrderedStop[];
  }) {
    const pending = await this.prisma.routeRequest.findMany({
      where: {
        isDeleted: false,
        status: 'pending',
        kind: RouteRequestKind.Notify,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    for (const request of pending) {
      const match = matchOriginDestination(
        route.stops,
        request.fromLatitude,
        request.fromLongitude,
        request.toLatitude,
        request.toLongitude,
      );
      if (!match) {
        continue;
      }
      await this.push.notifyUser(
        request.userId,
        'مسار جديد على طلبك',
        `ظهر مسار كابتن يطابق ${route.name}`,
        'notify_me_match',
        { routeId: route.id, shareToken: route.shareToken ?? '' },
      );
    }
  }

  private async getOwnedMapped(id: string, driverId: string) {
    const route = await this.requireOwnedRoute(id, driverId);
    return this.mapRoute(route);
  }

  private mapRoute(route: {
    id: string;
    name: string;
    description: string | null;
    publishStatus: number;
    isActive: boolean;
    vehicleKind: string | null;
    capacity: number | null;
    shareToken: string | null;
    stops: Array<{
      id: string;
      name: string;
      latitude: number;
      longitude: number;
      order: number;
      isDeleted: boolean;
    }>;
    trips?: Array<{
      id: string;
      scheduledAt: Date;
      status: number;
      availableSeats: number;
      segmentInventories?: Array<{
        fromOrder: number;
        toOrder: number;
        remainingSeats: number;
        capacity: number;
      }>;
      bookings?: Array<{ id: string }>;
    }>;
  }) {
    const stops = route.stops
      .filter((s) => !s.isDeleted)
      .sort((a, b) => a.order - b.order);
    return {
      id: route.id,
      name: route.name,
      description: route.description,
      publishStatus: route.publishStatus,
      isActive: route.isActive,
      vehicleKind: route.vehicleKind,
      capacity: route.capacity,
      shareToken: route.shareToken,
      shareUrl: route.shareToken ? this.shareUrl(route.shareToken) : null,
      stops: stops.map((stop) => ({
        id: stop.id,
        name: stop.name,
        latitude: stop.latitude,
        longitude: stop.longitude,
        order: stop.order,
      })),
      trips: (route.trips ?? []).map((trip) => ({
        id: trip.id,
        scheduledAt: trip.scheduledAt,
        status: trip.status,
        availableSeats: trip.availableSeats,
        activeBookings: trip.bookings?.length ?? 0,
        segments: (trip.segmentInventories ?? []).map((seg) => ({
          fromOrder: seg.fromOrder,
          toOrder: seg.toOrder,
          remainingSeats: seg.remainingSeats,
          capacity: seg.capacity,
        })),
      })),
    };
  }

  private async assertNoActiveBookings(routeId: string) {
    const count = await this.prisma.booking.count({
      where: {
        isDeleted: false,
        status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
        trip: { routeId, isDeleted: false },
      },
    });
    if (count > 0) {
      throw new AppException(
        'لا يمكن تعديل المسار بعد وجود حجوزات. أرسل طلب إلغاء.',
        400,
        ErrorCodes.RouteNotEditable,
      );
    }
  }

  private normalizeStops(stops: StopInput[] | undefined): StopInput[] {
    const cleaned = (stops ?? [])
      .map((stop) => ({
        name: (stop.name ?? '').trim(),
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
      }))
      .filter(
        (stop) =>
          stop.name.length > 0 &&
          Number.isFinite(stop.latitude) &&
          Number.isFinite(stop.longitude),
      );
    if (cleaned.length < 2) {
      throw new AppException(
        'أضف محطتين على الأقل',
        400,
        ErrorCodes.InvalidStops,
      );
    }
    return cleaned;
  }

  private resolveCapacity(
    requested: number | undefined,
    driver: { seats: number | null; vehicle: { capacity: number } | null },
  ): number {
    const value = requested ?? driver.seats ?? driver.vehicle?.capacity ?? 4;
    if (!Number.isInteger(value) || value < 1) {
      throw new AppException('سعة المركبة غير صالحة', 400, ErrorCodes.InvalidSeatCount);
    }
    return value;
  }

  private newShareToken(): string {
    return randomBytes(16).toString('hex');
  }

  private shareUrl(token: string): string {
    const base = (this.config.get<string>('APP_PUBLIC_URL') ?? 'https://shuttlez.org').replace(
      /\/$/,
      '',
    );
    return `${base}/r/${token}`;
  }

  private appShareUrl(token: string): string {
    return `shuttlez://r/${token}`;
  }

  private async requireOwnedRoute(id: string, driverId: string) {
    const route = await this.prisma.route.findFirst({
      where: {
        id,
        ownerDriverId: driverId,
        ownerType: RouteOwnerType.Captain,
        isDeleted: false,
      },
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        trips: {
          where: { isDeleted: false },
          include: {
            segmentInventories: { where: { isDeleted: false } },
            bookings: {
              where: {
                isDeleted: false,
                status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
              },
            },
          },
          orderBy: { scheduledAt: 'asc' },
        },
      },
    });
    if (!route) {
      throw new NotFoundException('المسار غير موجود', ErrorCodes.RouteNotFound);
    }
    return route;
  }

  private async requireVerifiedDriver() {
    const userId = this.currentUser.requireUserId();
    const driver = await this.prisma.driver.findFirst({
      where: { userId, isDeleted: false },
      include: { user: true, vehicle: true },
    });
    if (!driver || !driver.isActive) {
      throw new AppException(
        'حساب الكابتن غير موجود أو غير نشط',
        403,
        ErrorCodes.DriverNotEligible,
      );
    }
    if (driver.verificationStatus !== DriverVerificationStatus.Approved) {
      throw new AppException(
        'يجب توثيق حساب الكابتن قبل نشر المسارات',
        403,
        ErrorCodes.DriverNotVerified,
      );
    }
    return driver;
  }
}

function stopsMin(stops: Array<{ order: number }>): number {
  return Math.min(...stops.map((s) => s.order));
}

function stopsMax(stops: Array<{ order: number }>): number {
  return Math.max(...stops.map((s) => s.order));
}
