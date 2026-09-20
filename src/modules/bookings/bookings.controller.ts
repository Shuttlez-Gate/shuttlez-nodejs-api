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
    };
    const offers: PreviewOffer[] = platformTrips.map((t) =>
      platformOffer(t, sourceAddress, destinationAddress),
    );

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
          pickupWalkLabel: '5 دقائق مشي',
          pickupAddress: sourceAddress ?? match.origin.name,
          pickupTime: formatHm(trip.scheduledAt),
          dropoffAddress: destinationAddress ?? match.destination.name,
          dropoffTime: formatHm(new Date(trip.scheduledAt.getTime() + 45 * 60000)),
          dropoffWalkLabel: '5 دقائق مشي',
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
          sourceType: 'captain',
          scheduledAt: trip.scheduledAt,
        });
      }
    }

    const days = nextSevenDays(now);
    const offersPerDay = days.map((day) =>
      offers
        .filter((offer) => sameDay(offer.scheduledAt, day))
        .map(({ scheduledAt: _scheduledAt, ...offer }) => offer),
    );

    return ApiResponse.ok({
      sourceAddress: sourceAddress ?? '',
      destinationAddress: destinationAddress ?? '',
      dateChips: days.map((d, i) => ({
        dayName: d.toLocaleDateString('ar-EG', { weekday: 'short' }),
        shortDate: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'numeric' }),
        isSelected: i === 0,
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
      include: { trip: { include: { route: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const upcomingStatuses = [
      TripStatus.Scheduled,
      TripStatus.DriverAssigned,
      TripStatus.InProgress,
    ];
    return ApiResponse.ok({
      upcoming: bookings.filter((b) => upcomingStatuses.includes(b.trip.status as 1 | 2 | 3)),
      past: bookings.filter(
        (b) =>
          b.trip.status === TripStatus.Completed ||
          b.trip.status === TripStatus.Cancelled,
      ),
    });
  }

  @Get(':id')
  async details(@Param('id') id: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, isDeleted: false },
      include: { route: { include: { stops: { where: { isDeleted: false } } } }, bookings: true },
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
      include: { invoice: true, trip: true },
    });
    if (!booking?.invoice) {
      throw new NotFoundException('الفاتورة غير موجودة');
    }
    return ApiResponse.ok({
      bookingId: booking.id,
      amount: money(booking.invoice.amount),
      status: invoiceStatusLabel(booking.invoice.status),
      paidAt: booking.invoice.paidAt,
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

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function optionalCoord(raw?: string): number | null {
  if (raw == null || raw === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function nextSevenDays(now: Date): Date[] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function platformOffer(
  trip: {
    id: string;
    scheduledAt: Date;
    referenceCode: string | null;
    availableSeats: number;
    pricePerSeat: Prisma.Decimal;
    route: { name: string; description: string | null };
  },
  sourceAddress?: string,
  destinationAddress?: string,
) {
  return {
    id: trip.id,
    pickupWalkLabel: '5 دقائق مشي',
    pickupAddress: sourceAddress ?? trip.route.name,
    pickupTime: formatHm(trip.scheduledAt),
    dropoffAddress: destinationAddress ?? trip.route.description ?? trip.route.name,
    dropoffTime: formatHm(new Date(trip.scheduledAt.getTime() + 45 * 60000)),
    dropoffWalkLabel: '5 دقائق مشي',
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
