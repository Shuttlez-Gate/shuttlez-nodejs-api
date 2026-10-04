import { Injectable, Logger } from '@nestjs/common';
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
import { pageRequestFrom, PagedResult } from '../../common/paged-result';
import {
  captainVehicleKind,
  defaultCapacityForVehicleKind,
  vehicleKindsCompatible,
} from '../../common/utils/enums-map';
import { SegmentInventoryService } from './segment-inventory.service';
import { PushNotificationService } from './push-notification.service';
import {
  matchOriginDestination,
  remainingForRange,
  type OrderedStop,
} from './segment-occupancy';
import {
  daysForScheduleType,
  daysOfWeekCsv,
  occurrenceDates,
  parseRecurrenceKind,
} from './recurrence';
import {
  captainRouteLifecycle,
  isRecurringKind,
  tripTimeBucket,
} from './captain-route-status';
import { randomBytes } from 'crypto';

type StopInput = {
  name: string;
  latitude: number;
  longitude: number;
};

type DriverCapacitySource = {
  id: string;
  seats: number | null;
  vehicleKind: string | null;
  vehicle: { capacity: number; type?: number | null } | null;
};

type CreateTripsBody = {
  routeId: string;
  scheduledAt: string;
  pricePerSeat: number;
  recurrenceKind?: string;
  scheduleType?: string;
  daysOfWeek?: number[] | string;
  rangeStart?: string;
  rangeEnd?: string;
  availableSeats?: number;
};

export type PassengerSearchQuery = {
  fromLatitude?: number | null;
  fromLongitude?: number | null;
  toLatitude?: number | null;
  toLongitude?: number | null;
  date?: string | null;
  time?: string | null;
  passengers?: number | null;
  vehicleKind?: string | null;
};

@Injectable()
export class CaptainRoutesService {
  private readonly logger = new Logger(CaptainRoutesService.name);

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
  async listPublishedForRiders(query: PassengerSearchQuery = {}) {
    return this.searchPublished(query);
  }

  async createRoute(body: {
    name?: string;
    description?: string;
    vehicleKind?: string;
    capacity?: number;
    stops: StopInput[];
  }) {
    const driver = await this.requireVerifiedDriver();
    const created = await this.createRouteForDriver(driver, body);
    this.logger.log({ event: 'CaptainRouteCreated', routeId: created.id, driverId: driver.id });
    return created;
  }

  async createRouteForDriver(
    driver: DriverCapacitySource,
    body: {
      name?: string;
      description?: string;
      vehicleKind?: string;
      capacity?: number;
      stops: StopInput[];
    },
  ) {
    const stops = this.normalizeStops(body.stops);
    const first = stops[0];
    const last = stops[stops.length - 1];
    const vehicleKind = body.vehicleKind ?? captainVehicleKind(driver);
    const capacity = this.resolveCapacity(body.capacity, driver, vehicleKind);
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
        vehicleKind,
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
    driverOverride?: DriverCapacitySource,
  ) {
    const driver = driverOverride ?? (await this.requireVerifiedDriver());
    const route = await this.requireOwnedRoute(id, driver.id);
    await this.assertNoActiveBookings(route.id);
    const nextStops = body.stops ? this.normalizeStops(body.stops) : null;
    const first = nextStops?.[0];
    const last = nextStops?.[nextStops.length - 1];
    const capacity = body.capacity ?? route.capacity ?? this.resolveCapacity(undefined, driver, body.vehicleKind ?? route.vehicleKind);

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
    this.logger.log({ event: 'CaptainRouteActivated', routeId: updated.id, driverId: driver.id });
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

  async createTrips(body: CreateTripsBody) {
    const driver = await this.requireVerifiedDriver();
    const result = await this.createTripsForDriver(driver, body);
    this.logger.log({
      event: 'CaptainRouteScheduleChanged',
      routeId: result.routeId,
      driverId: driver.id,
      count: result.count,
    });
    return result;
  }

  async createTripsForDriver(driver: DriverCapacitySource, body: CreateTripsBody) {
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
    const kind = parseRecurrenceKind(body.recurrenceKind ?? body.scheduleType);
    const days = daysForScheduleType(body.scheduleType ?? body.recurrenceKind, body.daysOfWeek);
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
      body.availableSeats ?? route.capacity ?? this.resolveCapacity(undefined, driver, route.vehicleKind);
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

  async searchPublished(query: PassengerSearchQuery = {}) {
    const now = utcNow();
    const passengers = query.passengers && query.passengers > 0 ? query.passengers : 1;
    const hasCoords =
      query.fromLatitude != null &&
      query.fromLongitude != null &&
      query.toLatitude != null &&
      query.toLongitude != null;
    const dateKey = query.date?.trim() || null;
    const time = query.time?.trim() || null;

    const routes = await this.prisma.route.findMany({
      where: {
        isDeleted: false,
        isActive: true,
        ownerType: RouteOwnerType.Captain,
        publishStatus: RoutePublishStatus.Published,
      },
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        ownerDriver: { include: { user: true, vehicle: true } },
        trips: {
          where: {
            isDeleted: false,
            status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
            scheduledAt: { gte: now },
          },
          include: { segmentInventories: { where: { isDeleted: false } } },
          orderBy: { scheduledAt: 'asc' },
          take: 20,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 80,
    });

    const results = [];
    for (const route of routes) {
      const stops = route.stops
        .filter((s) => !s.isDeleted)
        .sort((a, b) => a.order - b.order);
      if (stops.length < 2) continue;
      if (!vehicleKindsCompatible(query.vehicleKind, route.vehicleKind ?? (route.ownerDriver ? captainVehicleKind(route.ownerDriver) : null))) {
        continue;
      }

      let origin: { id: string; name: string; order: number } = stops[0];
      let destination: { id: string; name: string; order: number } = stops[stops.length - 1];
      if (hasCoords) {
        const match = matchOriginDestination(
          stops,
          query.fromLatitude!,
          query.fromLongitude!,
          query.toLatitude!,
          query.toLongitude!,
        );
        if (!match) continue;
        origin = match.origin;
        destination = match.destination;
      }

      const matchingTrips = route.trips.filter((trip) => {
        if (dateKey && cairoDateKey(trip.scheduledAt) !== dateKey) return false;
        if (time) {
          const hm = `${String(trip.scheduledAt.getUTCHours()).padStart(2, '0')}:${String(
            trip.scheduledAt.getUTCMinutes(),
          ).padStart(2, '0')}`;
          if (hm !== time) return false;
        }
        const remaining = remainingForRange(
          trip.segmentInventories,
          origin.order,
          destination.order,
        );
        return remaining >= passengers;
      });
      if (dateKey && matchingTrips.length === 0) continue;
      const nextTrip = matchingTrips[0] ?? route.trips[0] ?? null;
      const remainingSeats = nextTrip
        ? remainingForRange(nextTrip.segmentInventories, origin.order, destination.order)
        : 0;
      if (hasCoords && remainingSeats < passengers) continue;

      const driver = route.ownerDriver;
      const ratingCount = driver?.ratingCount ?? 0;
      results.push({
        id: route.id,
        captainRouteId: route.id,
        name: route.name,
        description: route.description,
        vehicleKind: route.vehicleKind ?? (driver ? captainVehicleKind(driver) : null),
        vehicle: {
          id: driver?.vehicleId ?? null,
          type: route.vehicleKind ?? (driver ? captainVehicleKind(driver) : null),
          plateNumber: driver?.plateNumber ?? driver?.vehicle?.plateNumber ?? null,
          capacity: route.capacity ?? driver?.seats ?? driver?.vehicle?.capacity ?? null,
        },
        capacity: route.capacity,
        shareToken: route.shareToken,
        badgeVariant: 'captain' as const,
        status: captainRouteLifecycle({
          publishStatus: route.publishStatus,
          isActive: route.isActive,
          nextTripAt: nextTrip?.scheduledAt ?? null,
          now,
        }),
        stops: stops.map((stop) => ({
          id: stop.id,
          name: stop.name,
          latitude: stop.latitude,
          longitude: stop.longitude,
          order: stop.order,
        })),
        stopsCount: stops.length,
        origin: origin.name,
        destination: destination.name,
        fromStop: origin.name,
        toStop: destination.name,
        originStopId: origin.id,
        destinationStopId: destination.id,
        remainingSeats,
        availableSeats: remainingSeats,
        nextTripAt: nextTrip?.scheduledAt ?? null,
        departureTime: nextTrip?.scheduledAt ?? null,
        pricePerSeat: nextTrip ? money(nextTrip.pricePerSeat) : null,
        hasAvailableSeats: remainingSeats > 0,
        captain: driver
          ? {
              id: driver.id,
              name: driver.user.fullName,
              photoUrl: driver.user.avatarUrl,
              phone: driver.user.phone,
              isActive: driver.isActive,
            }
          : null,
        captainName: driver?.user.fullName ?? null,
        captainPhotoUrl: driver?.user.avatarUrl ?? null,
        captainRatingAverage:
          ratingCount > 0 && driver ? money(driver.ratingAverage) : null,
        captainRatingCount: ratingCount,
        recurrenceKind: nextTrip?.recurrenceKind ?? null,
        recurrenceDays: nextTrip?.recurrenceDaysOfWeek ?? null,
      });
    }
    return results;
  }

  async adminList(query: {
    search?: string;
    driverId?: string;
    vehicleKind?: string;
    status?: string;
    scheduleType?: string;
    date?: string;
    origin?: string;
    destination?: string;
    page?: string | number;
    pageSize?: string | number;
  }) {
    const paging = pageRequestFrom(Number(query.page), Number(query.pageSize));
    const now = utcNow();
    const where: Prisma.RouteWhereInput = {
      isDeleted: false,
      ownerType: RouteOwnerType.Captain,
      ...(query.driverId ? { ownerDriverId: query.driverId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search } },
              { description: { contains: query.search } },
              { ownerDriver: { user: { fullName: { contains: query.search } } } },
              { ownerDriver: { user: { phone: { contains: query.search } } } },
            ],
          }
        : {}),
      ...(query.origin || query.destination
        ? {
            stops: {
              some: {
                isDeleted: false,
                OR: [
                  ...(query.origin ? [{ name: { contains: query.origin } }] : []),
                  ...(query.destination ? [{ name: { contains: query.destination } }] : []),
                ],
              },
            },
          }
        : {}),
    };

    const rows = await this.prisma.route.findMany({
      where,
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        ownerDriver: { include: { user: true, vehicle: true } },
        trips: {
          where: { isDeleted: false },
          include: { segmentInventories: { where: { isDeleted: false } } },
          orderBy: { scheduledAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const mapped = rows
      .map((route) => this.mapAdminListRow(route, now))
      .filter((row) => {
        if (query.status && row.status !== query.status) return false;
        if (query.vehicleKind && !vehicleKindsCompatible(query.vehicleKind, row.vehicleKind)) {
          return false;
        }
        if (query.scheduleType === 'once' && row.scheduleType !== 'once') return false;
        if (
          (query.scheduleType === 'recurring' ||
            query.scheduleType === 'daily' ||
            query.scheduleType === 'weekly') &&
          row.scheduleType === 'once'
        ) {
          return false;
        }
        if (query.date && !row.tripDates.includes(query.date)) return false;
        return true;
      });

    const totalCount = mapped.length;
    const items = mapped.slice(paging.skip, paging.skip + paging.pageSize);
    return new PagedResult(items, paging.page, paging.pageSize, totalCount);
  }

  async adminSummary() {
    const now = utcNow();
    const routes = await this.prisma.route.findMany({
      where: { isDeleted: false, ownerType: RouteOwnerType.Captain },
      include: {
        ownerDriver: true,
        trips: {
          where: {
            isDeleted: false,
            status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
            scheduledAt: { gte: now },
          },
          include: { segmentInventories: { where: { isDeleted: false } } },
          orderBy: { scheduledAt: 'asc' },
          take: 1,
        },
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
      },
    });
    let active = 0;
    let oneTime = 0;
    let recurring = 0;
    let withoutCaptain = 0;
    let withoutVehicle = 0;
    let fullyBooked = 0;
    let availableSeats = 0;
    for (const route of routes) {
      const next = route.trips[0];
      const status = captainRouteLifecycle({
        publishStatus: route.publishStatus,
        isActive: route.isActive,
        nextTripAt: next?.scheduledAt ?? null,
        now,
      });
      if (status === 'active') active += 1;
      if (!route.ownerDriverId) withoutCaptain += 1;
      if (!route.vehicleKind && !route.ownerDriver?.vehicleKind && !route.ownerDriver?.vehicleId) {
        withoutVehicle += 1;
      }
      const kind = next?.recurrenceKind ?? RecurrenceKind.Once;
      if (isRecurringKind(kind)) recurring += 1;
      else oneTime += 1;
      if (next) {
        const remaining = remainingForRange(
          next.segmentInventories,
          stopsMin(route.stops),
          stopsMax(route.stops),
        );
        availableSeats += Math.max(0, remaining);
        if (remaining <= 0) fullyBooked += 1;
      }
    }
    const upcomingCaptainTrips = await this.prisma.trip.count({
      where: {
        isDeleted: false,
        scheduledAt: { gte: now },
        status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned, TripStatus.InProgress] },
        route: { isDeleted: false, ownerType: RouteOwnerType.Captain },
      },
    });
    return {
      activeCaptainRoutes: active,
      oneTimeRoutes: oneTime,
      recurringRoutes: recurring,
      routesWithoutCaptain: withoutCaptain,
      routesWithoutVehicle: withoutVehicle,
      upcomingCaptainTrips,
      fullyBookedRoutes: fullyBooked,
      availableSeats,
    };
  }

  async adminGet(id: string) {
    const route = await this.requireCaptainRoute(id);
    const now = utcNow();
    const driver = route.ownerDriver;
    const stops = route.stops.filter((s) => !s.isDeleted).sort((a, b) => a.order - b.order);
    const trips = route.trips.map((trip) => {
      const remaining = remainingForRange(
        trip.segmentInventories,
        stopsMin(stops),
        stopsMax(stops),
      );
      const reserved = Math.max(0, (trip.segmentInventories[0]?.capacity ?? trip.availableSeats) - remaining);
      return {
        id: trip.id,
        captainRouteId: route.id,
        routeId: route.id,
        driverId: trip.driverId,
        status: trip.status,
        scheduledAt: trip.scheduledAt,
        startedAt: trip.startedAt,
        completedAt: trip.completedAt,
        pricePerSeat: money(trip.pricePerSeat),
        availableSeats: remaining,
        reservedSeats: reserved,
        capacity: trip.segmentInventories[0]?.capacity ?? route.capacity ?? trip.availableSeats,
        vehicleKind: route.vehicleKind,
        recurrenceKind: trip.recurrenceKind,
        recurrenceDaysOfWeek: trip.recurrenceDaysOfWeek,
        parentTripId: trip.parentTripId,
        bucket: tripTimeBucket(trip, now),
      };
    });
    const nextTrip = trips.find((t) => t.bucket === 'upcoming') ?? trips.find((t) => t.bucket === 'current');
    return {
      route: {
        id: route.id,
        name: route.name,
        description: route.description,
        origin: stops[0]?.name ?? null,
        destination: stops[stops.length - 1]?.name ?? null,
        stops: stops.map((stop) => ({
          id: stop.id,
          name: stop.name,
          latitude: stop.latitude,
          longitude: stop.longitude,
          order: stop.order,
        })),
        vehicleKind: route.vehicleKind,
        capacity: route.capacity,
        publishStatus: route.publishStatus,
        isActive: route.isActive,
        status: captainRouteLifecycle({
          publishStatus: route.publishStatus,
          isActive: route.isActive,
          nextTripAt: nextTrip?.scheduledAt ?? null,
          now,
        }),
        shareToken: route.shareToken,
        createdAt: route.createdAt,
      },
      captain: driver
        ? {
            id: driver.id,
            name: driver.user.fullName,
            phone: driver.user.phone,
            photoUrl: driver.user.avatarUrl,
            isActive: driver.isActive,
            isOnline: driver.isOnline,
            vehicleKind: captainVehicleKind(driver),
            plateNumber: driver.plateNumber ?? driver.vehicle?.plateNumber ?? null,
            seats: driver.seats ?? driver.vehicle?.capacity ?? null,
          }
        : null,
      vehicle: {
        id: driver?.vehicleId ?? null,
        type: route.vehicleKind ?? captainVehicleKind(driver),
        plateNumber: driver?.plateNumber ?? driver?.vehicle?.plateNumber ?? null,
        capacity: route.capacity ?? driver?.seats ?? driver?.vehicle?.capacity ?? null,
        model: driver?.vehicleModelName ?? driver?.vehicle?.model ?? null,
      },
      pricing: {
        pricePerSeat: nextTrip?.pricePerSeat ?? null,
        basis: 'trip.pricePerSeat',
      },
      schedule: {
        type: scheduleLabel(nextTrip?.recurrenceKind),
        departureTime: nextTrip?.scheduledAt ?? null,
        operatingDays: nextTrip?.recurrenceDaysOfWeek ?? null,
        startDate: route.trips[0]?.recurrenceStartDate ?? null,
        endDate: route.trips[0]?.recurrenceEndDate ?? null,
      },
      availability: {
        capacity: route.capacity,
        reserved: nextTrip?.reservedSeats ?? 0,
        available: nextTrip?.availableSeats ?? 0,
      },
      trips: {
        current: trips.filter((t) => t.bucket === 'current'),
        upcoming: trips.filter((t) => t.bucket === 'upcoming'),
        past: trips.filter((t) => t.bucket === 'past'),
      },
    };
  }

  async adminCreate(body: {
    driverId: string;
    name?: string;
    description?: string;
    vehicleKind?: string;
    capacity?: number;
    stops: StopInput[];
    publish?: boolean;
    pricePerSeat?: number;
    scheduledAt?: string;
    scheduleType?: string;
    recurrenceKind?: string;
    daysOfWeek?: number[] | string;
    rangeStart?: string;
    rangeEnd?: string;
  }) {
    const driver = await this.requireDriverById(body.driverId);
    const created = await this.createRouteForDriver(driver, body);
    this.logger.log({ event: 'CaptainRouteCreated', routeId: created.id, driverId: driver.id, source: 'admin' });
    if (body.publish) {
      await this.setLifecycle(created.id, 'publish');
    }
    if (body.scheduledAt != null && body.pricePerSeat != null) {
      await this.createTripsForDriver(driver, {
        routeId: created.id,
        scheduledAt: body.scheduledAt,
        pricePerSeat: body.pricePerSeat,
        scheduleType: body.scheduleType,
        recurrenceKind: body.recurrenceKind,
        daysOfWeek: body.daysOfWeek,
        rangeStart: body.rangeStart,
        rangeEnd: body.rangeEnd,
      });
    }
    return this.adminGet(created.id);
  }

  async adminUpdate(
    id: string,
    body: {
      driverId?: string;
      name?: string;
      description?: string;
      vehicleKind?: string;
      capacity?: number;
      stops?: StopInput[];
    },
  ) {
    const route = await this.requireCaptainRoute(id);
    if (body.stops || body.vehicleKind !== undefined || body.capacity !== undefined) {
      await this.assertNoActiveBookings(route.id);
    }
    const nextDriver =
      body.driverId && body.driverId !== route.ownerDriverId
        ? await this.requireDriverById(body.driverId)
        : null;
    if (nextDriver) {
      this.logger.log({
        event: 'CaptainChanged',
        routeId: route.id,
        from: route.ownerDriverId,
        to: nextDriver.id,
      });
    }
    if (body.vehicleKind && body.vehicleKind !== route.vehicleKind) {
      this.logger.log({
        event: 'VehicleChanged',
        routeId: route.id,
        from: route.vehicleKind,
        to: body.vehicleKind,
      });
    }
    const driver = nextDriver ?? route.ownerDriver;
    if (!driver) {
      throw new AppException('الكابتن غير موجود', 400, ErrorCodes.DriverNotFound);
    }
    await this.updateRoute(
      route.id,
      {
        name: body.name,
        description: body.description,
        vehicleKind: body.vehicleKind,
        capacity: body.capacity,
        stops: body.stops,
      },
      driver,
    );
    if (nextDriver) {
      await this.prisma.route.update({
        where: { id: route.id },
        data: { ownerDriverId: nextDriver.id, updatedAt: utcNow() },
      });
      await this.prisma.trip.updateMany({
        where: {
          routeId: route.id,
          isDeleted: false,
          status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
        },
        data: { driverId: nextDriver.id, updatedAt: utcNow() },
      });
    }
    this.logger.log({ event: 'CaptainRouteUpdated', routeId: route.id });
    return this.adminGet(id);
  }

  async setLifecycle(id: string, action: 'publish' | 'pause' | 'archive' | 'draft') {
    const route = await this.requireCaptainRoute(id);
    const next =
      action === 'publish'
        ? { publishStatus: RoutePublishStatus.Published, isActive: true }
        : action === 'pause'
          ? { publishStatus: RoutePublishStatus.Published, isActive: false }
          : action === 'draft'
            ? { publishStatus: RoutePublishStatus.Draft, isActive: false }
            : { publishStatus: RoutePublishStatus.Archived, isActive: false };
    if (action === 'publish') {
      const stops = route.stops.filter((s) => !s.isDeleted);
      if (stops.length < 2) {
        throw new AppException(
          'لا يمكن النشر قبل إضافة محطتين على الأقل',
          400,
          ErrorCodes.RouteNotPublishable,
        );
      }
    }
    await this.prisma.route.update({
      where: { id: route.id },
      data: {
        ...next,
        shareToken: route.shareToken ?? this.newShareToken(),
        updatedAt: utcNow(),
      },
    });
    const event =
      action === 'publish'
        ? 'CaptainRouteActivated'
        : action === 'pause'
          ? 'CaptainRoutePaused'
          : action === 'archive'
            ? 'CaptainRouteCancelled'
            : 'CaptainRouteUpdated';
    this.logger.log({ event, routeId: route.id });
    if (action === 'publish') {
      await this.notifyMatchingDemand(route);
    }
    return this.adminGet(id);
  }

  async adminCreateTrips(id: string, body: Omit<CreateTripsBody, 'routeId'>) {
    const route = await this.requireCaptainRoute(id);
    if (!route.ownerDriver) {
      throw new AppException('المسار بدون كابتن', 400, ErrorCodes.DriverNotFound);
    }
    const result = await this.createTripsForDriver(route.ownerDriver, {
      ...body,
      routeId: id,
    });
    this.logger.log({
      event: 'ScheduleChanged',
      routeId: id,
      count: result.count,
    });
    return result;
  }

  async routesForDriver(driverId: string) {
    const now = utcNow();
    const routes = await this.prisma.route.findMany({
      where: {
        ownerDriverId: driverId,
        ownerType: RouteOwnerType.Captain,
        isDeleted: false,
      },
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        trips: {
          where: { isDeleted: false },
          orderBy: { scheduledAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return routes.map((route) => {
      const nextTrip = route.trips.find(
        (t) =>
          t.scheduledAt >= now &&
          (t.status === TripStatus.Scheduled ||
            t.status === TripStatus.DriverAssigned ||
            t.status === TripStatus.InProgress),
      );
      return {
        id: route.id,
        name: route.name,
        vehicleKind: route.vehicleKind,
        capacity: route.capacity,
        status: captainRouteLifecycle({
          publishStatus: route.publishStatus,
          isActive: route.isActive,
          nextTripAt: nextTrip?.scheduledAt ?? null,
          now,
        }),
        origin: route.stops[0]?.name ?? null,
        destination: route.stops[route.stops.length - 1]?.name ?? null,
        nextTripAt: nextTrip?.scheduledAt ?? null,
        upcomingCount: route.trips.filter(
          (t) => t.scheduledAt >= now && t.status !== TripStatus.Cancelled && t.status !== TripStatus.Completed,
        ).length,
        currentCount: route.trips.filter((t) => tripTimeBucket(t, now) === 'current').length,
        pastCount: route.trips.filter((t) => tripTimeBucket(t, now) === 'past').length,
      };
    });
  }

  private mapAdminListRow(
    route: Awaited<ReturnType<CaptainRoutesService['requireCaptainRoute']>>,
    now: Date,
  ) {
    const stops = route.stops.filter((s) => !s.isDeleted).sort((a, b) => a.order - b.order);
    const upcoming = route.trips.filter(
      (t) =>
        t.scheduledAt >= now &&
        (t.status === TripStatus.Scheduled || t.status === TripStatus.DriverAssigned),
    );
    const nextTrip = upcoming[0] ?? null;
    const remaining = nextTrip
      ? remainingForRange(nextTrip.segmentInventories, stopsMin(stops), stopsMax(stops))
      : 0;
    const capacity = nextTrip?.segmentInventories[0]?.capacity ?? route.capacity ?? 0;
    const driver = route.ownerDriver;
    const recurrenceKind = nextTrip?.recurrenceKind ?? route.trips[0]?.recurrenceKind ?? RecurrenceKind.Once;
    return {
      id: route.id,
      name: route.name,
      origin: stops[0]?.name ?? null,
      destination: stops[stops.length - 1]?.name ?? null,
      captain: driver
        ? {
            id: driver.id,
            name: driver.user.fullName,
            phone: driver.user.phone,
            photoUrl: driver.user.avatarUrl,
            isActive: driver.isActive,
          }
        : null,
      vehicleKind: route.vehicleKind ?? captainVehicleKind(driver),
      vehicle: {
        plateNumber: driver?.plateNumber ?? driver?.vehicle?.plateNumber ?? null,
        type: route.vehicleKind ?? captainVehicleKind(driver),
        capacity,
      },
      capacity,
      pricePerSeat: nextTrip ? money(nextTrip.pricePerSeat) : null,
      scheduleType: isRecurringKind(recurrenceKind) ? 'recurring' : 'once',
      recurrenceKind,
      recurrenceDaysOfWeek: nextTrip?.recurrenceDaysOfWeek ?? route.trips[0]?.recurrenceDaysOfWeek ?? null,
      nextTripAt: nextTrip?.scheduledAt ?? null,
      availableSeats: remaining,
      reservedSeats: Math.max(0, capacity - remaining),
      status: captainRouteLifecycle({
        publishStatus: route.publishStatus,
        isActive: route.isActive,
        nextTripAt: nextTrip?.scheduledAt ?? null,
        now,
      }),
      tripDates: route.trips.map((t) => cairoDateKey(t.scheduledAt)),
      createdAt: route.createdAt,
    };
  }

  private async requireCaptainRoute(id: string) {
    const route = await this.prisma.route.findFirst({
      where: { id, ownerType: RouteOwnerType.Captain, isDeleted: false },
      include: {
        stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
        ownerDriver: { include: { user: true, vehicle: true } },
        trips: {
          where: { isDeleted: false },
          include: {
            segmentInventories: { where: { isDeleted: false } },
          },
          orderBy: { scheduledAt: 'asc' },
        },
      },
    });
    if (!route) {
      throw new NotFoundException('مسار الكابتن غير موجود', ErrorCodes.RouteNotFound);
    }
    return route;
  }

  private async requireDriverById(id: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id, isDeleted: false },
      include: { user: true, vehicle: true },
    });
    if (!driver || !driver.isActive) {
      throw new AppException(
        'حساب الكابتن غير موجود أو غير نشط',
        400,
        ErrorCodes.DriverNotEligible,
      );
    }
    return driver;
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
    driver: DriverCapacitySource,
    vehicleKind?: string | null,
  ): number {
    const fallback = defaultCapacityForVehicleKind(vehicleKind ?? driver.vehicleKind);
    const value = requested ?? driver.seats ?? driver.vehicle?.capacity ?? fallback;
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

function cairoDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function scheduleLabel(kind?: number | null): 'once' | 'weekly' | 'range' {
  if (kind === RecurrenceKind.Weekly) return 'weekly';
  if (kind === RecurrenceKind.DateRange) return 'range';
  return 'once';
}
