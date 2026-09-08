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
import { ApiResponse } from '../../common/api-response';
import { AdminOnly } from '../../common/decorators/admin-only.decorator';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  AppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { CurrentUserService } from '../../common/current-user.service';
import { TripStatus } from '../../common/enums';
import { newId, utcNow } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';
import { money, refCode } from '../../common/utils/money';
import { pageRequestFrom, PagedResult } from '../../common/paged-result';
import { FareService } from '../pricing/fare.service';
import { tripStatusLabel } from '../../common/utils/enums-map';

@ApiTags('admin-route-demand')
@AdminOnly()
@Controller('api/v1/admin/route-demand')
export class AdminRouteDemandController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly fare: FareService,
  ) {}

  @Get('summary')
  async summary() {
    const leads = await this.prisma.landingRouteLead.findMany({
      where: { isDeleted: false },
    });
    const routes = groupLeads(leads);
    const top = routes[0];
    return ApiResponse.ok({
      totalRouteRequests: leads.length,
      uniquePassengers: new Set(leads.map((l) => l.phone)).size,
      uniqueRoutes: routes.length,
      topRouteLabel: top?.routeLabel ?? null,
      topRouteDemand: top?.totalRequests ?? 0,
    });
  }

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const rows = await this.buildRows(search, status);
    const slice = rows.slice(paging.skip, paging.skip + paging.pageSize);
    return ApiResponse.ok(
      new PagedResult(slice, paging.page, paging.pageSize, rows.length),
    );
  }

  @Get('export')
  async export(
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    const rows = await this.buildRows(search, status);
    return ApiResponse.ok(
      rows.map((r) => ({
        rank: r.rank,
        route: r.routeLabel,
        from: r.endpointA,
        to: r.endpointB,
        demand: r.totalRequests,
        uniquePassengers: r.uniquePassengers,
        status: r.status,
        priority: r.priority,
      })),
    );
  }

  @Get('launch-plan')
  async launchPlan(@Query('routeKey') routeKey?: string) {
    const rows = await this.buildRows(undefined, undefined);
    const filtered = routeKey ? rows.filter((r) => r.routeKey === routeKey) : rows;
    return ApiResponse.ok({
      items: filtered,
      readyCount: filtered.filter((r) => r.status === 'mapped').length,
    });
  }

  @Get('vehicle-capacities')
  async capacities() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { isDeleted: false, isActive: true },
    });
    return ApiResponse.ok(
      vehicles.map((v) => ({
        id: v.id,
        type: v.type,
        capacity: v.capacity,
        plateNumber: v.plateNumber,
      })),
    );
  }

  @Get('details')
  async details(@Query('routeKey') routeKey: string) {
    const rows = await this.buildRows(undefined, undefined);
    const row = rows.find((r) => r.routeKey === routeKey);
    if (!row) {
      throw new NotFoundException('الخط غير موجود', ErrorCodes.RouteDemandNotFound);
    }
    const passengers = await this.passengers(routeKey);
    return ApiResponse.ok({
      ...row,
      capacityPercent: row.vehicleCapacity
        ? (row.confirmedPassengers / row.vehicleCapacity) * 100
        : 0,
      launchRecommendation: row.status === 'mapped' ? 'ready' : 'map-route',
      launchReason: '',
      nextAction: row.status === 'mapped' ? 'launch' : 'map-route',
      captain: null,
      passengers: passengers.data,
    });
  }

  @Get('passengers')
  async passengers(@Query('routeKey') routeKey: string) {
    const [fromCity, toCity] = decodeKey(routeKey);
    const leads = await this.prisma.landingRouteLead.findMany({
      where: { isDeleted: false, fromCity, toCity },
      orderBy: { createdAt: 'desc' },
    });
    return ApiResponse.ok(
      leads.map((l) => ({
        id: l.id,
        source: 'landing',
        passengerName: null,
        phone: l.phone,
        from: `${l.fromCity} / ${l.fromRegion}`,
        to: `${l.toCity} / ${l.toRegion}`,
        workOrUniversity: l.usageReason,
        preferredDepartureTime: l.fromTime,
        preferredReturnTime: l.toTime,
        days: l.usageDays,
        leadStatus: 'new',
        isConfirmed: false,
        createdAt: l.createdAt,
      })),
    );
  }

  @Patch('status')
  async updateStatus(
    @Query('routeKey') routeKey: string,
    @Body() body: { status: string; assignedDriverId?: string },
  ) {
    const state = await this.upsertState(routeKey, {
      status: body.status,
      assignedDriverId: body.assignedDriverId,
    });
    const rows = await this.buildRows(undefined, undefined);
    const row = rows.find((r) => r.routeKey === routeKey) ?? {
      ...emptyRow(routeKey),
      status: state.status,
    };
    return ApiResponse.ok(row, 'تم تحديث حالة الخط');
  }

  @Put('map-route')
  async mapRoute(
    @Query('routeKey') routeKey: string,
    @Body() body: { routeId: string },
  ) {
    const route = await this.prisma.route.findFirst({
      where: { id: body.routeId, isDeleted: false },
    });
    if (!route) {
      throw new NotFoundException('المسار غير موجود', ErrorCodes.RouteNotFound);
    }
    await this.upsertState(routeKey, {
      mappedRouteId: route.id,
      mappedAt: utcNow(),
      mappedByUserId: this.currentUser.requireUserId(),
      status: 'mapped',
    });
    const rows = await this.buildRows(undefined, undefined);
    return ApiResponse.ok(
      rows.find((r) => r.routeKey === routeKey),
      'تم ربط الطلب بالمسار الرسمي',
    );
  }

  @Delete('map-route')
  async unmap(@Query('routeKey') routeKey: string) {
    await this.upsertState(routeKey, {
      mappedRouteId: null,
      mappedAt: null,
      mappedByUserId: null,
      status: 'new',
    });
    const rows = await this.buildRows(undefined, undefined);
    return ApiResponse.ok(
      rows.find((r) => r.routeKey === routeKey),
      'تم إزالة ربط المسار',
    );
  }

  @Post('launch')
  async launch(
    @Query('routeKey') routeKey: string,
    @Body() body: { scheduledAt: string; driverId?: string; vehicleId?: string },
  ) {
    const state = await this.prisma.routeDemandGroupState.findFirst({
      where: { routeKey, isDeleted: false },
    });
    if (!state?.mappedRouteId) {
      throw new AppException(
        'يجب ربط الطلب بمسار رسمي أولاً',
        400,
        ErrorCodes.RouteNotLinked,
      );
    }
    const route = await this.prisma.route.findFirst({
      where: { id: state.mappedRouteId, isDeleted: false },
    });
    if (!route) {
      throw new NotFoundException('المسار غير موجود', ErrorCodes.RouteNotFound);
    }
    const pricing = await this.prisma.pricingRule.findFirst({
      where: { isDeleted: false, isActive: true, routeId: route.id },
    });
    if (!pricing) {
      throw new AppException(
        'لا توجد تسعيرة مهيأة لهذا الخط',
        400,
        ErrorCodes.PricingNotConfigured,
      );
    }
    const vehicle = body.vehicleId
      ? await this.prisma.vehicle.findFirst({
          where: { id: body.vehicleId, isDeleted: false },
        })
      : await this.prisma.vehicle.findFirst({
          where: { isDeleted: false, isActive: true },
        });
    if (!vehicle) {
      throw new AppException('لا توجد مركبة متاحة', 400, ErrorCodes.NoVehicleAvailable);
    }
    const commission = await this.fare.platformCommissionPercent(route.id);
    const trip = await this.prisma.trip.create({
      data: {
        id: newId(),
        routeId: route.id,
        driverId: body.driverId ?? state.assignedDriverId,
        status: body.driverId || state.assignedDriverId
          ? TripStatus.DriverAssigned
          : TripStatus.Scheduled,
        scheduledAt: new Date(body.scheduledAt),
        pricePerSeat: pricing.oneWayPrice,
        availableSeats: vehicle.capacity,
        referenceCode: refCode('LN'),
        ...baseFields(),
      },
    });
    return ApiResponse.ok(
      {
        tripId: trip.id,
        routeId: route.id,
        routeName: route.name,
        driverId: trip.driverId,
        vehicleId: vehicle.id,
        vehicleType: String(vehicle.type),
        status: tripStatusLabel(trip.status),
        scheduledAt: trip.scheduledAt,
        pricePerSeat: money(trip.pricePerSeat),
        availableSeats: trip.availableSeats,
        commissionPercent: commission,
        referenceCode: trip.referenceCode,
        createdAt: trip.createdAt,
        message: 'تم تشغيل الخط بنجاح',
      },
      'تم تشغيل الخط بنجاح',
    );
  }

  private async buildRows(search?: string, status?: string) {
    const leads = await this.prisma.landingRouteLead.findMany({
      where: {
        isDeleted: false,
        ...(search
          ? {
              OR: [
                { fromCity: { contains: search } },
                { toCity: { contains: search } },
                { phone: { contains: search } },
              ],
            }
          : {}),
      },
    });
    const states = await this.prisma.routeDemandGroupState.findMany({
      where: { isDeleted: false },
    });
    const stateByKey = new Map(states.map((s) => [s.routeKey, s]));
    let rows = groupLeads(leads).map((row, i) => {
      const state = stateByKey.get(row.routeKey);
      return {
        ...row,
        rank: i + 1,
        status: state?.status ?? 'new',
        assignedDriverId: state?.assignedDriverId ?? null,
        assignedDriverName: null as string | null,
        readiness: null,
      };
    });
    if (status) {
      rows = rows.filter((r) => r.status === status);
    }
    return rows;
  }

  private async upsertState(
    routeKey: string,
    data: {
      status?: string;
      assignedDriverId?: string | null;
      mappedRouteId?: string | null;
      mappedAt?: Date | null;
      mappedByUserId?: string | null;
    },
  ) {
    const existing = await this.prisma.routeDemandGroupState.findFirst({
      where: { routeKey },
    });
    if (existing) {
      return this.prisma.routeDemandGroupState.update({
        where: { id: existing.id },
        data: {
          status: data.status ?? existing.status,
          assignedDriver:
            data.assignedDriverId === undefined
              ? undefined
              : data.assignedDriverId
                ? { connect: { id: data.assignedDriverId } }
                : { disconnect: true },
          mappedRoute:
            data.mappedRouteId === undefined
              ? undefined
              : data.mappedRouteId
                ? { connect: { id: data.mappedRouteId } }
                : { disconnect: true },
          mappedAt:
            data.mappedAt === undefined ? existing.mappedAt : data.mappedAt,
          mappedByUserId:
            data.mappedByUserId === undefined
              ? existing.mappedByUserId
              : data.mappedByUserId,
          updatedAt: utcNow(),
          isDeleted: false,
        },
      });
    }
    return this.prisma.routeDemandGroupState.create({
      data: {
        id: newId(),
        routeKey,
        status: data.status ?? 'new',
        assignedDriverId: data.assignedDriverId ?? null,
        mappedRouteId: data.mappedRouteId ?? null,
        mappedAt: data.mappedAt ?? null,
        mappedByUserId: data.mappedByUserId ?? null,
        ...baseFields(),
      },
    });
  }
}

function groupLeads(
  leads: Array<{
    fromCity: string;
    toCity: string;
    phone: string;
    createdAt: Date;
  }>,
) {
  const map = new Map<
    string,
    {
      routeKey: string;
      routeLabel: string;
      endpointA: string;
      endpointB: string;
      totalRequests: number;
      unique: Set<string>;
      first: Date;
      last: Date;
    }
  >();
  for (const lead of leads) {
    const routeKey = `${lead.fromCity}|${lead.toCity}`;
    const current = map.get(routeKey);
    if (!current) {
      map.set(routeKey, {
        routeKey,
        routeLabel: `${lead.fromCity} → ${lead.toCity}`,
        endpointA: lead.fromCity,
        endpointB: lead.toCity,
        totalRequests: 1,
        unique: new Set([lead.phone]),
        first: lead.createdAt,
        last: lead.createdAt,
      });
    } else {
      current.totalRequests += 1;
      current.unique.add(lead.phone);
      if (lead.createdAt < current.first) {
        current.first = lead.createdAt;
      }
      if (lead.createdAt > current.last) {
        current.last = lead.createdAt;
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => b.totalRequests - a.totalRequests)
    .map((g) => ({
      routeKey: g.routeKey,
      routeLabel: g.routeLabel,
      endpointA: g.endpointA,
      endpointB: g.endpointB,
      totalRequests: g.totalRequests,
      confirmedPassengers: g.unique.size,
      uniquePassengers: g.unique.size,
      recommendedVehicle: g.unique.size > 8 ? 'MiniBus' : 'CarShuttle',
      vehicleCapacity: g.unique.size > 8 ? 14 : 4,
      remainingSeats: Math.max(0, (g.unique.size > 8 ? 14 : 4) - g.unique.size),
      capacityExceeded: false,
      priority: g.totalRequests >= 10 ? 'high' : g.totalRequests >= 4 ? 'medium' : 'low',
      status: 'new',
      routeType: 'demand',
      firstRequestAt: g.first,
      lastRequestAt: g.last,
    }));
}

function decodeKey(routeKey: string): [string, string] {
  const [from, to] = (routeKey ?? '').split('|');
  return [from ?? '', to ?? ''];
}

function emptyRow(routeKey: string) {
  const [a, b] = decodeKey(routeKey);
  return {
    rank: 0,
    routeKey,
    routeLabel: `${a} → ${b}`,
    endpointA: a,
    endpointB: b,
    totalRequests: 0,
    confirmedPassengers: 0,
    uniquePassengers: 0,
    recommendedVehicle: 'CarShuttle',
    vehicleCapacity: 4,
    remainingSeats: 4,
    capacityExceeded: false,
    priority: 'low',
    status: 'new',
    routeType: 'demand',
    firstRequestAt: utcNow(),
    lastRequestAt: utcNow(),
    assignedDriverId: null,
    assignedDriverName: null,
    readiness: null,
  };
}
