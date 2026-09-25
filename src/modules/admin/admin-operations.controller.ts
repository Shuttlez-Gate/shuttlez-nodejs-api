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
import { ConfigService } from '@nestjs/config';
import { CorridorDemandService } from './corridor-demand.service';
import { CaptainRoutesService } from '../marketplace/captain-routes.service';
import { pageRequestFrom, PagedResult } from '../../common/paged-result';
import { AppException, NotFoundException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { TripStatus, BookingStatus } from '../../common/enums';
import { newId, utcNow } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';
import { money, refCode } from '../../common/utils/money';
import {
  bookingStatusLabel,
  invoiceStatusLabel,
  parseBookingStatus,
  parseTripStatus,
  parseTripStatuses,
  tripStatusLabel,
  vehicleTypeLabel,
} from '../../common/utils/enums-map';
import {
  CONFIRMED_BOOKING_STATUS,
  driverAssignedWhere,
  occupancyPercent,
  parseOptionalBoolean,
  summarizeBookingStatusCounts,
  summarizeConfirmedBookings,
  tripCapacity,
  upcomingTripsWhere,
  isUpcomingTripSnapshot,
} from './operations-metrics';
import { enumerateOperationalSchedule, parseAbsoluteInstantRange, parseOperationalDateRange } from '../../common/utils/operational-clock';
import { resolveApplyDemandPrice, resolveRequiredAvailableSeats } from './apply-demand-price';
import { canTransitionRouteRequest } from './route-request-workflow';
import {
  adminBookingStatusWrite,
  canAdminCancelTrip,
  captainAssignmentWrite,
  captainUnassignmentWrite,
} from './admin-mutation-contracts';

@ApiTags('admin-routes')
@AdminOnly()
@Controller('api/v1/admin/routes')
export class AdminRoutesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corridorDemand: CorridorDemandService,
  ) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('isActive') isActive?: string,
    @Query('ownerType') ownerType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where: Prisma.RouteWhereInput = {
      isDeleted: false,
      ...(isActive != null && isActive !== ''
        ? { isActive: isActive === 'true' }
        : {}),
      ...(ownerType != null && ownerType !== ''
        ? { ownerType: Number(ownerType) }
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
    const now = new Date();
    const [stops, tripCount, pricingCount, stats] = await Promise.all([
      this.prisma.stop.findMany({
        where: { routeId: id, isDeleted: false },
        orderBy: { order: 'asc' },
      }),
      this.prisma.trip.count({ where: { routeId: id, isDeleted: false } }),
      this.prisma.pricingRule.count({
        where: { routeId: id, isDeleted: false, isActive: true },
      }),
      this.prisma.$queryRaw<
        Array<{
          upcomingTripCount: bigint | number;
          upcomingUnassignedCount: bigint | number;
          completedTripCount: bigint | number;
          confirmedBookingCount: bigint | number;
          confirmedSeatCount: bigint | number;
          confirmedRevenue: unknown;
          remainingSeats: bigint | number;
        }>
      >(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE
            WHEN t."Status" IN (${TripStatus.Scheduled}, ${TripStatus.DriverAssigned})
             AND t."ScheduledAt" >= ${now} THEN 1 ELSE 0 END), 0)::int AS "upcomingTripCount",
          COALESCE(SUM(CASE
            WHEN t."Status" = ${TripStatus.Scheduled}
             AND t."DriverId" IS NULL
             AND t."ScheduledAt" >= ${now} THEN 1 ELSE 0 END), 0)::int AS "upcomingUnassignedCount",
          COALESCE(SUM(CASE WHEN t."Status" = ${TripStatus.Completed} THEN 1 ELSE 0 END), 0)::int AS "completedTripCount",
          COALESCE(SUM(s.confirmed_bookings), 0)::int AS "confirmedBookingCount",
          COALESCE(SUM(s.confirmed_seats), 0)::int AS "confirmedSeatCount",
          COALESCE(SUM(s.confirmed_revenue), 0) AS "confirmedRevenue",
          COALESCE(SUM(t."AvailableSeats"), 0)::int AS "remainingSeats"
        FROM "TripsSet" t
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(CASE WHEN b."IsDeleted" = false AND b."Status" = ${BookingStatus.Confirmed} THEN 1 ELSE 0 END), 0)::int AS confirmed_bookings,
            COALESCE(SUM(CASE WHEN b."IsDeleted" = false AND b."Status" = ${BookingStatus.Confirmed} THEN b."SeatCount" ELSE 0 END), 0)::int AS confirmed_seats,
            COALESCE(SUM(CASE WHEN b."IsDeleted" = false AND b."Status" = ${BookingStatus.Confirmed} THEN b."TotalAmount" ELSE 0 END), 0) AS confirmed_revenue
          FROM "BookingsSet" b
          WHERE b."TripId" = t."Id"
        ) s ON true
        WHERE t."RouteId" = ${id}
          AND t."IsDeleted" = false
      `),
    ]);
    const row = stats[0];
    const confirmedSeatCount = Number(row?.confirmedSeatCount ?? 0);
    const remainingSeats = Number(row?.remainingSeats ?? 0);
    return ApiResponse.ok({
      route: mapRoute({
        ...route,
        _count: { stops: stops.length, trips: tripCount },
      }),
      stops: stops.map((s) => ({
        id: s.id,
        name: s.name,
        latitude: s.latitude,
        longitude: s.longitude,
        order: s.order,
      })),
      operations: {
        pricingLinked: pricingCount > 0,
        activePricingRules: pricingCount,
        upcomingTripCount: Number(row?.upcomingTripCount ?? 0),
        upcomingUnassignedCount: Number(row?.upcomingUnassignedCount ?? 0),
        completedTripCount: Number(row?.completedTripCount ?? 0),
        confirmedBookingCount: Number(row?.confirmedBookingCount ?? 0),
        confirmedSeatCount,
        confirmedRevenue: money(Number(row?.confirmedRevenue ?? 0)),
        occupancyPercent: occupancyPercent(confirmedSeatCount, remainingSeats),
        association: 'Trip.routeId',
      },
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
    return ApiResponse.ok(await this.corridorDemand.analyze(id));
  }

  @Post(':id/demand/apply')
  async applyDemand(
    @Param('id') id: string,
    @Body() body?: { scheduledAt?: string | null; pricePerSeat?: number | null },
  ) {
    return ApiResponse.ok(
      await this.corridorDemand.apply(id, body),
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async list(
    @Query('routeId') routeId?: string,
    @Query('driverId') driverId?: string,
    @Query('driverAssigned') driverAssigned?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fromDateTime') fromDateTime?: string,
    @Query('toDateTime') toDateTime?: string,
    @Query('upcoming') upcoming?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const parsedStatuses = parseTripStatuses(status);
    const assigned = parseOptionalBoolean(driverAssigned);
    const assignmentFilter = driverId ? { driverId } : driverAssignedWhere(assigned);
    const scheduledRange =
      parseAbsoluteInstantRange(fromDateTime, toDateTime) ??
      parseOperationalDateRange(
        from,
        to,
        this.config.get<string>('OPERATIONAL_TIMEZONE'),
      );
    const upcomingOnly = parseOptionalBoolean(upcoming) === true;
    const upcomingWhere = upcomingOnly ? upcomingTripsWhere(new Date()) : null;
    let scheduledAtFilter: Prisma.DateTimeFilter | undefined;
    if (upcomingWhere && scheduledRange) {
      const rangeGte = scheduledRange.gte ?? upcomingWhere.scheduledAt.gte;
      scheduledAtFilter = {
        ...scheduledRange,
        gte:
          rangeGte.getTime() > upcomingWhere.scheduledAt.gte.getTime()
            ? rangeGte
            : upcomingWhere.scheduledAt.gte,
      };
    } else if (upcomingWhere) {
      scheduledAtFilter = upcomingWhere.scheduledAt;
    } else if (scheduledRange) {
      scheduledAtFilter = scheduledRange;
    }
    const where: Prisma.TripWhereInput = {
      isDeleted: false,
      ...(routeId ? { routeId } : {}),
      ...(assignmentFilter ?? {}),
      ...(parsedStatuses != null
        ? parsedStatuses.length === 1
          ? { status: parsedStatuses[0] }
          : { status: { in: parsedStatuses } }
        : upcomingWhere
          ? { status: upcomingWhere.status }
          : {}),
      ...(scheduledAtFilter ? { scheduledAt: scheduledAtFilter } : {}),
      ...(search
        ? {
            OR: [
              { referenceCode: { contains: search } },
              { route: { name: { contains: search } } },
            ],
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.trip.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { scheduledAt: upcomingOnly ? 'asc' : 'desc' },
        include: tripInclude,
      }),
      this.prisma.trip.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(items.map(mapTrip), paging.page, paging.pageSize, totalCount),
    );
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, isDeleted: false },
      include: tripDetailsInclude,
    });
    if (!trip) {
      throw new NotFoundException('الرحلة غير موجودة', ErrorCodes.TripNotFound);
    }
    return ApiResponse.ok(mapTripDetails(trip));
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
    const assignment = captainAssignmentWrite(trip.status, driver.id);
    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        ...assignment,
        updatedAt: utcNow(),
      },
      include: tripInclude,
    });
    return ApiResponse.ok(mapTrip(updated), 'تم تعيين الكابتن');
  }

  @Delete(':tripId/driver')
  async unassign(@Param('tripId') tripId: string) {
    const trip = await this.requireTrip(tripId);
    const unassignment = captainUnassignmentWrite(trip.status);
    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        ...unassignment,
        updatedAt: utcNow(),
      },
      include: tripInclude,
    });
    return ApiResponse.ok(mapTrip(updated), 'تم إلغاء تعيين الكابتن');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const trip = await this.requireTrip(id);
    if (!canAdminCancelTrip(trip.status)) {
      throw new AppException('لا يمكن إلغاء رحلة مكتملة أو ملغاة', 400);
    }
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
    const pricePerSeat = resolveApplyDemandPrice(body.pricePerSeat);
    if (pricePerSeat == null) {
      throw new AppException('سعر المقعد مطلوب ويجب أن يكون أكبر من صفر', 400);
    }
    const availableSeats = resolveRequiredAvailableSeats(body.availableSeats);
    if (availableSeats == null) {
      throw new AppException('عدد المقاعد المتاحة مطلوب ويجب أن يكون 1 على الأقل', 400);
    }
    const start = body.startDate?.trim();
    const end = body.endDate?.trim();
    if (!start || !end) {
      throw new AppException('تاريخ البداية والنهاية مطلوبان', 400);
    }
    const instants = enumerateOperationalSchedule({
      startDate: start,
      endDate: end,
      times: body.times ?? [],
      daysOfWeek: body.daysOfWeek,
      timeZone: this.config.get<string>('OPERATIONAL_TIMEZONE'),
    });
    if (instants.length === 0) {
      return ApiResponse.ok(0, 'تم جدولة الرحلات');
    }
    await this.prisma.$transaction(async (tx) => {
      for (const scheduledAt of instants) {
        await tx.trip.create({
          data: {
            id: newId(),
            routeId: body.routeId,
            driverId: body.driverId,
            status: body.driverId
              ? TripStatus.DriverAssigned
              : TripStatus.Scheduled,
            scheduledAt,
            pricePerSeat: new Prisma.Decimal(pricePerSeat),
            availableSeats,
            referenceCode: refCode('TR'),
            ...baseFields(),
          },
        });
      }
    });
    return ApiResponse.ok(instants.length, 'تم جدولة الرحلات');
  }

  private async saveTrip(id: string | null, body: SaveTripBody) {
    const pricePerSeat = resolveApplyDemandPrice(body.pricePerSeat);
    if (pricePerSeat == null) {
      throw new AppException('سعر المقعد مطلوب ويجب أن يكون أكبر من صفر', 400);
    }
    const availableSeats = resolveRequiredAvailableSeats(body.availableSeats);
    if (availableSeats == null) {
      throw new AppException('عدد المقاعد المتاحة مطلوب ويجب أن يكون 1 على الأقل', 400);
    }
    const status = parseTripStatus(body.status) ?? TripStatus.Scheduled;
    if (id) {
      await this.requireTrip(id);
      const updated = await this.prisma.trip.update({
        where: { id },
        data: {
          routeId: body.routeId,
          driverId: body.driverId,
          scheduledAt: new Date(body.scheduledAt),
          pricePerSeat: new Prisma.Decimal(pricePerSeat),
          availableSeats,
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
        pricePerSeat: new Prisma.Decimal(pricePerSeat),
        availableSeats,
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
      data: adminBookingStatusWrite(status, utcNow()),
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
    @Query('kind') kind?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where: Prisma.RouteRequestWhereInput = {
      isDeleted: false,
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
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
          kind: r.kind,
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
    if (!body?.status) {
      throw new AppException('الحالة مطلوبة', 400);
    }
    if (!canTransitionRouteRequest(item.status, body.status)) {
      throw new AppException('انتقال حالة غير مسموح', 400);
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
        kind: updated.kind,
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
  ownerType: number;
  ownerDriverId: string | null;
  publishStatus: number;
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
    ownerType: r.ownerType,
    ownerDriverId: r.ownerDriverId,
    publishStatus: r.publishStatus,
    stopCount: r._count.stops,
    tripCount: r._count.trips,
    createdAt: r.createdAt,
  };
}

const tripInclude = {
  route: true,
  driver: { include: { user: true } },
  bookings: {
    where: { isDeleted: false, status: CONFIRMED_BOOKING_STATUS },
  },
} satisfies Prisma.TripInclude;

const tripDetailsInclude = {
  route: true,
  driver: { include: { user: true, vehicle: true } },
  bookings: {
    where: { isDeleted: false },
    include: { user: true },
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.TripInclude;

function mapTripFinance(
  bookings: Array<{
    status: number;
    seatCount: number;
    totalAmount: Prisma.Decimal | number;
    commissionAmount: Prisma.Decimal | number;
    captainEarnings: Prisma.Decimal | number;
  }>,
  availableSeats: number,
) {
  const finance = summarizeConfirmedBookings(
    bookings.map((booking) => ({
      status: booking.status,
      seatCount: booking.seatCount,
      totalAmount: money(booking.totalAmount),
      commissionAmount: money(booking.commissionAmount),
      captainEarnings: money(booking.captainEarnings),
    })),
  );
  const capacity = tripCapacity(availableSeats, finance.confirmedSeatCount);
  return {
    ...finance,
    capacity,
    occupancyPercent: occupancyPercent(finance.confirmedSeatCount, availableSeats),
  };
}

function mapTripCore(t: {
  id: string;
  routeId: string;
  route: { name: string };
  driverId: string | null;
  driver: { user: { fullName: string | null } } | null;
  status: number;
  scheduledAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  pricePerSeat: Prisma.Decimal | number;
  availableSeats: number;
  referenceCode: string | null;
  createdAt: Date;
  bookings: Array<{
    status: number;
    seatCount: number;
    totalAmount: Prisma.Decimal | number;
    commissionAmount: Prisma.Decimal | number;
    captainEarnings: Prisma.Decimal | number;
  }>;
}) {
  const finance = mapTripFinance(t.bookings, t.availableSeats);
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
    bookingCount: finance.confirmedBookingCount,
    /** Confirmed shuttle revenue: SUM(TotalAmount) for BookingStatus.Confirmed only. */
    revenue: finance.confirmedRevenue,
    confirmedBookingCount: finance.confirmedBookingCount,
    confirmedSeatCount: finance.confirmedSeatCount,
    confirmedCommission: finance.confirmedCommission,
    confirmedCaptainEarnings: finance.confirmedCaptainEarnings,
    capacity: finance.capacity,
    occupancyPercent: finance.occupancyPercent,
    createdAt: t.createdAt,
    isUpcoming: isUpcomingTripSnapshot(t.status, t.scheduledAt, new Date()),
  };
}

function mapTrip(t: Prisma.TripGetPayload<{ include: typeof tripInclude }>) {
  return mapTripCore(t);
}

function mapTripVehicle(
  driver: Prisma.TripGetPayload<{ include: typeof tripDetailsInclude }>['driver'],
) {
  if (driver?.vehicle) {
    return {
      id: driver.vehicle.id,
      type: vehicleTypeLabel(driver.vehicle.type),
      capacity: driver.vehicle.capacity,
      plateNumber: driver.vehicle.plateNumber,
      model: driver.vehicle.model,
    };
  }
  if (driver?.plateNumber || driver?.vehicleKind || driver?.seats) {
    return {
      id: driver.vehicleId ?? null,
      type: driver.vehicleKind ?? null,
      capacity: driver.seats ?? null,
      plateNumber: driver.plateNumber ?? null,
      model: driver.vehicleModelName ?? null,
    };
  }
  return null;
}

function mapTripDetails(
  t: Prisma.TripGetPayload<{ include: typeof tripDetailsInclude }>,
) {
  const list = mapTripCore(t);
  const arrivalAt =
    t.route.durationSeconds != null
      ? new Date(t.scheduledAt.getTime() + t.route.durationSeconds * 1000)
      : null;
  return {
    ...list,
    date: t.scheduledAt,
    departureTime: t.scheduledAt,
    arrivalAt,
    bookedSeats: list.confirmedSeatCount,
    driver: t.driver
      ? {
          id: t.driver.id,
          name: t.driver.user.fullName,
          phone: t.driver.user.phone,
          assigned: true,
          isOnline: t.driver.isOnline,
        }
      : {
          id: null,
          name: null,
          phone: null,
          assigned: false,
          isOnline: null,
        },
    vehicle: mapTripVehicle(t.driver),
    bookingSummary: summarizeBookingStatusCounts(t.bookings),
    bookings: t.bookings.map((booking) => ({
      id: booking.id,
      reference: booking.referenceCode,
      userId: booking.userId,
      userName: booking.user.fullName,
      userPhone: booking.user.phone,
      seats: booking.seatCount,
      status: bookingStatusLabel(booking.status),
      totalAmount: money(booking.totalAmount),
      commissionAmount: money(booking.commissionAmount),
      captainAmount: money(booking.captainEarnings),
      bookingDate: booking.createdAt,
    })),
  };
}

@ApiTags('admin-cancellation-requests')
@AdminOnly()
@Controller('api/v1/admin/cancellation-requests')
export class AdminCancellationRequestsController {
  constructor(private readonly captainRoutes: CaptainRoutesService) {}

  @Get()
  async list(@Query('status') status?: string) {
    const parsed =
      status == null || status === '' ? undefined : Number(status);
    return ApiResponse.ok(
      await this.captainRoutes.listCancellationRequests(
        Number.isFinite(parsed) ? parsed : undefined,
      ),
    );
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: string; adminNotes?: string },
  ) {
    return ApiResponse.ok(
      await this.captainRoutes.reviewCancellation(id, body.status, body.adminNotes),
      'تم تحديث طلب الإلغاء',
    );
  }
}
