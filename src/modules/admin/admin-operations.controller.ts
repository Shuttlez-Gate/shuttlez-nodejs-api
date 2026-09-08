import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ApiResponse } from '../../common/api-response';
import { AdminOnly } from '../../common/decorators/admin-only.decorator';
import { PrismaService } from '../../database/prisma/prisma.service';
import { pageRequestFrom, PagedResult } from '../../common/paged-result';
import { AppException, NotFoundException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { TripStatus } from '../../common/enums';
import { newId, utcNow } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';
import { money, refCode } from '../../common/utils/money';
import {
  bookingStatusLabel,
  invoiceStatusLabel,
  parseBookingStatus,
  parseTripStatus,
  tripStatusLabel,
} from '../../common/utils/enums-map';

@ApiTags('admin-routes')
@AdminOnly()
@Controller('api/v1/admin/routes')
export class AdminRoutesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where: Prisma.RouteWhereInput = {
      isDeleted: false,
      ...(isActive != null && isActive !== ''
        ? { isActive: isActive === 'true' }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { description: { contains: search } },
            ],
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.route.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { name: 'asc' },
        include: {
          _count: { select: { stops: true, trips: true } },
        },
      }),
      this.prisma.route.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(items.map(mapRoute), paging.page, paging.pageSize, totalCount),
    );
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const route = await this.requireRoute(id);
    const stops = await this.prisma.stop.findMany({
      where: { routeId: id, isDeleted: false },
      orderBy: { order: 'asc' },
    });
    return ApiResponse.ok({
      route: mapRoute({
        ...route,
        _count: { stops: stops.length, trips: 0 },
      }),
      stops: stops.map((s) => ({
        id: s.id,
        name: s.name,
        latitude: s.latitude,
        longitude: s.longitude,
        order: s.order,
      })),
    });
  }

  @Post()
  async create(@Body() body: SaveRouteBody) {
    const route = await this.prisma.route.create({
      data: { id: newId(), ...routeData(body), ...baseFields() },
      include: { _count: { select: { stops: true, trips: true } } },
    });
    return ApiResponse.ok(
      { route: mapRoute(route), stops: [] },
      'تم إنشاء الخط',
    );
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: SaveRouteBody) {
    await this.requireRoute(id);
    const route = await this.prisma.route.update({
      where: { id },
      data: { ...routeData(body), updatedAt: utcNow() },
      include: { _count: { select: { stops: true, trips: true } } },
    });
    const stops = await this.prisma.stop.findMany({
      where: { routeId: id, isDeleted: false },
      orderBy: { order: 'asc' },
    });
    return ApiResponse.ok(
      {
        route: mapRoute(route),
        stops: stops.map((s) => ({
          id: s.id,
          name: s.name,
          latitude: s.latitude,
          longitude: s.longitude,
          order: s.order,
        })),
      },
      'تم تحديث الخط',
    );
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.requireRoute(id);
    await this.prisma.route.update({
      where: { id },
      data: { isDeleted: true, isActive: false, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم حذف الخط');
  }

  @Put(':id/stops')
  async replaceStops(
    @Param('id') id: string,
    @Body() stops: { name: string; latitude: number; longitude: number; order: number }[],
  ) {
    await this.requireRoute(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.stop.updateMany({
        where: { routeId: id, isDeleted: false },
        data: { isDeleted: true, updatedAt: utcNow() },
      });
      if (stops?.length) {
        await tx.stop.createMany({
          data: stops.map((s) => ({
            id: newId(),
            routeId: id,
            name: s.name,
            latitude: s.latitude,
            longitude: s.longitude,
            order: s.order,
            ...baseFields(),
          })),
        });
      }
    });
    return this.get(id);
  }

  @Get(':id/demand')
  async demand(@Param('id') id: string) {
    const route = await this.requireRoute(id);
    const requests = await this.prisma.routeRequest.findMany({
      where: { isDeleted: false, status: { not: 'converted' } },
    });
    const nearby = requests.filter((r) => nearRoute(r, route));
    return ApiResponse.ok({
      routeId: route.id,
      routeName: route.name,
      matchingRequests: nearby.length,
      items: nearby.map((r) => ({
        id: r.id,
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        status: r.status,
        createdAt: r.createdAt,
      })),
    });
  }

  @Post(':id/demand/apply')
  async applyDemand(
    @Param('id') id: string,
    @Body() body?: { days?: number; pricePerSeat?: number; availableSeats?: number },
  ) {
    const route = await this.requireRoute(id);
    const days = body?.days ?? 7;
    const price = body?.pricePerSeat ?? 0;
    const seats = body?.availableSeats ?? 12;
    let created = 0;
    const start = utcNow();
    for (let i = 0; i < days; i++) {
      const scheduledAt = new Date(start.getTime() + i * 86400000);
      scheduledAt.setUTCHours(7, 0, 0, 0);
      await this.prisma.trip.create({
        data: {
          id: newId(),
          routeId: route.id,
          status: TripStatus.Scheduled,
          scheduledAt,
          pricePerSeat: new Prisma.Decimal(price),
          availableSeats: seats,
          referenceCode: refCode('TR'),
          ...baseFields(),
        },
      });
      created += 1;
    }
    await this.prisma.routeRequest.updateMany({
      where: { isDeleted: false, status: 'pending' },
      data: { status: 'converted', updatedAt: utcNow() },
    });
    return ApiResponse.ok(
      { createdTrips: created, routeId: route.id },
      'تم تشغيل التوزيع وإنشاء الرحلات',
    );
  }

  private async requireRoute(id: string) {
    const route = await this.prisma.route.findFirst({
      where: { id, isDeleted: false },
    });
    if (!route) {
      throw new NotFoundException('الخط غير موجود', ErrorCodes.RouteNotFound);
    }
    return route;
  }
}

@ApiTags('admin-trips')
@AdminOnly()
@Controller('api/v1/admin/trips')
export class AdminTripsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('routeId') routeId?: string,
    @Query('driverId') driverId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const parsedStatus = parseTripStatus(status);
    const where: Prisma.TripWhereInput = {
      isDeleted: false,
      ...(routeId ? { routeId } : {}),
      ...(driverId ? { driverId } : {}),
      ...(parsedStatus != null ? { status: parsedStatus } : {}),
      ...(from || to
        ? {
            scheduledAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.trip.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { scheduledAt: 'desc' },
        include: {
          route: true,
          driver: { include: { user: true } },
          bookings: { where: { isDeleted: false } },
        },
      }),
      this.prisma.trip.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(items.map(mapTrip), paging.page, paging.pageSize, totalCount),
    );
  }

  @Post()
  async create(@Body() body: SaveTripBody) {
    const trip = await this.saveTrip(null, body);
    return ApiResponse.ok(trip, 'تم إنشاء الرحلة');
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: SaveTripBody) {
    const trip = await this.saveTrip(id, body);
    return ApiResponse.ok(trip, 'تم تحديث الرحلة');
  }

  @Put(':tripId/driver')
  async assign(
    @Param('tripId') tripId: string,
    @Body() body: { driverId: string },
  ) {
    const trip = await this.requireTrip(tripId);
    const driver = await this.prisma.driver.findFirst({
      where: { id: body.driverId, isDeleted: false, isActive: true },
    });
    if (!driver) {
      throw new NotFoundException('الكابتن غير موجود', ErrorCodes.DriverNotFound);
    }
    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        driverId: driver.id,
        status:
          trip.status === TripStatus.Scheduled
            ? TripStatus.DriverAssigned
            : trip.status,
        updatedAt: utcNow(),
      },
      include: tripInclude,
    });
    return ApiResponse.ok(mapTrip(updated), 'تم تعيين الكابتن');
  }

  @Delete(':tripId/driver')
  async unassign(@Param('tripId') tripId: string) {
    const trip = await this.requireTrip(tripId);
    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        driverId: null,
        status:
          trip.status === TripStatus.DriverAssigned
            ? TripStatus.Scheduled
            : trip.status,
        updatedAt: utcNow(),
      },
      include: tripInclude,
    });
    return ApiResponse.ok(mapTrip(updated), 'تم إلغاء تعيين الكابتن');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.requireTrip(id);
    await this.prisma.trip.update({
      where: { id },
      data: {
        isDeleted: true,
        status: TripStatus.Cancelled,
        updatedAt: utcNow(),
      },
    });
    return ApiResponse.ok(true, 'تم إلغاء الرحلة');
  }

  @Post('generate')
  async generate(
    @Body()
    body: {
      routeId: string;
      driverId?: string;
      startDate: string;
      endDate: string;
      times: string[];
      daysOfWeek?: number[];
      pricePerSeat: number;
      availableSeats: number;
    },
  ) {
    const start = new Date(body.startDate);
    const end = new Date(body.endDate);
    let created = 0;
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (body.daysOfWeek?.length && !body.daysOfWeek.includes(d.getUTCDay())) {
        continue;
      }
      for (const time of body.times ?? []) {
        const [hh, mm] = time.split(':').map(Number);
        const scheduledAt = new Date(d);
        scheduledAt.setUTCHours(hh || 0, mm || 0, 0, 0);
        await this.prisma.trip.create({
          data: {
            id: newId(),
            routeId: body.routeId,
            driverId: body.driverId,
            status: body.driverId
              ? TripStatus.DriverAssigned
              : TripStatus.Scheduled,
            scheduledAt,
            pricePerSeat: new Prisma.Decimal(body.pricePerSeat),
            availableSeats: body.availableSeats,
            referenceCode: refCode('TR'),
            ...baseFields(),
          },
        });
        created += 1;
      }
    }
    return ApiResponse.ok(created, 'تم جدولة الرحلات');
  }

  private async saveTrip(id: string | null, body: SaveTripBody) {
    const status = parseTripStatus(body.status) ?? TripStatus.Scheduled;
    if (id) {
      await this.requireTrip(id);
      const updated = await this.prisma.trip.update({
        where: { id },
        data: {
          routeId: body.routeId,
          driverId: body.driverId,
          scheduledAt: new Date(body.scheduledAt),
          pricePerSeat: new Prisma.Decimal(body.pricePerSeat),
          availableSeats: body.availableSeats,
          status,
          referenceCode: body.referenceCode,
          updatedAt: utcNow(),
        },
        include: tripInclude,
      });
      return mapTrip(updated);
    }
    const created = await this.prisma.trip.create({
      data: {
        id: newId(),
        routeId: body.routeId,
        driverId: body.driverId,
        scheduledAt: new Date(body.scheduledAt),
        pricePerSeat: new Prisma.Decimal(body.pricePerSeat),
        availableSeats: body.availableSeats,
        status,
        referenceCode: body.referenceCode ?? refCode('TR'),
        ...baseFields(),
      },
      include: tripInclude,
    });
    return mapTrip(created);
  }

  private async requireTrip(id: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, isDeleted: false },
      include: tripInclude,
    });
    if (!trip) {
      throw new NotFoundException('الرحلة غير موجودة', ErrorCodes.TripNotFound);
    }
    return trip;
  }
}

@ApiTags('admin-bookings')
@AdminOnly()
@Controller('api/v1/admin/bookings')
export class AdminBookingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('tripId') tripId?: string,
    @Query('userId') userId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const parsed = parseBookingStatus(status);
    const where: Prisma.BookingWhereInput = {
      isDeleted: false,
      ...(tripId ? { tripId } : {}),
      ...(userId ? { userId } : {}),
      ...(parsed != null ? { status: parsed } : {}),
      ...(search
        ? {
            OR: [
              { referenceCode: { contains: search } },
              { user: { phone: { contains: search } } },
            ],
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          user: true,
          invoice: true,
          trip: { include: { route: true } },
        },
      }),
      this.prisma.booking.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(
        items.map((b) => ({
          id: b.id,
          tripId: b.tripId,
          routeName: b.trip.route.name,
          scheduledAt: b.trip.scheduledAt,
          userId: b.userId,
          userPhone: b.user.phone,
          userName: b.user.fullName,
          status: bookingStatusLabel(b.status),
          seatCount: b.seatCount,
          totalAmount: money(b.totalAmount),
          paymentMethod: b.paymentMethod,
          referenceCode: b.referenceCode,
          invoiceStatus: b.invoice ? invoiceStatusLabel(b.invoice.status) : null,
          createdAt: b.createdAt,
          pricePerSeat: money(b.pricePerSeat),
          commissionRate: money(b.commissionRate),
          commissionAmount: money(b.commissionAmount),
          captainEarnings: money(b.captainEarnings),
        })),
        paging.page,
        paging.pageSize,
        totalCount,
      ),
    );
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: string },
  ) {
    const booking = await this.prisma.booking.findFirst({
      where: { id, isDeleted: false },
      include: { user: true, invoice: true, trip: { include: { route: true } } },
    });
    if (!booking) {
      throw new NotFoundException('الحجز غير موجود');
    }
    const status = parseBookingStatus(body.status);
    if (status == null) {
      throw new AppException('حالة غير صالحة');
    }
    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status, updatedAt: utcNow() },
      include: { user: true, invoice: true, trip: { include: { route: true } } },
    });
    return ApiResponse.ok(
      {
        id: updated.id,
        tripId: updated.tripId,
        routeName: updated.trip.route.name,
        scheduledAt: updated.trip.scheduledAt,
        userId: updated.userId,
        userPhone: updated.user.phone,
        userName: updated.user.fullName,
        status: bookingStatusLabel(updated.status),
        seatCount: updated.seatCount,
        totalAmount: money(updated.totalAmount),
        paymentMethod: updated.paymentMethod,
        referenceCode: updated.referenceCode,
        invoiceStatus: updated.invoice
          ? invoiceStatusLabel(updated.invoice.status)
          : null,
        createdAt: updated.createdAt,
        pricePerSeat: money(updated.pricePerSeat),
        commissionRate: money(updated.commissionRate),
        commissionAmount: money(updated.commissionAmount),
        captainEarnings: money(updated.captainEarnings),
      },
      'تم تحديث الحجز',
    );
  }
}

@ApiTags('admin-reviews')
@AdminOnly()
@Controller('api/v1/admin/reviews')
export class AdminReviewsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('driverId') driverId?: string,
    @Query('minStars') minStars?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where: Prisma.ReviewWhereInput = {
      isDeleted: false,
      ...(driverId ? { driverId } : {}),
      ...(minStars ? { stars: { gte: Number(minStars) } } : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { user: true },
      }),
      this.prisma.review.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(
        items.map((r) => ({
          id: r.id,
          tripId: r.tripId,
          routeName: '',
          userId: r.userId,
          userPhone: r.user.phone,
          userName: r.user.fullName,
          driverId: r.driverId,
          driverName: null,
          stars: r.stars,
          comment: r.comment,
          createdAt: r.createdAt,
        })),
        paging.page,
        paging.pageSize,
        totalCount,
      ),
    );
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const review = await this.prisma.review.findFirst({
      where: { id, isDeleted: false },
    });
    if (!review) {
      throw new NotFoundException('التقييم غير موجود');
    }
    await this.prisma.review.update({
      where: { id },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم حذف التقييم');
  }
}

@ApiTags('admin-route-requests')
@AdminOnly()
@Controller('api/v1/admin/route-requests')
export class AdminRouteRequestsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where: Prisma.RouteRequestWhereInput = {
      isDeleted: false,
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { fromAddress: { contains: search } },
              { toAddress: { contains: search } },
              { user: { phone: { contains: search } } },
            ],
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.routeRequest.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { user: true },
      }),
      this.prisma.routeRequest.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(
        items.map((r) => ({
          id: r.id,
          userId: r.userId,
          userPhone: r.user.phone,
          userName: r.user.fullName,
          fromAddress: r.fromAddress,
          toAddress: r.toAddress,
          status: r.status,
          preferredVehicleType: r.preferredVehicleType,
          fromLatitude: r.fromLatitude,
          fromLongitude: r.fromLongitude,
          toLatitude: r.toLatitude,
          toLongitude: r.toLongitude,
          createdAt: r.createdAt,
        })),
        paging.page,
        paging.pageSize,
        totalCount,
      ),
    );
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: string; adminNote?: string },
  ) {
    const item = await this.prisma.routeRequest.findFirst({
      where: { id, isDeleted: false },
      include: { user: true },
    });
    if (!item) {
      throw new NotFoundException('الطلب غير موجود');
    }
    const updated = await this.prisma.routeRequest.update({
      where: { id },
      data: {
        status: body.status,
        notes: body.adminNote ?? item.notes,
        updatedAt: utcNow(),
      },
      include: { user: true },
    });
    return ApiResponse.ok(
      {
        id: updated.id,
        userId: updated.userId,
        userPhone: updated.user.phone,
        userName: updated.user.fullName,
        fromAddress: updated.fromAddress,
        toAddress: updated.toAddress,
        status: updated.status,
        preferredVehicleType: updated.preferredVehicleType,
        fromLatitude: updated.fromLatitude,
        fromLongitude: updated.fromLongitude,
        toLatitude: updated.toLatitude,
        toLongitude: updated.toLongitude,
        createdAt: updated.createdAt,
      },
      'تم تحديث الطلب',
    );
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const item = await this.prisma.routeRequest.findFirst({
      where: { id, isDeleted: false },
    });
    if (!item) {
      throw new NotFoundException('الطلب غير موجود');
    }
    await this.prisma.routeRequest.update({
      where: { id },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم حذف الطلب');
  }
}

@ApiTags('admin-leads')
@AdminOnly()
@Controller('api/v1/admin/leads')
export class AdminLeadsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('kind') kind?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const [routes, waitlist, captains] = await Promise.all([
      kind && kind !== 'route'
        ? []
        : this.prisma.landingRouteLead.findMany({
            where: {
              isDeleted: false,
              ...(search ? { phone: { contains: search } } : {}),
            },
            orderBy: { createdAt: 'desc' },
          }),
      kind && kind !== 'waitlist'
        ? []
        : this.prisma.landingWaitlistEntry.findMany({
            where: {
              isDeleted: false,
              ...(search ? { phone: { contains: search } } : {}),
            },
            orderBy: { createdAt: 'desc' },
          }),
      kind && kind !== 'captain'
        ? []
        : this.prisma.landingCaptainLead.findMany({
            where: {
              isDeleted: false,
              ...(search ? { phone: { contains: search } } : {}),
            },
            orderBy: { createdAt: 'desc' },
          }),
    ]);
    const mapped = [
      ...routes.map((r) => ({
        id: r.id,
        kind: 'route',
        phone: r.phone,
        fullName: null as string | null,
        from: `${r.fromCity} / ${r.fromRegion}`,
        to: `${r.toCity} / ${r.toRegion}`,
        fromTime: r.fromTime,
        toTime: r.toTime,
        weeklyCount: r.weeklyCount,
        usageDays: r.usageDays,
        usageReason: r.usageReason,
        vehicleType: null as string | null,
        notes: null as string | null,
        source: r.source,
        createdAt: r.createdAt,
      })),
      ...waitlist.map((w) => ({
        id: w.id,
        kind: 'waitlist',
        phone: w.phone,
        fullName: w.fullName,
        from: w.routeFrom,
        to: w.routeTo,
        fromTime: null,
        toTime: null,
        weeklyCount: null,
        usageDays: null,
        usageReason: null,
        vehicleType: null,
        notes: null,
        source: w.source,
        createdAt: w.createdAt,
      })),
      ...captains.map((c) => ({
        id: c.id,
        kind: 'captain',
        phone: c.phone,
        fullName: c.fullName,
        from: null,
        to: null,
        fromTime: null,
        toTime: null,
        weeklyCount: null,
        usageDays: null,
        usageReason: null,
        vehicleType: c.vehicleType,
        notes: c.notes,
        source: c.source,
        createdAt: c.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const slice = mapped.slice(paging.skip, paging.skip + paging.pageSize);
    return ApiResponse.ok(
      new PagedResult(slice, paging.page, paging.pageSize, mapped.length),
    );
  }
}

type SaveRouteBody = {
  name: string;
  description?: string;
  startLatitude: number;
  startLongitude: number;
  endLatitude: number;
  endLongitude: number;
  encodedPolyline?: string;
  distanceMeters?: number;
  durationSeconds?: number;
  isActive?: boolean;
};

type SaveTripBody = {
  routeId: string;
  driverId?: string;
  scheduledAt: string;
  pricePerSeat: number;
  availableSeats: number;
  status?: string;
  referenceCode?: string;
};

function routeData(body: SaveRouteBody) {
  return {
    name: body.name,
    description: body.description,
    startLatitude: body.startLatitude,
    startLongitude: body.startLongitude,
    endLatitude: body.endLatitude,
    endLongitude: body.endLongitude,
    encodedPolyline: body.encodedPolyline,
    distanceMeters: body.distanceMeters,
    durationSeconds: body.durationSeconds,
    isActive: body.isActive ?? true,
  };
}

function mapRoute(r: {
  id: string;
  name: string;
  description: string | null;
  startLatitude: number;
  startLongitude: number;
  endLatitude: number;
  endLongitude: number;
  encodedPolyline: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  isActive: boolean;
  createdAt: Date;
  _count: { stops: number; trips: number };
}) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    startLatitude: r.startLatitude,
    startLongitude: r.startLongitude,
    endLatitude: r.endLatitude,
    endLongitude: r.endLongitude,
    encodedPolyline: r.encodedPolyline,
    distanceMeters: r.distanceMeters,
    durationSeconds: r.durationSeconds,
    isActive: r.isActive,
    stopCount: r._count.stops,
    tripCount: r._count.trips,
    createdAt: r.createdAt,
  };
}

const tripInclude = {
  route: true,
  driver: { include: { user: true } },
  bookings: { where: { isDeleted: false } },
} satisfies Prisma.TripInclude;

function mapTrip(
  t: Prisma.TripGetPayload<{ include: typeof tripInclude }>,
) {
  const revenue = t.bookings.reduce((s, b) => s + money(b.totalAmount), 0);
  return {
    id: t.id,
    routeId: t.routeId,
    routeName: t.route.name,
    driverId: t.driverId,
    driverName: t.driver?.user.fullName ?? null,
    status: tripStatusLabel(t.status),
    scheduledAt: t.scheduledAt,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    pricePerSeat: money(t.pricePerSeat),
    availableSeats: t.availableSeats,
    referenceCode: t.referenceCode,
    bookingCount: t.bookings.length,
    revenue,
    createdAt: t.createdAt,
  };
}

function nearRoute(
  request: { fromLatitude: number; fromLongitude: number; toLatitude: number; toLongitude: number },
  route: { startLatitude: number; startLongitude: number; endLatitude: number; endLongitude: number },
) {
  const d1 = Math.hypot(
    request.fromLatitude - route.startLatitude,
    request.fromLongitude - route.startLongitude,
  );
  const d2 = Math.hypot(
    request.toLatitude - route.endLatitude,
    request.toLongitude - route.endLongitude,
  );
  return d1 < 0.3 && d2 < 0.3;
}
