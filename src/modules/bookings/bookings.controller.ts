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
  TripStatus,
} from '../../common/enums';
import { PrismaService } from '../../database/prisma/prisma.service';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import {
  calculateTotal,
  money,
  refCode,
  requireCash,
  splitEarnings,
} from '../../common/utils/money';
import { bookingStatusLabel, invoiceStatusLabel } from '../../common/utils/enums-map';
import { FareService } from '../pricing/fare.service';

@ApiTags('bookings')
@Controller('api/v1/bookings')
export class BookingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly fare: FareService,
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
    const until = new Date(now.getTime() + 7 * 86400000);
    const trips = await this.prisma.trip.findMany({
      where: {
        isDeleted: false,
        availableSeats: { gt: 0 },
        status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
        scheduledAt: { gte: now, lte: until },
      },
      include: { route: { include: { stops: { where: { isDeleted: false } } } } },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
    });

    const days = uniqueDays(trips.map((t) => t.scheduledAt), now);
    const offersPerDay = days.map((day) =>
      trips
        .filter((t) => sameDay(t.scheduledAt, day))
        .map((t) => ({
          id: t.id,
          pickupWalkLabel: '5 دقائق مشي',
          pickupAddress: sourceAddress ?? t.route.name,
          pickupTime: formatHm(t.scheduledAt),
          dropoffAddress: destinationAddress ?? t.route.description ?? t.route.name,
          dropoffTime: formatHm(new Date(t.scheduledAt.getTime() + 45 * 60000)),
          dropoffWalkLabel: '5 دقائق مشي',
          plateLabel: t.referenceCode ?? '',
          badgeVariant: 'shuttle',
          crossedPrice: '',
          packageLabel: '',
          packageLabelArgb: 0,
          seatsLabel: `${t.availableSeats} مقاعد`,
          seatsArgb: 0,
          seatsStrikethrough: false,
          cardDimmed: false,
          pricePerSeat: money(t.pricePerSeat),
          availableSeats: t.availableSeats,
        })),
    );

    if (trips.length === 0) {
      throw new AppException(
        'لا توجد تسعيرة متاحة لهذه الرحلة حالياً',
        400,
        ErrorCodes.PricingNotAvailable,
      );
    }

    void sourceLatitude;
    void sourceLongitude;
    void destinationLatitude;
    void destinationLongitude;

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
    @Body() body: { tripId: string; seatCount?: number; paymentMethod?: string },
  ) {
    const userId = this.currentUser.requireUserId();
    const seatCount = body.seatCount ?? 1;
    if (seatCount < 1) {
      throw new AppException('عدد المقاعد غير صالح', 400, ErrorCodes.InvalidSeatCount);
    }
    const paymentMethod = requireCash(body.paymentMethod);
    const trip = await this.prisma.trip.findFirst({
      where: { id: body.tripId, isDeleted: false },
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

    const taken = await this.prisma.tryDecrementTripSeats(trip.id, seatCount);
    if (taken === 0) {
      throw new AppException('لا توجد مقاعد كافية', 400, ErrorCodes.SeatUnavailable);
    }

    const pricePerSeat = money(trip.pricePerSeat);
    const totalAmount = calculateTotal(pricePerSeat, seatCount);
    const commissionPercent = await this.fare.platformCommissionPercent(trip.routeId);
    const split = splitEarnings(totalAmount, commissionPercent);
    const bookingId = newId();
    const referenceCode = refCode('BK');

    await this.prisma.$transaction([
      this.prisma.booking.create({
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
          ...baseFields(),
        },
      }),
      this.prisma.invoice.create({
        data: {
          id: newId(),
          bookingId,
          amount: new Prisma.Decimal(totalAmount),
          status: PaymentStatus.Pending,
          ...baseFields(),
        },
      }),
    ]);
    await this.prisma.markTripFullIfNeeded(trip.id);

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
    });
    if (!booking) {
      throw new NotFoundException('الحجز غير موجود');
    }
    if (booking.status === BookingStatus.Cancelled) {
      return ApiResponse.ok(true);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.Cancelled, updatedAt: utcNow() },
      });
      await tx.$executeRaw`
        UPDATE "TripsSet"
        SET "AvailableSeats" = "AvailableSeats" + ${booking.seatCount},
            "UpdatedAt" = NOW()
        WHERE "Id" = ${booking.tripId}::uuid AND "IsDeleted" = false`;
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

function uniqueDays(dates: Date[], fallback: Date): Date[] {
  const map = new Map<string, Date>();
  for (const d of dates) {
    const key = d.toISOString().slice(0, 10);
    if (!map.has(key)) {
      map.set(key, d);
    }
  }
  if (map.size === 0) {
    map.set(fallback.toISOString().slice(0, 10), fallback);
  }
  return [...map.values()];
}
