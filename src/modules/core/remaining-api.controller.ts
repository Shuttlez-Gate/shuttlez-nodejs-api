import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';
import { AppException, NotFoundException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { CurrentUserService } from '../../common/current-user.service';
import { PrismaService } from '../../database/prisma/prisma.service';
import { pageRequestFrom, PagedResult } from '../../common/paged-result';
import { BookingStatus, TripStatus } from '../../common/enums';
import { baseFields } from '../../common/utils/entity-defaults';

/**
 * Remaining public + admin endpoints. Complex booking/ride/demand launch
 * business rules continue to be ported from the .NET handlers; list/read
 * operations talk to the existing Neon tables.
 */
@Controller()
export class RemainingApiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('api/v1/subscription-packages')
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
        price: decimal(p.price),
        tripCount: p.tripCount,
        validityDays: p.validityDays,
      })),
    );
  }

  @Get('api/v1/subscription-packages/me')
  async mySubscription() {
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

  @Post('api/v1/subscription-packages/:id/subscribe')
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
        subscriptionActivatedAt: new Date(),
        subscriptionExpiresAt: expires,
      },
    });
    return ApiResponse.ok({
      packageId: pkg.id,
      expiresAt: expires,
    });
  }

  @Get('api/v1/trips/me')
  async myTrips() {
    const userId = this.currentUser.requireUserId();
    const bookings = await this.prisma.booking.findMany({
      where: { userId, isDeleted: false },
      include: { trip: { include: { route: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return ApiResponse.ok({
      upcoming: bookings.filter((b) =>
        [TripStatus.Scheduled, TripStatus.DriverAssigned, TripStatus.InProgress].includes(
          b.trip.status as 1 | 2 | 3,
        ),
      ),
      past: bookings.filter(
        (b) =>
          b.trip.status === TripStatus.Completed ||
          b.trip.status === TripStatus.Cancelled,
      ),
    });
  }

  @Get('api/v1/trips/:id')
  async tripDetails(@Param('id') id: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, isDeleted: false },
      include: { route: true, bookings: true },
    });
    if (!trip) {
      throw new NotFoundException('الرحلة غير موجودة');
    }
    return ApiResponse.ok(trip);
  }

  @Get('api/v1/trips/:id/invoice')
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
      amount: decimal(booking.invoice.amount),
      status: booking.invoice.status,
      paidAt: booking.invoice.paidAt,
    });
  }

  @Post('api/v1/trips/:id/cancel')
  async cancelTrip(@Param('id') id: string) {
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
        data: { status: BookingStatus.Cancelled, updatedAt: new Date() },
      });
      await tx.$executeRaw`
        UPDATE "TripsSet"
        SET "AvailableSeats" = "AvailableSeats" + ${booking.seatCount},
            "UpdatedAt" = NOW()
        WHERE "Id" = ${booking.tripId}::uuid AND "IsDeleted" = false`;
    });
    return ApiResponse.ok(true);
  }

  @Get('api/v1/bookings/preview')
  preview() {
    throw new AppException(
      'لا توجد تسعيرة متاحة لهذه الرحلة حالياً',
      400,
      ErrorCodes.PricingNotAvailable,
    );
  }

  @Post('api/v1/bookings')
  createBooking() {
    throw new AppException(
      'إنشاء الحجز يحتاج منطق المقاعد والتسعير من .NET BookingHandlers — قيد النقل.',
      501,
      'MIGRATION_IN_PROGRESS',
    );
  }

  @Get('api/v1/rides/quote')
  rideQuote() {
    throw new AppException(
      'تسعيرة الرحلة غير مهيأة',
      400,
      ErrorCodes.RideFareNotConfigured,
    );
  }

  @Get('api/v1/rides/fare-options')
  async rideFareOptions() {
    const rules = await this.prisma.rideFareRule.findMany({
      where: { isActive: true, isDeleted: false },
    });
    return ApiResponse.ok(rules);
  }

  @Post('api/v1/rides')
  createRide() {
    throw new AppException(
      'إنشاء طلب رحلة يحتاج RideHandlers من .NET — قيد النقل.',
      501,
      'MIGRATION_IN_PROGRESS',
    );
  }

  @Get('api/v1/rides/me')
  async myRides() {
    const userId = this.currentUser.requireUserId();
    const items = await this.prisma.rideRequest.findMany({
      where: { riderUserId: userId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
    });
    return ApiResponse.ok(items);
  }

  @Get('api/v1/support/tickets')
  async tickets(@Query('tab') tab = 'current') {
    const userId = this.currentUser.requireUserId();
    const items = await this.prisma.supportTicket.findMany({
      where: {
        userId,
        isDeleted: false,
        status: tab === 'closed' ? 'closed' : { not: 'closed' },
      },
      orderBy: { createdAt: 'desc' },
    });
    return ApiResponse.ok(items);
  }

  @Post('api/v1/support/tickets')
  async createTicket(@Body() body: { subject: string; tripId?: string }) {
    const userId = this.currentUser.requireUserId();
    const ticket = await this.prisma.supportTicket.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        subject: body.subject,
        tripId: body.tripId,
        status: 'open',
        ...baseFields(),
      },
    });
    return ApiResponse.ok({ id: ticket.id, status: ticket.status });
  }

  @Get('api/v1/admin/dashboard')
  @ApiBearerAuth()
  @UseGuards(AdminOnlyGuard)
  async dashboard(@Query('days') days = '30') {
    const windowDays = Number(days) > 0 ? Number(days) : 30;
    const from = new Date(Date.now() - windowDays * 86400000);
    const [users, trips, bookings] = await Promise.all([
      this.prisma.user.count({ where: { isDeleted: false, createdAt: { gte: from } } }),
      this.prisma.trip.count({ where: { isDeleted: false, createdAt: { gte: from } } }),
      this.prisma.booking.count({ where: { isDeleted: false, createdAt: { gte: from } } }),
    ]);
    return ApiResponse.ok({
      metrics: [
        { key: 'users', label: 'المستخدمون', value: users, previousValue: null, format: 'number' },
        { key: 'trips', label: 'الرحلات', value: trips, previousValue: null, format: 'number' },
        { key: 'bookings', label: 'الحجوزات', value: bookings, previousValue: null, format: 'number' },
      ],
      series: [],
      tripStatusBreakdown: [],
      bookingStatusBreakdown: [],
      topRoutes: [],
      recentActivity: [],
    });
  }

  @Get('api/v1/admin/users')
  @UseGuards(AdminOnlyGuard)
  async adminUsers(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where = {
      isDeleted: false,
      ...(search
        ? {
            OR: [
              { phone: { contains: search } },
              { fullName: { contains: search } },
            ],
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { wallet: true, _count: { select: { bookings: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);
    const mapped = items.map((u) => ({
      id: u.id,
      phone: u.phone,
      fullName: u.fullName,
      email: u.email,
      avatarUrl: u.avatarUrl,
      userType: u.userType,
      isActive: u.isActive,
      walletBalance: u.wallet ? decimal(u.wallet.balance) : 0,
      bookingCount: u._count.bookings,
      createdAt: u.createdAt,
    }));
    return ApiResponse.ok(
      new PagedResult(mapped, paging.page, paging.pageSize, totalCount),
    );
  }
}

function decimal(value: { toNumber(): number } | number): number {
  return typeof value === 'number' ? value : value.toNumber();
}
