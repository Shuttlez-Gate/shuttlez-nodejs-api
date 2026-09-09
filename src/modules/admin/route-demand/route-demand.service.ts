import { Injectable, Scope } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { CurrentUserService } from '../../../common/current-user.service';
import {
  AppException,
  NotFoundException,
} from '../../../common/exceptions/app.exception';
import { ErrorCodes } from '../../../common/error-codes';
import { TripStatus, VehicleType } from '../../../common/enums';
import { newId, utcNow } from '../../../common/utils/date.util';
import { baseFields } from '../../../common/utils/entity-defaults';
import { money, normalizeMoney, refCode } from '../../../common/utils/money';
import { tripStatusLabel, vehicleTypeLabel } from '../../../common/utils/enums-map';
import { pageRequestFrom, PagedResult } from '../../../common/paged-result';
import {
  buildDisplayLabel,
  buildRouteKey,
  deriveRouteKeys,
  normalizeLocation,
} from './route-location';
import {
  ReasonCodes,
  evaluateReadiness,
  occupancyFromConfirmed,
  toApiStatus,
  toNumber,
  tryParseVehicleType,
  type DemandLaunchStatus,
  type ReadinessResult,
} from './readiness';

const ALLOWED_STATUSES = [
  'new_demand',
  'collecting_demand',
  'ready_for_captain',
  'captain_assigned',
  'ready_to_launch',
  'running',
  'paused',
  'rejected',
] as const;

const DEFAULT_CAPACITY: Record<number, number> = {
  [VehicleType.CarShuttle]: 4,
  [VehicleType.MiniBus]: 13,
  [VehicleType.Bus]: 24,
};

export interface DemandQuery {
  search?: string;
  from?: string;
  to?: string;
  vehicleType?: string;
  priority?: string;
  status?: string;
  routeType?: string;
  routeCategory?: string;
  createdFrom?: string;
  createdTo?: string;
  page?: string;
  pageSize?: string;
  launchStatus?: string;
  pricingAvailable?: string;
  readyToLaunch?: string;
  routeKey?: string;
}

interface PassengerRow {
  id: string;
  source: string;
  passengerName: string | null;
  phone: string;
  from: string;
  to: string;
  workOrUniversity: string | null;
  preferredDepartureTime: string | null;
  preferredReturnTime: string | null;
  days: string | null;
  preferredVehicleType?: string | null;
  leadStatus: string;
  isConfirmed: boolean;
  createdAt: Date;
  routeKey: string;
}

interface DemandGroup {
  routeKey: string;
  routeLabel: string;
  endpointA: string;
  endpointB: string;
  passengers: PassengerRow[];
  totalRequests: number;
  uniquePassengers: number;
  confirmedPassengers: number;
  routeType: string;
  status: string;
  assignedDriverId: string | null;
  assignedDriverName: string | null;
  captain: {
    driverId: string;
    name: string;
    phone: string;
    vehicleType: string;
    capacity: number;
    status: string;
  } | null;
  vehicle: { code: string; label: string; capacity: number; capacityExceeded: boolean };
  mappedRouteId: string | null;
  firstRequestAt: Date;
  lastRequestAt: Date;
  readiness: Record<string, unknown> | null;
}

@Injectable({ scope: Scope.REQUEST })
export class RouteDemandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  async summary() {
    const groups = await this.buildGroups();
    const top = groups[0];
    const passengers = groups.flatMap((g) => g.passengers);
    return {
      totalRouteRequests: passengers.length,
      uniquePassengers: new Set(passengers.map((p) => p.phone)).size,
      uniqueRoutes: groups.length,
      topRouteLabel: top?.routeLabel ?? null,
      topRouteDemand: top?.totalRequests ?? 0,
    };
  }

  async list(query: DemandQuery) {
    const paging = pageRequestFrom(Number(query.page), Number(query.pageSize));
    const groups = await this.buildGroups();
    await this.attachReadiness(groups);
    const filtered = this.applyFilters(groups, query);
    const slice = filtered.slice(paging.skip, paging.skip + paging.pageSize);
    return new PagedResult(
      slice.map((g, i) => this.toRow(g, paging.skip + i + 1)),
      paging.page,
      paging.pageSize,
      filtered.length,
    );
  }

  async export(query: DemandQuery) {
    const groups = await this.buildGroups();
    await this.attachReadiness(groups);
    return this.applyFilters(groups, query).map((g, index) => {
      const preferredTime = mode(
        g.passengers.map((p) => p.preferredDepartureTime).filter((t): t is string => !!t),
      );
      return {
        rank: index + 1,
        route: g.routeLabel,
        from: g.endpointA,
        to: g.endpointB,
        demand: g.totalRequests,
        uniquePassengers: g.uniquePassengers,
        confirmedPassengers: g.confirmedPassengers,
        recommendedVehicle: g.vehicle.label,
        vehicleCapacity: g.vehicle.capacity,
        remainingSeats: Math.max(0, g.vehicle.capacity - g.totalRequests),
        priority: calculatePriority(g.totalRequests),
        status: g.status,
        preferredTime,
        assignedDriverName: g.assignedDriverName,
        firstRequestAt: g.firstRequestAt,
      };
    });
  }

  async details(routeKey: string) {
    const groups = await this.buildGroups();
    const group = groups.find((g) => g.routeKey === routeKey);
    if (!group) {
      throw new NotFoundException('مجموعة الطلب غير موجودة', ErrorCodes.RouteDemandNotFound);
    }
    await this.attachReadiness([group]);
    return this.toDetails(group);
  }

  async passengers(routeKey: string) {
    const groups = await this.buildGroups();
    const group = groups.find((g) => g.routeKey === routeKey);
    return (group?.passengers ?? [])
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(toPassengerDto);
  }

  async vehicleCapacities() {
    const fleet = await this.prisma.vehicle.groupBy({
      by: ['type'],
      where: { isDeleted: false, isActive: true, capacity: { gt: 0 } },
      _max: { capacity: true },
    });
    const byType = new Map(fleet.map((row) => [row.type, row._max.capacity ?? 0]));
    return [VehicleType.CarShuttle, VehicleType.MiniBus, VehicleType.Bus]
      .map((type) => {
        const fleetCap = byType.get(type) ?? 0;
        const capacity = fleetCap > 0 ? fleetCap : DEFAULT_CAPACITY[type] ?? 0;
        return {
          vehicleType: vehicleTypeName(type),
          displayName: vehicleDisplayName(type),
          capacity,
          source: fleetCap > 0 ? 'VEHICLE_MASTER' : 'DEFAULT_HINT',
        };
      })
      .filter((x) => x.capacity > 0);
  }

  async launchPlan(query: DemandQuery) {
    const groups = await this.buildGroups();
    await this.attachReadiness(groups);
    const preFilter = { ...query, launchStatus: undefined, readyToLaunch: undefined };
    let plans = this.applyFilters(groups, preFilter)
      .filter((g) => g.readiness)
      .map((g) => this.toLaunchPlan(g));

    if (query.routeKey) {
      plans = plans.filter((p) => p.routeKey === query.routeKey);
    }
    if (query.launchStatus) {
      const st = query.launchStatus.trim().toUpperCase();
      plans = plans.filter((p) => p.launchStatus === st);
    }
    if (query.pricingAvailable === 'true' || query.pricingAvailable === 'false') {
      const ok = query.pricingAvailable === 'true';
      plans = plans.filter((p) => p.pricingAvailable === ok);
    }
    if (query.readyToLaunch === 'true') {
      plans = plans.filter(
        (p) => p.launchStatus === 'READY_TO_LAUNCH' || p.launchStatus === 'FULL',
      );
    }

    plans.sort((a, b) => {
      const rank = planningSortRank(a.launchStatus) - planningSortRank(b.launchStatus);
      if (rank !== 0) return rank;
      if (b.demand !== a.demand) return b.demand - a.demand;
      return String(a.routeLabel).localeCompare(String(b.routeLabel));
    });

    return {
      items: plans,
      summary: {
        totalRoutes: plans.length,
        collectingDemand: plans.filter((i) => i.launchStatus === 'COLLECTING_DEMAND').length,
        almostReady: plans.filter((i) => i.launchStatus === 'ALMOST_READY').length,
        readyToLaunch: plans.filter((i) => i.launchStatus === 'READY_TO_LAUNCH').length,
        full: plans.filter((i) => i.launchStatus === 'FULL').length,
        pricingMissing: plans.filter((i) => i.launchStatus === 'PRICING_NOT_CONFIGURED').length,
        vehicleConfigMissing: plans.filter((i) => i.launchStatus === 'NO_VEHICLE_CONFIG').length,
        dataIncomplete: plans.filter((i) => i.launchStatus === 'DATA_INCOMPLETE').length,
      },
    };
  }

  async updateStatus(routeKey: string, body: { status: string; assignedDriverId?: string | null }) {
    const status = (body.status || '').trim().toLowerCase();
    if (!ALLOWED_STATUSES.includes(status as (typeof ALLOWED_STATUSES)[number])) {
      throw new AppException(
        'حالة غير مسموحة. المسموح: ' + ALLOWED_STATUSES.join(' / '),
        400,
      );
    }
    await this.upsertState(routeKey, {
      status,
      assignedDriverId: body.assignedDriverId,
    });
    return this.rowByKey(routeKey);
  }

  async mapRoute(routeKey: string, routeId: string) {
    if (!routeKey?.trim()) {
      throw new AppException('مفتاح مجموعة الطلب مطلوب.', 400, ErrorCodes.RouteDemandNotFound);
    }
    const groups = await this.buildGroups();
    if (!groups.some((g) => g.routeKey === routeKey)) {
      throw new NotFoundException('مجموعة الطلب غير موجودة.', ErrorCodes.RouteDemandNotFound);
    }
    const route = await this.prisma.route.findFirst({
      where: { id: routeId, isDeleted: false, isActive: true },
    });
    if (!route) {
      throw new NotFoundException('المسار الرسمي غير موجود أو غير نشط.', ErrorCodes.RouteNotFound);
    }
    const conflict = await this.prisma.routeDemandGroupState.findFirst({
      where: { isDeleted: false, mappedRouteId: routeId, routeKey: { not: routeKey } },
    });
    if (conflict) {
      throw new AppException(
        'هذا المسار مرتبط بالفعل بمجموعة طلب أخرى. أزل الربط السابق أولاً.',
        400,
      );
    }
    const existing = await this.prisma.routeDemandGroupState.findFirst({
      where: { routeKey, isDeleted: false },
    });
    await this.upsertState(routeKey, {
      status: existing?.status ?? 'collecting_demand',
      mappedRouteId: route.id,
      mappedAt: utcNow(),
      mappedByUserId: this.currentUser.requireUserId(),
    });
    return this.rowByKey(routeKey);
  }

  async unmapRoute(routeKey: string) {
    const existing = await this.prisma.routeDemandGroupState.findFirst({
      where: { routeKey, isDeleted: false },
    });
    if (!existing) {
      throw new AppException('لا يوجد ربط محفوظ لهذه المجموعة.', 400, ErrorCodes.RouteNotLinked);
    }
    await this.upsertState(routeKey, {
      mappedRouteId: null,
      mappedAt: null,
      mappedByUserId: null,
    });
    return this.rowByKey(routeKey);
  }

  async launch(
    routeKey: string,
    body: { scheduledAt: string; driverId?: string | null; vehicleId?: string | null },
  ) {
    if (!routeKey?.trim()) {
      throw new AppException('مفتاح مجموعة الطلب مطلوب.', 400, ErrorCodes.RouteDemandNotFound);
    }
    const scheduledAt = new Date(body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
      throw new AppException(
        'موعد الرحلة يجب أن يكون في المستقبل.',
        400,
        ErrorCodes.InvalidServiceDate,
      );
    }

    const details = await this.details(routeKey);
    const readiness = details.readiness as Record<string, unknown> | null;
    if (!readiness) {
      throw new AppException('تعذّر حساب الجاهزية.', 400, ErrorCodes.NotReadyToLaunch);
    }
    if (!readiness.pricingLinked || !readiness.routeId) {
      throw new AppException('الطلب غير مرتبط بخط رسمي.', 400, ErrorCodes.RouteNotLinked);
    }
    if (String(readiness.launchStatus).toUpperCase() !== 'READY') {
      throw new AppException(
        `الخط غير جاهز للتشغيل. الحالة الحالية: ${readiness.launchStatus}. ${readiness.readinessReason}`,
        400,
        ErrorCodes.NotReadyToLaunch,
      );
    }

    const routeId = String(readiness.routeId);
    const route = await this.prisma.route.findFirst({
      where: { id: routeId, isDeleted: false, isActive: true },
    });
    if (!route) {
      throw new NotFoundException('المسار الرسمي غير موجود أو غير نشط.', ErrorCodes.RouteNotFound);
    }

    const resolved = await this.resolveLaunchVehicle(
      readiness.vehicleType as string | null,
      readiness.capacity as number | null,
      body.vehicleId,
    );

    const rule = await this.findActivePricing(routeId, resolved.vehicleType);
    if (!rule || money(rule.oneWayPrice) <= 0) {
      throw new AppException(
        'لا يوجد تسعير فعّال لهذا الخط ونوع المركبة.',
        400,
        ErrorCodes.PricingNotConfigured,
      );
    }

    let driverId: string | null = null;
    if (body.driverId) {
      const driver = await this.prisma.driver.findFirst({
        where: { id: body.driverId, isDeleted: false, isActive: true },
      });
      if (!driver) {
        throw new AppException('الكابتن غير موجود أو غير نشط.', 400, ErrorCodes.DriverNotFound);
      }
      driverId = driver.id;
    }

    const duplicate = await this.prisma.trip.findFirst({
      where: {
        isDeleted: false,
        routeId,
        scheduledAt,
        status: { not: TripStatus.Cancelled },
      },
    });
    if (duplicate) {
      throw new AppException(
        'توجد رحلة تشغيلية لنفس الخط والموعد بالفعل.',
        400,
        ErrorCodes.DuplicateOperationalTrip,
      );
    }

    const commission = Number(readiness.commissionRate ?? 0);
    const trip = await this.prisma.trip.create({
      data: {
        id: newId(),
        routeId,
        driverId,
        status: driverId ? TripStatus.DriverAssigned : TripStatus.Scheduled,
        scheduledAt,
        pricePerSeat: normalizeMoney(money(rule.oneWayPrice)),
        availableSeats: resolved.capacity,
        referenceCode: refCode('LN'),
        ...baseFields(),
      },
    });

    return {
      tripId: trip.id,
      routeId,
      routeName: route.name,
      driverId: trip.driverId,
      vehicleId: resolved.vehicleId,
      vehicleType: vehicleTypeName(resolved.vehicleType),
      status: tripStatusLabel(trip.status),
      scheduledAt: trip.scheduledAt,
      pricePerSeat: money(trip.pricePerSeat),
      availableSeats: trip.availableSeats,
      commissionPercent: commission,
      referenceCode: trip.referenceCode,
      createdAt: trip.createdAt,
      message: 'تم إنشاء الرحلة التشغيلية. لن يتم تحويل طلبات الطلب إلى حجوزات تلقائياً.',
    };
  }

  private async rowByKey(routeKey: string) {
    const groups = await this.buildGroups();
    const group = groups.find((g) => g.routeKey === routeKey);
    if (!group) {
      throw new NotFoundException('مجموعة الطلب غير موجودة', ErrorCodes.RouteDemandNotFound);
    }
    await this.attachReadiness([group]);
    return this.toRow(group, 0);
  }

  private async resolveLaunchVehicle(
    readinessVehicleType: string | null,
    readinessCapacity: number | null,
    requestVehicleId?: string | null,
  ) {
    if (requestVehicleId) {
      const vehicle = await this.prisma.vehicle.findFirst({
        where: { id: requestVehicleId, isDeleted: false, isActive: true },
      });
      if (!vehicle) {
        throw new AppException('المركبة غير موجودة أو غير نشطة.', 400, ErrorCodes.NoVehicleAvailable);
      }
      return { vehicleType: vehicle.type, capacity: vehicle.capacity, vehicleId: vehicle.id };
    }
    const type = tryParseVehicleType(readinessVehicleType);
    const capacity = readinessCapacity ?? 0;
    if (!type || capacity <= 0) {
      throw new AppException('سعة المركبة غير متاحة.', 400, ErrorCodes.NoVehicleConfig);
    }
    return { vehicleType: type, capacity, vehicleId: null as string | null };
  }

  private async findActivePricing(routeId: string, vehicleType: number) {
    const asOf = utcNow();
    const rules = await this.prisma.pricingRule.findMany({
      where: {
        isDeleted: false,
        isActive: true,
        vehicleType,
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }],
      },
    });
    const effective = rules.filter((r) => !r.effectiveTo || r.effectiveTo >= asOf);
    return (
      pickLatest(effective.filter((r) => r.routeId === routeId)) ??
      pickLatest(effective.filter((r) => r.routeId == null))
    );
  }

  private async buildGroups(): Promise<DemandGroup[]> {
    const passengers = await this.loadPassengers();
    const states = await this.prisma.routeDemandGroupState.findMany({
      where: { isDeleted: false },
      include: {
        assignedDriver: { include: { user: true, vehicle: true } },
      },
    });
    const stateByKey = new Map(states.map((s) => [s.routeKey, s]));

    const grouped = new Map<string, PassengerRow[]>();
    for (const passenger of passengers) {
      const list = grouped.get(passenger.routeKey) ?? [];
      list.push(passenger);
      grouped.set(passenger.routeKey, list);
    }

    const groups: DemandGroup[] = [];
    for (const [routeKey, samples] of grouped) {
      const endpoints = resolveEndpointLabels(samples);
      const state = stateByKey.get(routeKey);
      const totalRequests = samples.length;
      const uniquePassengers = new Set(samples.map((s) => s.phone)).size;
      const confirmedPassengers = samples.filter((s) => s.isConfirmed).length;
      const vehicle = recommendVehicle(totalRequests);
      const defaultStatus = totalRequests >= 3 ? 'collecting_demand' : 'new_demand';
      const driver = state?.assignedDriver;
      const captain = driver
        ? {
            driverId: driver.id,
            name: driver.user.fullName || driver.user.phone,
            phone: driver.user.phone,
            vehicleType: driver.vehicle
              ? vehicleTypeLabel(driver.vehicle.type)
              : driver.vehicleKind || '—',
            capacity: driver.vehicle?.capacity ?? driver.seats ?? 0,
            status: String(driver.verificationStatus),
          }
        : null;

      groups.push({
        routeKey,
        routeLabel: buildDisplayLabel(endpoints.a, endpoints.b),
        endpointA: endpoints.a,
        endpointB: endpoints.b,
        passengers: samples,
        totalRequests,
        uniquePassengers,
        confirmedPassengers,
        routeType: inferDominantRouteType(samples),
        status: state?.status ?? defaultStatus,
        assignedDriverId: state?.assignedDriverId ?? null,
        assignedDriverName: captain?.name ?? null,
        captain,
        vehicle,
        mappedRouteId: state?.mappedRouteId ?? null,
        firstRequestAt: minDate(samples.map((s) => s.createdAt)),
        lastRequestAt: maxDate(samples.map((s) => s.createdAt)),
        readiness: null,
      });
    }

    return groups.sort((a, b) => {
      if (b.totalRequests !== a.totalRequests) return b.totalRequests - a.totalRequests;
      if (b.uniquePassengers !== a.uniquePassengers) return b.uniquePassengers - a.uniquePassengers;
      return a.firstRequestAt.getTime() - b.firstRequestAt.getTime();
    });
  }

  private async loadPassengers(): Promise<PassengerRow[]> {
    const [leads, appRows] = await Promise.all([
      this.prisma.landingRouteLead.findMany({ where: { isDeleted: false } }),
      this.prisma.routeRequest.findMany({
        where: { isDeleted: false },
        include: { user: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const landing: PassengerRow[] = leads.map((l) => {
      const from = `${l.fromRegion}، ${l.fromCity}`;
      const to = `${l.toRegion}، ${l.toCity}`;
      return {
        id: l.id,
        source: 'landing',
        passengerName: null,
        phone: l.phone,
        from,
        to,
        workOrUniversity: l.usageReason,
        preferredDepartureTime: l.fromTime,
        preferredReturnTime: l.toTime,
        days: l.usageDays,
        leadStatus: 'lead',
        isConfirmed: false,
        createdAt: l.createdAt,
        routeKey: buildRouteKey(normalizeLocation(from), normalizeLocation(to)),
      };
    });

    const app: PassengerRow[] = appRows.map((r) => {
      const notes = parseRouteRequestNotes(r.notes);
      const from = r.fromAddress;
      const to = r.toAddress;
      return {
        id: r.id,
        source: 'app',
        passengerName: r.user.fullName ?? null,
        phone: r.user.phone,
        from,
        to,
        workOrUniversity: notes.usageReason,
        preferredDepartureTime: notes.fromTime,
        preferredReturnTime: notes.toTime,
        days: notes.usageDays,
        preferredVehicleType: r.preferredVehicleType,
        leadStatus: r.status,
        isConfirmed: r.status === 'approved' || r.status === 'converted',
        createdAt: r.createdAt,
        routeKey: buildRouteKey(normalizeLocation(from), normalizeLocation(to)),
      };
    });

    return [...landing, ...app].filter((p) => p.routeKey);
  }

  private async attachReadiness(groups: DemandGroup[]) {
    if (!groups.length) return;
    const asOf = utcNow();
    const routes = await this.prisma.route.findMany({
      where: { isDeleted: false, isActive: true },
      select: { id: true, name: true },
    });
    const routeByKey = buildRouteKeyIndex(routes);
    const activeIds = new Set(routes.map((r) => r.id));
    const names = new Map(routes.map((r) => [r.id, r.name]));

    const fleet = await this.prisma.vehicle.groupBy({
      by: ['type'],
      where: { isDeleted: false, isActive: true, capacity: { gt: 0 } },
      _max: { capacity: true },
    });
    const capacityByType = new Map(fleet.map((row) => [row.type, row._max.capacity ?? 0]));

    const pricingRules = await this.prisma.pricingRule.findMany({
      where: {
        isDeleted: false,
        isActive: true,
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }],
      },
    });
    const effectiveRules = pricingRules.filter((r) => !r.effectiveTo || r.effectiveTo >= asOf);

    for (const group of groups) {
      const link = resolveRouteLink(group.mappedRouteId, group.routeKey, activeIds, routeByKey);
      const vehicleType = resolveVehicleType(group);
      let capacity: number | null = null;
      if (vehicleType != null) {
        const fleetCap = capacityByType.get(vehicleType) ?? 0;
        capacity = fleetCap > 0 ? fleetCap : DEFAULT_CAPACITY[vehicleType] ?? null;
      }

      let rule: (typeof effectiveRules)[number] | null = null;
      let pricingSource: string | null = null;
      let commissionPct: number | null = null;
      let commissionType: string | null = null;
      let launchStart: Date | null = null;
      let launchEnd: Date | null = null;
      let launchActive: boolean | null = null;
      let launchDays: number | null = null;

      if (link.routeSafe && link.routeId && vehicleType != null) {
        rule = pickPricingRule(effectiveRules, link.routeId, vehicleType);
        if (rule) {
          pricingSource = rule.routeId === link.routeId ? 'ROUTE_VEHICLE' : 'VEHICLE_DEFAULT';
          launchStart = rule.launchStartAt ?? rule.effectiveFrom ?? rule.createdAt;
          launchDays = rule.launchPeriodDays;
          launchEnd =
            launchDays > 0 && launchStart
              ? new Date(launchStart.getTime() + launchDays * 86_400_000)
              : null;
          const launchPct = toNumber(rule.launchCommissionPercent) ?? 0;
          const permPct = toNumber(rule.permanentCommissionPercent) ?? 0;
          launchActive = !!(launchDays > 0 && launchEnd && asOf < launchEnd);
          commissionPct = launchActive ? launchPct : permPct;
          commissionType = launchActive ? 'LAUNCH' : 'PERMANENT';
        }
      }

      const evaluated = evaluateReadiness({
        demandCount: group.totalRequests,
        confirmedPassengers: group.confirmedPassengers,
        uniquePassengers: group.uniquePassengers,
        routeId: link.routeId,
        routeMatchSafe: link.routeSafe,
        vehicleType,
        capacity,
        pricingRuleId: rule?.id ?? null,
        pricingSource,
        oneWayPrice: rule ? toNumber(rule.oneWayPrice) : null,
        roundTripPrice: rule ? toNumber(rule.roundTripPrice) : null,
        weeklyPrice: rule ? toNumber(rule.weeklyPrice) : null,
        monthlyPrice: rule ? toNumber(rule.monthlyPrice) : null,
        minimumLaunchRiders: rule?.minimumLaunchRiders ?? null,
        targetOccupancy: rule?.targetOccupancy ?? null,
        commissionPercent: commissionPct,
        commissionType,
        launchPeriodDays: launchDays,
        launchStartAt: launchStart,
        launchEndAt: launchEnd,
        launchActive,
        ambiguousRouteMatch: link.ambiguous,
      });
      evaluated.routeLinkSource = link.linkSource;
      group.readiness = this.mapReadinessDto(evaluated, names.get(evaluated.routeId ?? ''), group);
    }
  }

  private mapReadinessDto(
    r: ReadinessResult,
    routeName: string | undefined,
    group: DemandGroup,
  ) {
    const demandBandCapacity = group.vehicle.capacity;
    const conflict =
      r.capacity != null && demandBandCapacity > 0 && r.capacity !== demandBandCapacity;
    let reason = r.readinessReason;
    if (conflict) {
      reason += ` · تعارض سعة: تقدير الطلب يعرض ${demandBandCapacity} بينما السعة التشغيلية المعتمدة ${r.capacity}`;
    }
    let mappingCompatibility: string | null = null;
    if (r.routeLinkSource === 'EXPLICIT' && routeName) {
      mappingCompatibility = isExactBidirectionalMatch(group.routeKey, routeName)
        ? 'EXACT_BIDIRECTIONAL'
        : 'MANUAL_OVERRIDE';
      if (mappingCompatibility === 'MANUAL_OVERRIDE') {
        reason += ' · ربط يدوي صريح: لا يوجد تطابق آمن (مفتاح ثنائي الاتجاه) مع اسم المسار.';
      }
    } else if (r.routeLinkSource === 'EXACT_KEY') {
      mappingCompatibility = 'EXACT_BIDIRECTIONAL';
    }

    const capacitySource =
      r.capacity != null
        ? r.vehicleType != null && DEFAULT_CAPACITY[r.vehicleType] === r.capacity
          ? 'DEFAULT_HINT'
          : 'VEHICLE_MASTER'
        : null;

    return {
      routeId: r.routeId,
      routeName: routeName ?? null,
      vehicleType: r.vehicleType != null ? vehicleTypeName(r.vehicleType) : null,
      vehicleTypeName: r.vehicleType != null ? vehicleTypeNameAr(r.vehicleType) : null,
      capacity: r.capacity,
      demandCount: r.demandCount,
      uniquePassengers: r.uniquePassengers,
      confirmedPassengers: r.confirmedPassengers,
      occupancyPercent: r.occupancyPercent,
      minimumLaunchRiders: r.minimumLaunchRiders,
      targetOccupancy: r.targetOccupancy,
      ridersRequired: r.ridersRequired,
      remainingToTarget: r.remainingToTarget,
      pricingAvailable: r.pricingAvailable,
      pricingLinked: r.pricingLinked,
      pricingSource: r.pricingSource,
      oneWayPrice: r.oneWayPrice,
      roundTripPrice: r.roundTripPrice,
      weeklyPrice: r.weeklyPrice,
      monthlyPrice: r.monthlyPrice,
      commissionRate: r.commissionPercent,
      commissionType: r.commissionType,
      launchPeriodDays: r.launchPeriodDays,
      launchStartAt: r.launchStartAt,
      launchEndAt: r.launchEndAt,
      launchActive: r.launchActive,
      financialAtMinimumOneWayGross: r.financialAtMinimumOneWayGross,
      financialAtMinimumRoundTripGross: r.financialAtMinimumRoundTripGross,
      financialAtMinimumPlatformCommission: r.financialAtMinimumPlatformCommission,
      financialAtMinimumCaptainEarnings: r.financialAtMinimumCaptainEarnings,
      launchStatus: toApiStatus(r.launchStatus),
      reasonCode: r.reasonCode,
      readinessReason: reason,
      pricingRuleId: r.pricingRuleId,
      lastUpdatedAt: group.lastRequestAt,
      demandBandCapacity: demandBandCapacity > 0 ? demandBandCapacity : null,
      capacitySource,
      hasCapacityConflict: conflict,
      routeLinkSource: r.routeLinkSource,
      mappingCompatibility,
    };
  }

  private applyFilters(groups: DemandGroup[], query: DemandQuery): DemandGroup[] {
    let result = groups;
    const category = query.routeCategory?.trim().toLowerCase();
    if (category === 'daily') {
      result = result.filter((g) => g.routeType === 'daily' || g.routeType === 'university');
    } else if (category === 'weekend') {
      result = result.filter((g) => g.routeType === 'weekend');
    }
    if (query.routeType) {
      const routeType = query.routeType.trim().toLowerCase();
      result = result.filter((g) => g.routeType === routeType);
    }
    if (query.from) {
      const from = normalizeLocation(query.from);
      result = result.filter(
        (g) =>
          normalizeLocation(g.endpointA).includes(from) ||
          normalizeLocation(g.endpointB).includes(from),
      );
    }
    if (query.to) {
      const to = normalizeLocation(query.to);
      result = result.filter(
        (g) =>
          normalizeLocation(g.endpointA).includes(to) ||
          normalizeLocation(g.endpointB).includes(to),
      );
    }
    if (query.vehicleType) {
      const vehicle = query.vehicleType.trim().toLowerCase();
      result = result.filter((g) => mapVehicleFilter(g.vehicle.code) === vehicle);
    }
    if (query.priority) {
      const priority = query.priority.trim().toLowerCase();
      result = result.filter((g) => calculatePriority(g.totalRequests) === priority);
    }
    if (query.status) {
      const status = query.status.trim().toLowerCase();
      result = result.filter((g) => g.status === status);
    }
    if (query.search) {
      const term = normalizeLocation(query.search);
      result = result.filter(
        (g) =>
          normalizeLocation(g.routeLabel).includes(term) ||
          normalizeLocation(g.endpointA).includes(term) ||
          normalizeLocation(g.endpointB).includes(term),
      );
    }
    if (query.createdFrom) {
      const fromDate = new Date(query.createdFrom);
      if (!Number.isNaN(fromDate.getTime())) {
        result = result.filter((g) => g.lastRequestAt >= fromDate);
      }
    }
    if (query.createdTo) {
      const toDate = new Date(query.createdTo);
      if (!Number.isNaN(toDate.getTime())) {
        result = result.filter((g) => g.firstRequestAt <= toDate);
      }
    }
    if (query.launchStatus) {
      const launch = query.launchStatus.trim().toUpperCase();
      result = result.filter(
        (g) =>
          g.readiness &&
          String((g.readiness as { launchStatus?: string }).launchStatus).toUpperCase() === launch,
      );
    }
    if (query.pricingAvailable === 'true' || query.pricingAvailable === 'false') {
      const ok = query.pricingAvailable === 'true';
      result = result.filter(
        (g) => g.readiness && (g.readiness as { pricingAvailable?: boolean }).pricingAvailable === ok,
      );
    }
    if (query.readyToLaunch === 'true') {
      result = result.filter(
        (g) =>
          g.readiness &&
          String((g.readiness as { launchStatus?: string }).launchStatus).toUpperCase() === 'READY',
      );
    }
    return result;
  }

  private toRow(group: DemandGroup, rank: number) {
    return {
      rank,
      routeKey: group.routeKey,
      routeLabel: group.routeLabel,
      endpointA: group.endpointA,
      endpointB: group.endpointB,
      totalRequests: group.totalRequests,
      confirmedPassengers: group.confirmedPassengers,
      uniquePassengers: group.uniquePassengers,
      recommendedVehicle: group.vehicle.label,
      vehicleCapacity: group.vehicle.capacity,
      remainingSeats: Math.max(0, group.vehicle.capacity - group.totalRequests),
      capacityExceeded: group.vehicle.capacityExceeded,
      priority: calculatePriority(group.totalRequests),
      status: group.status,
      routeType: group.routeType,
      firstRequestAt: group.firstRequestAt,
      lastRequestAt: group.lastRequestAt,
      assignedDriverId: group.assignedDriverId,
      assignedDriverName: group.assignedDriverName,
      readiness: group.readiness,
    };
  }

  private toDetails(group: DemandGroup) {
    const remaining = Math.max(0, group.vehicle.capacity - group.totalRequests);
    const capacityPercent =
      group.vehicle.capacity <= 0
        ? 0
        : Math.round((group.totalRequests * 1000) / group.vehicle.capacity) / 10;
    const launch = buildLaunchRecommendation(group);
    const days = group.passengers
      .flatMap((p) => (p.days || '').split(',').map((d) => d.trim()).filter(Boolean))
      .reduce<Record<string, number>>((acc, day) => {
        acc[day] = (acc[day] ?? 0) + 1;
        return acc;
      }, {});
    const times = group.passengers
      .map((p) => p.preferredDepartureTime)
      .filter((t): t is string => !!t)
      .reduce<Record<string, number>>((acc, time) => {
        acc[time] = (acc[time] ?? 0) + 1;
        return acc;
      }, {});

    return {
      ...this.toRow(group, 0),
      capacityPercent,
      remainingSeats: remaining,
      launchRecommendation: launch.title,
      launchReason: launch.reason,
      nextAction: launch.nextAction,
      captain: group.captain,
      passengers: group.passengers
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(toPassengerDto),
      preferredDepartureTimes: Object.entries(times)
        .map(([time, passengerCount]) => ({ time, passengerCount }))
        .sort((a, b) => b.passengerCount - a.passengerCount),
      workDays: Object.entries(days)
        .map(([day, passengerCount]) => ({ day, passengerCount }))
        .sort((a, b) => b.passengerCount - a.passengerCount),
    };
  }

  private toLaunchPlan(group: DemandGroup) {
    const r = group.readiness as Record<string, unknown>;
    const apiStatus = String(r.launchStatus || 'UNKNOWN');
    const enumStatus = apiToEnum(apiStatus);
    let reasonCode = String(r.reasonCode || '');
    let reason = String(r.readinessReason || '');
    const demand = Number(r.demandCount ?? group.totalRequests);
    const capacity = (r.capacity as number | null) ?? null;
    if (capacity != null && capacity > 0 && demand > capacity) {
      reasonCode = ReasonCodes.DemandExceedsCapacity;
      reason = `الطلب (${demand}) يتجاوز السعة (${capacity}). ${reason}`;
    }
    let planningStatus = toPlanningStatus(enumStatus, reasonCode, demand, capacity);
    let expectedSeats: number | null = null;
    let gross: number | null = null;
    let platform: number | null = null;
    let captain: number | null = null;
    let pricePerSeat: number | null = null;
    let isEstimate = false;
    const oneWay = r.oneWayPrice as number | null;
    const target = r.targetOccupancy as number | null;
    const commissionPct = r.commissionRate as number | null;
    if (demand > 0 && r.pricingAvailable && oneWay != null && target != null && target > 0 && commissionPct != null) {
      expectedSeats = target;
      pricePerSeat = oneWay;
      gross = normalizeMoney(oneWay * target);
      const split = splitFromPercent(gross, commissionPct);
      platform = split.platform;
      captain = split.captain;
      isEstimate = true;
    }
    return {
      routeKey: group.routeKey,
      routeId: r.routeId ?? null,
      routeLabel: group.routeLabel,
      from: group.endpointA,
      to: group.endpointB,
      demand,
      uniquePassengers: r.uniquePassengers ?? group.uniquePassengers,
      confirmed: r.confirmedPassengers ?? group.confirmedPassengers,
      remainingDemand: capacity != null ? Math.max(capacity - demand, 0) : null,
      vehicleType: r.vehicleType ?? null,
      vehicleDisplayName: r.vehicleTypeName ?? null,
      capacity,
      capacitySource: r.capacitySource ?? null,
      pricingAvailable: !!r.pricingAvailable,
      pricingLinked: !!r.pricingLinked,
      pricingRuleId: r.pricingRuleId ?? null,
      pricingSource: r.pricingSource ?? null,
      oneWayPrice: r.oneWayPrice ?? null,
      roundTripPrice: r.roundTripPrice ?? null,
      weeklyPrice: r.weeklyPrice ?? null,
      monthlyPrice: r.monthlyPrice ?? null,
      launchStatus: planningStatus,
      reasonCode,
      readinessReason: reason,
      minimumLaunchRiders: r.minimumLaunchRiders ?? null,
      targetOccupancy: r.targetOccupancy ?? null,
      requiredRiders: r.minimumLaunchRiders ?? null,
      remainingRiders: r.ridersRequired ?? null,
      currentOccupancy: r.confirmedPassengers ?? null,
      occupancyPercentage: r.occupancyPercent ?? occupancyFromConfirmed(group.confirmedPassengers, capacity),
      expectedSeats,
      pricePerSeat,
      estimatedGrossRevenue: gross,
      estimatedPlatformCommission: platform,
      estimatedCaptainEarnings: captain,
      commissionRate: r.commissionRate ?? null,
      commissionType: r.commissionType ?? null,
      isEstimate,
    };
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
          mappedAt: data.mappedAt === undefined ? existing.mappedAt : data.mappedAt,
          mappedByUserId:
            data.mappedByUserId === undefined ? existing.mappedByUserId : data.mappedByUserId,
          updatedAt: utcNow(),
          isDeleted: false,
        },
      });
    }
    return this.prisma.routeDemandGroupState.create({
      data: {
        id: newId(),
        routeKey,
        status: data.status ?? 'new_demand',
        assignedDriverId: data.assignedDriverId ?? null,
        mappedRouteId: data.mappedRouteId ?? null,
        mappedAt: data.mappedAt ?? null,
        mappedByUserId: data.mappedByUserId ?? null,
        ...baseFields(),
      },
    });
  }
}

function parseRouteRequestNotes(notes?: string | null) {
  if (!notes?.trim()) {
    return { fromTime: null, toTime: null, usageDays: null, usageReason: null };
  }
  try {
    const root = JSON.parse(notes) as Record<string, unknown>;
    const read = (...names: string[]) => {
      for (const name of names) {
        const value = root[name];
        if (typeof value === 'string' && value.trim()) return value;
      }
      return null;
    };
    return {
      fromTime: read('FromTime', 'fromTime'),
      toTime: read('ToTime', 'toTime'),
      usageDays: read('UsageDays', 'usageDays'),
      usageReason: read('UsageReason', 'usageReason'),
    };
  } catch {
    return { fromTime: null, toTime: null, usageDays: null, usageReason: notes };
  }
}

function resolveEndpointLabels(samples: PassengerRow[]) {
  if (!samples.length) return { a: '—', b: '—' };
  const labels = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values.filter(Boolean)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
  };
  const normalized = [
    ...new Set(
      samples.flatMap((s) => [normalizeLocation(s.from), normalizeLocation(s.to)]).filter(Boolean),
    ),
  ].sort();
  const pick = (target: string) =>
    labels(
      samples.flatMap((s) => [
        normalizeLocation(s.from) === target ? s.from : '',
        normalizeLocation(s.to) === target ? s.to : '',
      ]),
    );
  if (normalized.length >= 2) {
    return { a: pick(normalized[0]), b: pick(normalized[1]) };
  }
  return { a: labels(samples.map((s) => s.from)), b: labels(samples.map((s) => s.to)) };
}

function recommendVehicle(demand: number) {
  if (demand <= 3) return { code: 'shuttlez_car', label: 'Shuttlez Car', capacity: 3, capacityExceeded: false };
  if (demand <= 12) return { code: 'microbus', label: 'Microbus', capacity: 13, capacityExceeded: false };
  if (demand <= 32) return { code: 'mini_bus', label: 'Mini Bus', capacity: 33, capacityExceeded: false };
  return { code: 'capacity_exceeded', label: 'Capacity exceeded', capacity: 33, capacityExceeded: true };
}

function inferDominantRouteType(samples: PassengerRow[]) {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const type = classifyRouteType(sample.workOrUniversity);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
}

function classifyRouteType(usageReason?: string | null) {
  const value = normalizeLocation(usageReason);
  if (!value) return 'other';
  if (value.includes('محاف') || value.includes('governorate') || value.includes('weekend') || value.includes('اجاز') || value.includes('نهاية')) {
    return 'weekend';
  }
  if (value.includes('جام') || value.includes('كلية') || value.includes('university') || value.includes('college')) {
    return 'university';
  }
  if (value.includes('عمل') || value.includes('work') || value.includes('دوام') || value.includes('office')) {
    return 'daily';
  }
  return 'other';
}

function calculatePriority(demand: number) {
  if (demand >= 6) return 'high';
  if (demand >= 3) return 'medium';
  return 'low';
}

function mapVehicleFilter(code: string) {
  if (code === 'shuttlez_car') return 'shuttlez';
  if (code === 'microbus') return 'microbus';
  if (code === 'mini_bus') return 'minibus';
  return code;
}

function buildLaunchRecommendation(group: DemandGroup) {
  if (group.vehicle.capacityExceeded) {
    return {
      title: 'Split route or use larger fleet',
      reason: `${group.totalRequests} passengers exceed recommended vehicle capacity.`,
      nextAction: 'Review fleet assignment or split into multiple trips.',
    };
  }
  if (group.totalRequests >= 6) {
    return {
      title: 'Recommended to prepare for launch',
      reason: `${group.totalRequests} passengers requested this route.`,
      nextAction: 'Find suitable captain and confirm passengers.',
    };
  }
  if (group.totalRequests >= 3) {
    return {
      title: 'Collecting more demand',
      reason: `${group.totalRequests} requests so far — keep promoting this corridor.`,
      nextAction: 'Continue collecting passengers before assigning a captain.',
    };
  }
  return {
    title: 'Early demand signal',
    reason: `${group.totalRequests} request(s) recorded for this corridor.`,
    nextAction: 'Monitor demand growth before operational planning.',
  };
}

function toPassengerDto(p: PassengerRow) {
  return {
    id: p.id,
    source: p.source,
    passengerName: p.passengerName,
    phone: p.phone,
    from: p.from,
    to: p.to,
    workOrUniversity: p.workOrUniversity,
    preferredDepartureTime: p.preferredDepartureTime,
    preferredReturnTime: p.preferredReturnTime,
    days: p.days,
    leadStatus: p.leadStatus,
    isConfirmed: p.isConfirmed,
    createdAt: p.createdAt,
  };
}

function buildRouteKeyIndex(routes: Array<{ id: string; name: string }>) {
  const map = new Map<string, string[]>();
  for (const route of routes) {
    for (const key of deriveRouteKeys(route.name)) {
      const list = map.get(key) ?? [];
      if (!list.includes(route.id)) list.push(route.id);
      map.set(key, list);
    }
  }
  return map;
}

function resolveRouteLink(
  explicitMappedRouteId: string | null,
  routeKey: string,
  activeRouteIds: Set<string>,
  routeByKey: Map<string, string[]>,
) {
  if (explicitMappedRouteId) {
    if (activeRouteIds.has(explicitMappedRouteId)) {
      return { routeId: explicitMappedRouteId, routeSafe: true, ambiguous: false, linkSource: 'EXPLICIT' };
    }
    return { routeId: null, routeSafe: false, ambiguous: false, linkSource: null };
  }
  const matches = routeByKey.get(routeKey) ?? [];
  if (matches.length === 1) {
    return { routeId: matches[0], routeSafe: true, ambiguous: false, linkSource: 'EXACT_KEY' };
  }
  if (matches.length > 1) {
    return { routeId: null, routeSafe: false, ambiguous: true, linkSource: null };
  }
  return { routeId: null, routeSafe: false, ambiguous: false, linkSource: null };
}

function isExactBidirectionalMatch(demandRouteKey: string, routeName: string) {
  return deriveRouteKeys(routeName).includes(demandRouteKey);
}

function resolveVehicleType(group: DemandGroup): number | null {
  const assigned = tryParseVehicleType(group.captain?.vehicleType);
  if (assigned != null) return assigned;
  const prefs = group.passengers
    .map((p) => tryParseVehicleType(p.preferredVehicleType))
    .filter((t): t is number => t != null);
  if (prefs.length) {
    const counts = new Map<number, number>();
    for (const pref of prefs) counts.set(pref, (counts.get(pref) ?? 0) + 1);
    const [topType, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (counts.size === 1 || topCount > prefs.length / 2) return topType;
  }
  return tryParseVehicleType(group.vehicle.code);
}

function pickPricingRule(
  rules: Prisma.PricingRuleGetPayload<object>[],
  routeId: string,
  vehicleType: number,
) {
  const forVehicle = rules.filter((r) => r.vehicleType === vehicleType);
  return (
    pickLatest(forVehicle.filter((r) => r.routeId === routeId)) ??
    pickLatest(forVehicle.filter((r) => r.routeId == null))
  );
}

function pickLatest<T extends { effectiveFrom: Date | null }>(rules: T[]): T | null {
  return (
    [...rules].sort(
      (a, b) => (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0),
    )[0] ?? null
  );
}

function vehicleTypeName(type: number) {
  switch (type) {
    case VehicleType.MiniBus:
      return 'MiniBus';
    case VehicleType.Bus:
      return 'Bus';
    default:
      return 'CarShuttle';
  }
}

function vehicleTypeNameAr(type: number) {
  switch (type) {
    case VehicleType.MiniBus:
      return 'ميكروباص';
    case VehicleType.Bus:
      return 'أتوبيس';
    default:
      return 'سيارة شاتلز';
  }
}

function vehicleDisplayName(type: number) {
  switch (type) {
    case VehicleType.MiniBus:
      return 'Microbus';
    case VehicleType.Bus:
      return 'Bus';
    default:
      return 'Shuttlez Car';
  }
}

function apiToEnum(api: string): DemandLaunchStatus {
  switch (api) {
    case 'READY':
      return 'Ready';
    case 'ALMOST_READY':
      return 'AlmostReady';
    case 'NOT_READY':
      return 'NotReady';
    case 'NO_PRICING':
      return 'NoPricing';
    case 'MISSING_CONFIGURATION':
      return 'MissingConfiguration';
    default:
      return 'Unknown';
  }
}

function toPlanningStatus(
  status: DemandLaunchStatus,
  reasonCode: string,
  demand: number,
  capacity: number | null,
) {
  if (reasonCode === ReasonCodes.AmbiguousRouteMatch) return 'DATA_INCOMPLETE';
  if (
    capacity != null &&
    capacity > 0 &&
    demand > capacity &&
    (status === 'Ready' || status === 'AlmostReady')
  ) {
    return 'FULL';
  }
  switch (status) {
    case 'Ready':
      return 'READY_TO_LAUNCH';
    case 'AlmostReady':
      return 'ALMOST_READY';
    case 'NotReady':
      return 'COLLECTING_DEMAND';
    case 'NoPricing':
      return 'PRICING_NOT_CONFIGURED';
    case 'MissingConfiguration':
      return 'DATA_INCOMPLETE';
    case 'Unknown':
      if (reasonCode === ReasonCodes.MissingVehicle || reasonCode === ReasonCodes.MissingCapacity) {
        return 'NO_VEHICLE_CONFIG';
      }
      return 'DATA_INCOMPLETE';
    default:
      return 'DATA_INCOMPLETE';
  }
}

function planningSortRank(status: string) {
  switch (status) {
    case 'READY_TO_LAUNCH':
      return 1;
    case 'ALMOST_READY':
      return 2;
    case 'FULL':
      return 3;
    case 'COLLECTING_DEMAND':
      return 4;
    case 'PRICING_NOT_CONFIGURED':
      return 5;
    case 'DATA_INCOMPLETE':
      return 6;
    case 'NO_VEHICLE_CONFIG':
      return 7;
    default:
      return 99;
  }
}

function splitFromPercent(total: number, percent: number) {
  const clamped = Math.min(100, Math.max(0, percent));
  const platform = normalizeMoney((total * clamped) / 100);
  return { platform, captain: normalizeMoney(total - platform) };
}

function mode(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function minDate(dates: Date[]) {
  return dates.reduce((a, b) => (a < b ? a : b));
}

function maxDate(dates: Date[]) {
  return dates.reduce((a, b) => (a > b ? a : b));
}
