import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ApiResponse } from '../../common/api-response';
import { CurrentUserService } from '../../common/current-user.service';
import {
  AppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import {
  BookingStatus,
  PaymentStatus,
  RouteOwnerType,
  RoutePublishStatus,
  TripStatus,
} from '../../common/enums';
import { PrismaService } from '../../database/prisma/prisma.service';
import { baseFields } from '../../common/utils/entity-defaults';
import { addDays, newId, utcNow } from '../../common/utils/date.util';
import {
  calculateTotal,
  money,
  refCode,
  requireCash,
  splitEarnings,
} from '../../common/utils/money';
import { bookingStatusLabel, invoiceStatusLabel } from '../../common/utils/enums-map';
import { FareService } from '../pricing/fare.service';
import { SegmentInventoryService } from '../marketplace/segment-inventory.service';
import { PushNotificationService } from '../marketplace/push-notification.service';
import {
  matchOriginDestination,
  remainingForRange,
  segmentPrice,
} from '../marketplace/segment-occupancy';

@ApiTags('bookings')
@Controller('api/v1/bookings')
export class BookingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly fare: FareService,
    private readonly segments: SegmentInventoryService,
    private readonly push: PushNotificationService,
  ) {}

  @Get('preview')
  async preview(
    @Query('sourceLatitude') sourceLatitude?: string,
    @Query('sourceLongitude') sourceLongitude?: string,
    @Query('destinationLatitude') destinationLatitude?: string,
    @Query('destinationLongitude') destinationLongitude?: string,
    @Query('sourceAddress') sourceAddress?: string,
    @Query('destinationAddress') destinationAddress?: string,
    @Query('vehicleTypeIndex') vehicleTypeIndex?: string,
  ) {
    const now = utcNow();
    const until = addDays(now, 7);

    const originLat = optionalCoord(sourceLatitude);
    const originLng = optionalCoord(sourceLongitude);
    const destLat = optionalCoord(destinationLatitude);
    const destLng = optionalCoord(destinationLongitude);
    const hasCoords =
      originLat != null && originLng != null && destLat != null && destLng != null;

    const platformTrips = await this.prisma.trip.findMany({
      where: {
        isDeleted: false,
        availableSeats: { gt: 0 },
        status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
        scheduledAt: { gte: now, lte: until },
        route: {
          isDeleted: false,
          ownerType: RouteOwnerType.Platform,
        },
      },
      include: { route: { include: { stops: { where: { isDeleted: false } } } } },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
    });

    const captainTrips = hasCoords
      ? await this.prisma.trip.findMany({
          where: {
            isDeleted: false,
            status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
            scheduledAt: { gte: now, lte: until },
            route: {
              isDeleted: false,
              isActive: true,
              ownerType: RouteOwnerType.Captain,
              publishStatus: RoutePublishStatus.Published,
            },
          },
          include: {
            route: {
              include: {
                stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
              },
            },
            driver: true,
            segmentInventories: { where: { isDeleted: false } },
          },
          orderBy: { scheduledAt: 'asc' },
          take: 80,
        })
      : [];

    type PreviewOffer = ReturnType<typeof platformOffer> & {
      originStopId?: string;
      destinationStopId?: string;
      sourceType?: string;
      scheduledAt: Date;
      vehicleBucket: 'carshuttle' | 'minibus' | 'bus';
    };
    const offers: PreviewOffer[] = [];
    for (const trip of platformTrips) {
      const stops = trip.route.stops ?? [];
      if (hasCoords) {
        const match = matchOriginDestination(
          stops,
          originLat,
          originLng,
          destLat,
          destLng,
        );
        if (!match) {
          continue;
        }
        const firstOrder = stops[0]?.order ?? 0;
        const lastOrder = stops[stops.length - 1]?.order ?? firstOrder;
        offers.push({
          ...platformOffer(trip, match.origin.name, match.destination.name),
          pricePerSeat: segmentPrice(
            money(trip.pricePerSeat),
            match.origin.order,
            match.destination.order,
            firstOrder,
            lastOrder,
          ),
          originStopId: match.origin.id,
          destinationStopId: match.destination.id,
          vehicleBucket: classifyVehicle(
            trip.route.vehicleKind,
            trip.route.capacity,
            trip.availableSeats,
          ),
        });
        continue;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      offers.push({
        ...platformOffer(
          trip,
          first?.name ?? sourceAddress,
          last && last.id !== first?.id ? last.name : destinationAddress,
        ),
        originStopId: first?.id,
        destinationStopId: last && last.id !== first?.id ? last.id : undefined,
        vehicleBucket: classifyVehicle(
          trip.route.vehicleKind,
          trip.route.capacity,
          trip.availableSeats,
        ),
      });
    }

    if (hasCoords) {
      for (const trip of captainTrips) {
        const match = matchOriginDestination(
          trip.route.stops,
          originLat,
          originLng,
          destLat,
          destLng,
        );
        if (!match) {
          continue;
        }
        const remaining = remainingForRange(
          trip.segmentInventories,
          match.origin.order,
          match.destination.order,
        );
        if (remaining < 1) {
          continue;
        }
        const firstOrder = trip.route.stops[0]?.order ?? 0;
        const lastOrder = trip.route.stops[trip.route.stops.length - 1]?.order ?? firstOrder;
        const price = segmentPrice(
          money(trip.pricePerSeat),
          match.origin.order,
          match.destination.order,
          firstOrder,
          lastOrder,
        );
        offers.push({
          id: trip.id,
          pickupWalkLabel: '',
          pickupAddress: sourceAddress ?? match.origin.name,
          pickupTime: formatHm(trip.scheduledAt),
          dropoffAddress: destinationAddress ?? match.destination.name,
          dropoffTime: formatHm(
            new Date(
              trip.scheduledAt.getTime() +
                resolveDurationSeconds(trip.route.durationSeconds) * 1000,
            ),
          ),
          dropoffWalkLabel: '',
          plateLabel: trip.referenceCode ?? '',
          badgeVariant: 'captain',
          crossedPrice: '',
          packageLabel: '',
          packageLabelArgb: 0,
          seatsLabel: `${remaining} مقاعد`,
          seatsArgb: 0,
          seatsStrikethrough: false,
          cardDimmed: false,
          pricePerSeat: price,
          availableSeats: remaining,
          originStopId: match.origin.id,
          destinationStopId: match.destination.id,
          vehicleBucket: classifyVehicle(
            trip.route.vehicleKind ?? trip.driver?.vehicleKind,
            trip.route.capacity ?? trip.driver?.seats,
            remaining,
          ),
          sourceType: 'captain',
          scheduledAt: trip.scheduledAt,
        });
      }
    }

    const requestedVehicle = previewVehicleBucket(vehicleTypeIndex);
    const matchedOffers = requestedVehicle
      ? offers.filter((offer) => offer.vehicleBucket === requestedVehicle)
      : offers;
    // Calendar days from Cairo "today" forward (never past local days).
    const days = nextSevenCairoDays(now);
    const offersPerDay = days.map((day) =>
      matchedOffers
        .filter((offer) => sameCairoDay(offer.scheduledAt, day))
        .map(({ scheduledAt: _scheduledAt, vehicleBucket, ...offer }) => ({
          ...offer,
          vehicleKind: vehicleBucket,
        })),
    );

    const firstWithOffers = offersPerDay.findIndex((day) => day.length > 0);
    return ApiResponse.ok({
      sourceAddress: sourceAddress ?? '',
      destinationAddress: destinationAddress ?? '',
      dateChips: days.map((d, i) => ({
        dayName: weekdayNameAr(d),
        shortDate: ddMmUtc(d),
        isSelected: i === (firstWithOffers >= 0 ? firstWithOffers : 0),
      })),
      offersPerDay,
    });
  }

  @Post()
  @ApiBearerAuth()
  async create(
    @Body()
    body: {
      tripId: string;
      seatCount?: number;
      paymentMethod?: string;
      originStopId?: string;
      destinationStopId?: string;
      vehicleKind?: string;
    },
  ) {
    const userId = this.currentUser.requireUserId();
    const seatCount = body.seatCount ?? 1;
    if (seatCount < 1) {
      throw new AppException('عدد المقاعد غير صالح', 400, ErrorCodes.InvalidSeatCount);
    }
    const paymentMethod = requireCash(body.paymentMethod);
    const trip = await this.prisma.trip.findFirst({
      where: { id: body.tripId, isDeleted: false },
      include: {
        route: {
          include: { stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } } },
        },
        driver: true,
      },
    });
    if (!trip) {
      throw new NotFoundException('الرحلة غير موجودة', ErrorCodes.TripNotFound);
    }
    if (
      trip.status !== TripStatus.Scheduled &&
      trip.status !== TripStatus.DriverAssigned
    ) {
      throw new AppException('الرحلة غير متاحة للحجز', 400, ErrorCodes.TripNotBookable);
    }
    const existing = await this.prisma.booking.findFirst({
      where: {
        tripId: trip.id,
        userId,
        isDeleted: false,
        status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
      },
    });
    if (existing) {
      throw new AppException('لديك حجز على هذه الرحلة بالفعل', 400, ErrorCodes.DuplicateBooking);
    }
    if (await this.hasOverlappingBooking(userId, trip.id, trip.scheduledAt, trip.route.durationSeconds)) {
      throw new AppException(
        'لديك رحلة محجوزة في هذا الوقت',
        409,
        ErrorCodes.TripTimeConflict,
      );
    }

    const isCaptain = trip.route.ownerType === RouteOwnerType.Captain;
    const origin = body.originStopId
      ? trip.route.stops.find((s) => s.id === body.originStopId)
      : undefined;
    const destination = body.destinationStopId
      ? trip.route.stops.find((s) => s.id === body.destinationStopId)
      : undefined;
    if (isCaptain) {
      if (!origin || !destination || destination.order <= origin.order) {
        throw new AppException(
          'اختر محطة صعود ونزول صالحتين على المسار',
          400,
          ErrorCodes.InvalidStops,
        );
      }
    }

    const firstOrder = trip.route.stops[0]?.order ?? 0;
    const lastOrder =
      trip.route.stops[trip.route.stops.length - 1]?.order ?? firstOrder;
    const pricePerSeat = isCaptain && origin && destination
      ? segmentPrice(
          money(trip.pricePerSeat),
          origin.order,
          destination.order,
          firstOrder,
          lastOrder,
        )
      : money(trip.pricePerSeat);
    const totalAmount = calculateTotal(pricePerSeat, seatCount);
    const commissionPercent = await this.fare.platformCommissionPercent(trip.routeId);
    const split = splitEarnings(totalAmount, commissionPercent);
    const bookingId = newId();
    const referenceCode = refCode('BK');

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${trip.id}))`;
      if (isCaptain && origin && destination) {
        await this.segments.tryDecrementRange(
          tx,
          trip.id,
          origin.order,
          destination.order,
          seatCount,
        );
        await this.segments.syncTripAvailableSeats(tx, trip.id);
      } else {
        const taken = await tx.$executeRaw`
          UPDATE "TripsSet"
          SET "AvailableSeats" = "AvailableSeats" - ${seatCount},
              "UpdatedAt" = NOW()
          WHERE "Id" = ${trip.id}::uuid
            AND "IsDeleted" = false
            AND "AvailableSeats" >= ${seatCount}
            AND "Status" IN (1, 2)`;
        if (Number(taken) === 0) {
          throw new AppException('لا توجد مقاعد كافية', 400, ErrorCodes.SeatUnavailable);
        }
      }
      await tx.booking.create({
        data: {
          id: bookingId,
          tripId: trip.id,
          userId,
          status: BookingStatus.Confirmed,
          seatCount,
          totalAmount: new Prisma.Decimal(totalAmount),
          paymentMethod,
          referenceCode,
          captainEarnings: new Prisma.Decimal(split.captainEarnings),
          commissionAmount: new Prisma.Decimal(split.commissionAmount),
          commissionRate: new Prisma.Decimal(split.commissionRate),
          pricePerSeat: new Prisma.Decimal(pricePerSeat),
          usesSubscriptionCredit: paymentMethod === 'subscription',
          originStopId: origin?.id ?? null,
          destinationStopId: destination?.id ?? null,
          vehicleKind: body.vehicleKind?.trim().slice(0, 40) || null,
          ...baseFields(),
        },
      });
      await tx.invoice.create({
        data: {
          id: newId(),
          bookingId,
          amount: new Prisma.Decimal(totalAmount),
          status: PaymentStatus.Pending,
          ...baseFields(),
        },
      });
    });

    if (!isCaptain) {
      await this.prisma.markTripFullIfNeeded(trip.id);
    }
    if (trip.driver?.userId) {
      await this.push.notifyUser(
        trip.driver.userId,
        'حجز جديد',
        `تم تأكيد حجز ${seatCount} مقعد`,
        'booking_confirmed',
        { tripId: trip.id, bookingId },
      );
    }

    return ApiResponse.ok(
      {
        bookingId,
        tripId: trip.id,
        referenceCode,
        totalAmount,
        status: bookingStatusLabel(BookingStatus.Confirmed),
        message: 'تم تأكيد الحجز — الدفع نقدًا للكابتن',
        pricePerSeat,
        seatCount,
        paymentMethod,
        originStopId: origin?.id ?? null,
        destinationStopId: destination?.id ?? null,
      },
      'تم تأكيد الحجز — الدفع نقدًا للكابتن',
    );
  }

  private async hasOverlappingBooking(
    userId: string,
    tripId: string,
    scheduledAt: Date,
    durationSeconds: number | null,
  ) {
    const start = scheduledAt.getTime();
    const end = start + (durationSeconds && durationSeconds > 0 ? durationSeconds : 3600) * 1000;
    const others = await this.prisma.booking.findMany({
      where: {
        userId,
        isDeleted: false,
        tripId: { not: tripId },
        status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
        trip: {
          isDeleted: false,
          status: {
            in: [TripStatus.Scheduled, TripStatus.DriverAssigned, TripStatus.InProgress],
          },
        },
      },
      select: {
        trip: {
          select: {
            scheduledAt: true,
            route: { select: { durationSeconds: true } },
          },
        },
      },
    });
    return others.some((booking) => {
      const otherStart = booking.trip.scheduledAt.getTime();
      const otherDuration = booking.trip.route.durationSeconds;
      const otherEnd =
        otherStart + (otherDuration && otherDuration > 0 ? otherDuration : 3600) * 1000;
      return start < otherEnd && otherStart < end;
    });
  }
}

@ApiTags('trips')
@Controller('api/v1/trips')
export class TripsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly segments: SegmentInventoryService,
  ) {}

  @Get('me')
  async me() {
    const userId = this.currentUser.requireUserId();
    const bookings = await this.prisma.booking.findMany({
      where: { userId, isDeleted: false },
      include: {
        originStop: true,
        destinationStop: true,
        trip: { include: { route: true, driver: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const upcomingStatuses = new Set([
      TripStatus.Scheduled,
      TripStatus.DriverAssigned,
      TripStatus.InProgress,
    ]);
    // JSON-safe DTOs (Prisma Decimal / null trip must not break history).
    const mapped = bookings
      .filter((b) => b.trip != null)
      .map((b) => ({
        id: b.id,
        tripId: b.tripId,
        status: b.status,
        seatCount: b.seatCount,
        referenceCode: b.referenceCode,
        vehicleKind: b.vehicleKind,
        totalAmount: money(b.totalAmount),
        createdAt: b.createdAt,
        originStop: b.originStop
          ? {
              id: b.originStop.id,
              name: b.originStop.name,
              latitude: b.originStop.latitude,
              longitude: b.originStop.longitude,
              order: b.originStop.order,
            }
          : null,
        destinationStop: b.destinationStop
          ? {
              id: b.destinationStop.id,
              name: b.destinationStop.name,
              latitude: b.destinationStop.latitude,
              longitude: b.destinationStop.longitude,
              order: b.destinationStop.order,
            }
          : null,
        trip: {
          id: b.trip.id,
          status: b.trip.status,
          scheduledAt: b.trip.scheduledAt,
          referenceCode: b.trip.referenceCode,
          availableSeats: b.trip.availableSeats,
          pricePerSeat: money(b.trip.pricePerSeat),
          route: b.trip.route
            ? {
                id: b.trip.route.id,
                name: b.trip.route.name,
                description: b.trip.route.description,
                capacity: b.trip.route.capacity,
                vehicleKind: b.trip.route.vehicleKind,
                startLatitude: b.trip.route.startLatitude,
                startLongitude: b.trip.route.startLongitude,
                endLatitude: b.trip.route.endLatitude,
                endLongitude: b.trip.route.endLongitude,
                durationSeconds: b.trip.route.durationSeconds,
              }
            : null,
          driver: b.trip.driver
            ? {
                id: b.trip.driver.id,
                vehicleKind: b.trip.driver.vehicleKind,
                seats: b.trip.driver.seats,
              }
            : null,
        },
      }));
    return ApiResponse.ok({
      upcoming: mapped.filter(
        (b) =>
          b.status !== BookingStatus.Cancelled &&
          upcomingStatuses.has(b.trip.status as 1 | 2 | 3),
      ),
      past: mapped.filter(
        (b) =>
          b.status === BookingStatus.Cancelled ||
          b.trip.status === TripStatus.Completed ||
          b.trip.status === TripStatus.Cancelled,
      ),
    });
  }

  @Get(':id')
  async details(@Param('id') id: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, isDeleted: false },
      include: {
        route: { include: { stops: { where: { isDeleted: false } } } },
        bookings: { include: { originStop: true, destinationStop: true } },
        driver: {
          include: {
            user: { select: { fullName: true, avatarUrl: true } },
          },
        },
      },
    });
    if (!trip) {
      throw new NotFoundException('الرحلة غير موجودة');
    }
    return ApiResponse.ok(trip);
  }

  @Get(':id/invoice')
  async invoice(@Param('id') id: string) {
    const userId = this.currentUser.requireUserId();
    const booking = await this.prisma.booking.findFirst({
      where: { tripId: id, userId, isDeleted: false },
      include: { invoice: true, trip: true, user: true },
    });
    if (!booking?.invoice) {
      const ride = await this.prisma.rideRequest.findFirst({
        where: { id, riderUserId: userId, isDeleted: false },
        include: { rider: true },
      });
      if (!ride) {
        throw new NotFoundException('الفاتورة غير موجودة');
      }
      const amount = money(ride.totalAmount);
      const seatFare = money(ride.fareAmount);
      const when = ride.scheduledFor ?? ride.createdAt;
      const reference = ride.referenceCode?.trim() || ride.id.slice(0, 8);
      return ApiResponse.ok({
        bookingId: ride.id,
        amount,
        status: 'cash',
        paidAt: null,
        tripId: reference.startsWith('#') ? reference : `#${reference}`,
        dateTimeLabel: `${when.toLocaleDateString('ar-EG', { weekday: 'long' })} ${formatDate(when)} - ${formatHm(when)} - نقدا`,
        passengerName: ride.rider.fullName?.trim() || '',
        lineItems: buildInvoiceLines({
          total: amount,
          baseFare: money(ride.baseFareApplied ?? 0),
          distanceKm: money(ride.distanceKm ?? 0),
          pricePerKm: money(ride.pricePerKmApplied ?? 0),
          fareAmount: seatFare,
        }),
      });
    }
    const amount = money(booking.invoice.amount);
    const seatFare = money(booking.pricePerSeat) * booking.seatCount;
    const lineItems = buildInvoiceLines({
      total: amount,
      baseFare: 0,
      distanceKm: 0,
      pricePerKm: 0,
      fareAmount: seatFare,
    });
    const when = booking.trip.scheduledAt;
    const reference = booking.referenceCode?.trim() || booking.id.slice(0, 8);
    return ApiResponse.ok({
      bookingId: booking.id,
      amount,
      status: invoiceStatusLabel(booking.invoice.status),
      paidAt: booking.invoice.paidAt,
      tripId: reference.startsWith('#') ? reference : `#${reference}`,
      dateTimeLabel: `${when.toLocaleDateString('ar-EG', { weekday: 'long' })} ${formatDate(when)} - ${formatHm(when)} - نقدا`,
      passengerName: booking.user.fullName?.trim() || '',
      lineItems,
    });
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    const userId = this.currentUser.requireUserId();
    const booking = await this.prisma.booking.findFirst({
      where: { tripId: id, userId, isDeleted: false },
      include: { originStop: true, destinationStop: true },
    });
    if (!booking) {
      throw new NotFoundException('الحجز غير موجود');
    }
    if (booking.status === BookingStatus.Cancelled) {
      return ApiResponse.ok(true);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.tripId}))`;
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.Cancelled, updatedAt: utcNow() },
      });
      if (booking.originStop && booking.destinationStop) {
        await this.segments.tryIncrementRange(
          tx,
          booking.tripId,
          booking.originStop.order,
          booking.destinationStop.order,
          booking.seatCount,
        );
        await this.segments.syncTripAvailableSeats(tx, booking.tripId);
      } else {
        await tx.$executeRaw`
          UPDATE "TripsSet"
          SET "AvailableSeats" = "AvailableSeats" + ${booking.seatCount},
              "UpdatedAt" = NOW()
          WHERE "Id" = ${booking.tripId}::uuid AND "IsDeleted" = false`;
      }
    });
    return ApiResponse.ok(true, 'تم إلغاء الرحلة بنجاح');
  }
}

@ApiTags('subscription-packages')
@Controller('api/v1/subscription-packages')
export class SubscriptionPackagesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get()
  async packages() {
    const items = await this.prisma.subscriptionPackage.findMany({
      where: { isActive: true, isDeleted: false },
      orderBy: { price: 'asc' },
    });
    return ApiResponse.ok(
      items.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: money(p.price),
        tripCount: p.tripCount,
        validityDays: p.validityDays,
      })),
    );
  }

  @Get('me')
  async mine() {
    const userId = this.currentUser.requireUserId();
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
    });
    if (!user?.activeSubscriptionPackageId) {
      return ApiResponse.ok(null);
    }
    const pkg = await this.prisma.subscriptionPackage.findFirst({
      where: { id: user.activeSubscriptionPackageId },
    });
    return ApiResponse.ok({
      packageId: user.activeSubscriptionPackageId,
      packageName: pkg?.name ?? null,
      expiresAt: user.subscriptionExpiresAt,
      activatedAt: user.subscriptionActivatedAt,
    });
  }

  @Post(':id/subscribe')
  async subscribe(@Param('id') id: string) {
    const userId = this.currentUser.requireUserId();
    const pkg = await this.prisma.subscriptionPackage.findFirst({
      where: { id, isActive: true, isDeleted: false },
    });
    if (!pkg) {
      throw new NotFoundException('الباقة غير موجودة');
    }
    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + pkg.validityDays);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        activeSubscriptionPackageId: pkg.id,
        subscriptionActivatedAt: utcNow(),
        subscriptionExpiresAt: expires,
      },
    });
    return ApiResponse.ok({ packageId: pkg.id, expiresAt: expires });
  }
}

function formatHm(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

function buildInvoiceLines(input: {
  total: number;
  baseFare: number;
  distanceKm: number;
  pricePerKm: number;
  fareAmount: number;
}) {
  const lines: Array<{
    title: string;
    value: string;
    isTotal: boolean;
    highlight: boolean;
  }> = [];
  if (input.total > 0) {
    lines.push({
      title: 'المبلغ الاجمالي',
      value: formatMoney(input.total),
      isTotal: true,
      highlight: false,
    });
  }
  const base = input.baseFare > 0 ? input.baseFare : input.fareAmount;
  if (base > 0) {
    lines.push({
      title: 'رسوم الرحلة الأساسية',
      value: formatMoney(base),
      isTotal: false,
      highlight: false,
    });
  }
  if (input.distanceKm > 0 && input.pricePerKm > 0) {
    lines.push({
      title: 'تكلفة المسافة',
      value: formatMoney(
        Math.round(input.distanceKm * input.pricePerKm * 100) / 100,
      ),
      isTotal: false,
      highlight: false,
    });
  }
  return lines;
}

function previewVehicleBucket(
  raw?: string,
): 'carshuttle' | 'minibus' | 'bus' | null {
  const value = raw?.trim().toLowerCase();
  if (value === '0' || value === 'car' || value === 'carshuttle') return 'carshuttle';
  if (value === '1' || value === 'minibus' || value === 'mini') return 'minibus';
  if (value === '2' || value === 'bus') return 'bus';
  return null;
}

function classifyVehicle(
  kind?: string | null,
  capacity?: number | null,
  seatsHint?: number | null,
): 'carshuttle' | 'minibus' | 'bus' {
  // Priority:
  // 1) Route.Capacity / Driver.Seats
  // 2) Route.VehicleKind / Driver.VehicleKind text
  // 3) available/remaining seats hint
  // Buckets: car 1-4, minibus 5-14, bus 15+.
  const seats =
    capacity != null && capacity > 0
      ? capacity
      : seatsHint != null && seatsHint > 0
        ? seatsHint
        : null;

  const text = (kind ?? '').trim().toLowerCase();
  if (
    text.includes('mini') ||
    text.includes('ميني') ||
    text.includes('micro') ||
    text.includes('فان')
  ) {
    return 'minibus';
  }
  if (
    text.includes('bus') ||
    text.includes('coach') ||
    text.includes('باص') ||
    text.includes('اتوب') ||
    text.includes('أتوب')
  ) {
    return 'bus';
  }
  if (
    text.includes('carshuttle') ||
    text.includes('sedan') ||
    ((text.includes('car') || text.includes('سيار') || text.includes('عرب')) &&
      (seats == null || seats <= 4))
  ) {
    return 'carshuttle';
  }

  if (seats != null) {
    if (seats > 14) return 'bus';
    if (seats > 4) return 'minibus';
    return 'carshuttle';
  }

  return 'carshuttle';
}

const CAIRO_TZ = 'Africa/Cairo';

/** YYYY-MM-DD in Africa/Cairo. */
function cairoDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function sameCairoDay(a: Date, b: Date): boolean {
  return cairoDateKey(a) === cairoDateKey(b);
}

/**
 * Next 7 calendar days starting at Cairo local today.
 * Each entry is UTC noon on that Y-M-D so weekday/dd-MM stay stable.
 */
function nextSevenCairoDays(now: Date): Date[] {
  const [y, m, d] = cairoDateKey(now).split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function weekdayNameAr(dayUtcNoon: Date): string {
  return dayUtcNoon.toLocaleDateString('ar-EG', {
    weekday: 'long',
    timeZone: 'UTC',
  });
}

function ddMmUtc(dayUtcNoon: Date): string {
  const dd = String(dayUtcNoon.getUTCDate()).padStart(2, '0');
  const mm = String(dayUtcNoon.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

function optionalCoord(raw?: string): number | null {
  if (raw == null || raw === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function resolveDurationSeconds(durationSeconds: number | null | undefined): number {
  // Same default used by booking overlap checks when DurationSeconds is unset.
  return durationSeconds && durationSeconds > 0 ? durationSeconds : 3600;
}

function platformOffer(
  trip: {
    id: string;
    scheduledAt: Date;
    referenceCode: string | null;
    availableSeats: number;
    pricePerSeat: Prisma.Decimal;
    route: { name: string; description: string | null; durationSeconds: number | null };
  },
  sourceAddress?: string,
  destinationAddress?: string,
) {
  const durationMs = resolveDurationSeconds(trip.route.durationSeconds) * 1000;
  return {
    id: trip.id,
    pickupWalkLabel: '',
    pickupAddress: sourceAddress ?? trip.route.name,
    pickupTime: formatHm(trip.scheduledAt),
    dropoffAddress: destinationAddress ?? trip.route.description ?? trip.route.name,
    dropoffTime: formatHm(new Date(trip.scheduledAt.getTime() + durationMs)),
    dropoffWalkLabel: '',
    plateLabel: trip.referenceCode ?? '',
    badgeVariant: 'shuttle',
    crossedPrice: '',
    packageLabel: '',
    packageLabelArgb: 0,
    seatsLabel: `${trip.availableSeats} مقاعد`,
    seatsArgb: 0,
    seatsStrikethrough: false,
    cardDimmed: false,
    pricePerSeat: money(trip.pricePerSeat),
    availableSeats: trip.availableSeats,
    sourceType: 'platform',
    scheduledAt: trip.scheduledAt,
  };
}
