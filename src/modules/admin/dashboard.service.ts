import { Injectable, Scope } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  BookingStatus,
  GroupRequestStatus,
  RideRequestStatus,
  TripStatus,
} from '../../common/enums';
import { money, normalizeMoney } from '../../common/utils/money';
import { bookingStatusLabel, tripStatusLabel } from '../../common/utils/enums-map';
import {
  DashboardWindow,
  getDashboardWindow,
  tripsSoonListQuery,
  upcomingHoursRange,
} from '../../common/utils/operational-clock';
import {
  confirmedBookingWhere,
  completedTripsInPeriodWhere,
  groupsNeedingCaptainWhere,
  NEEDS_CAPTAIN_STATUSES,
  occupancyPercent,
  ridesNeedingCaptainWhere,
  upcomingTripsWhere,
  upcomingUnassignedTripsWhere,
} from './operations-metrics';
import { RouteDemandService } from './route-demand/route-demand.service';
import { occupancyFromAggregates } from './management-metrics';

@Injectable({ scope: Scope.REQUEST })
export class AdminDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly routeDemand: RouteDemandService,
  ) {}

  async get(daysInput?: string | number) {
    const now = new Date();
    const window = getDashboardWindow(
      now,
      Number(daysInput) || 30,
      this.config.get<string>('OPERATIONAL_TIMEZONE'),
    );

    const [
      metrics,
      series,
      tripStatusBreakdown,
      bookingStatusBreakdown,
      topRoutes,
      recentActivity,
      operations,
    ] = await Promise.all([
      this.buildMetrics(window, now),
      this.buildSeries(window),
      this.buildTripBreakdown(),
      this.buildBookingBreakdown(),
      this.buildTopRoutes(window),
      this.buildActivity(),
      this.buildOperations(window, now),
    ]);

    return {
      metrics,
      series,
      tripStatusBreakdown,
      bookingStatusBreakdown,
      topRoutes,
      recentActivity,
      operations,
      period: {
        timeZone: window.timeZone,
        days: window.days,
        currentStart: window.currentStart,
        currentEnd: window.currentEnd,
        previousStart: window.previousStart,
        previousEnd: window.previousEnd,
        todayStart: window.todayStart,
        todayEnd: window.todayEnd,
        todayKey: window.currentDays[window.currentDays.length - 1]?.key ?? null,
        tripPerformanceField: 'Trip.scheduledAt',
        bookingRevenueField: 'Booking.createdAt',
      },
    };
  }

  private async buildMetrics(window: DashboardWindow, now: Date) {
    const users = { isDeleted: false } as const;
    const confirmedCurrent = {
      ...confirmedBookingWhere,
      createdAt: { gte: window.currentStart, lt: window.currentEnd },
    };
    const confirmedPrevious = {
      ...confirmedBookingWhere,
      createdAt: { gte: window.previousStart, lt: window.previousEnd },
    };
    const [
      totalUsers,
      newUsers,
      previousNewUsers,
      totalDrivers,
      onlineDrivers,
      activeRoutes,
      totalRoutes,
      upcomingTrips,
      completedTrips,
      totalBookings,
      confirmedBookings,
      previousConfirmedBookings,
      revenueAgg,
      previousRevenueAgg,
      openTickets,
      pendingRequests,
      landingLeads,
      waitlist,
      captainLeads,
      avgRating,
      walletBalance,
    ] = await Promise.all([
      this.prisma.user.count({ where: users }),
      this.prisma.user.count({
        where: { ...users, createdAt: { gte: window.currentStart, lt: window.currentEnd } },
      }),
      this.prisma.user.count({
        where: { ...users, createdAt: { gte: window.previousStart, lt: window.previousEnd } },
      }),
      this.prisma.driver.count({ where: { isDeleted: false } }),
      this.prisma.driver.count({ where: { isDeleted: false, isOnline: true } }),
      this.prisma.route.count({ where: { isDeleted: false, isActive: true } }),
      this.prisma.route.count({ where: { isDeleted: false } }),
      this.prisma.trip.count({
        where: upcomingTripsWhere(now),
      }),
      this.prisma.trip.count({ where: { isDeleted: false, status: TripStatus.Completed } }),
      this.prisma.booking.count({ where: { isDeleted: false } }),
      this.prisma.booking.count({ where: confirmedCurrent }),
      this.prisma.booking.count({ where: confirmedPrevious }),
      this.prisma.booking.aggregate({
        where: confirmedCurrent,
        _sum: { totalAmount: true },
      }),
      this.prisma.booking.aggregate({
        where: confirmedPrevious,
        _sum: { totalAmount: true },
      }),
      this.prisma.supportTicket.count({
        where: { isDeleted: false, status: { not: 'closed' } },
      }),
      this.prisma.routeRequest.count({ where: { isDeleted: false, status: 'pending' } }),
      this.prisma.landingRouteLead.count({ where: { isDeleted: false } }),
      this.prisma.landingWaitlistEntry.count({ where: { isDeleted: false } }),
      this.prisma.landingCaptainLead.count({ where: { isDeleted: false } }),
      this.prisma.review.aggregate({
        where: { isDeleted: false },
        _avg: { stars: true },
      }),
      this.prisma.wallet.aggregate({
        where: { isDeleted: false },
        _sum: { balance: true },
      }),
    ]);

    return [
      metric(
        'revenue',
        'إيراد الشاتل المؤكد',
        moneyAmount(revenueAgg._sum.totalAmount),
        moneyAmount(previousRevenueAgg._sum.totalAmount),
        'currency',
      ),
      metric('bookings', 'حجوزات مؤكدة', confirmedBookings, previousConfirmedBookings, 'number'),
      metric('newUsers', 'مستخدمون جدد', newUsers, previousNewUsers, 'number'),
      metric('totalUsers', 'إجمالي المستخدمين', totalUsers, null, 'number'),
      metric('totalBookings', 'إجمالي الحجوزات', totalBookings, null, 'number'),
      metric('upcomingTrips', 'رحلات قادمة (موعدها ≥ الآن)', upcomingTrips, null, 'number'),
      metric('completedTrips', 'رحلات مكتملة', completedTrips, null, 'number'),
      metric('activeRoutes', 'خطوط نشطة', activeRoutes, totalRoutes, 'number'),
      metric('drivers', 'الكباتن', totalDrivers, onlineDrivers, 'number'),
      metric('onlineDrivers', 'كباتن متصلون', onlineDrivers, null, 'number'),
      metric('openTickets', 'تذاكر مفتوحة', openTickets, null, 'number'),
      metric('pendingRequests', 'طلبات خطوط معلّقة', pendingRequests, null, 'number'),
      metric('leads', 'عملاء محتملون', landingLeads + waitlist + captainLeads, null, 'number'),
      metric(
        'avgRating',
        'متوسط التقييم',
        Math.round((avgRating._avg.stars ?? 0) * 100) / 100,
        null,
        'rating',
      ),
      metric(
        'walletBalance',
        'أرصدة المحافظ',
        moneyAmount(walletBalance._sum.balance),
        null,
        'currency',
      ),
    ];
  }

  private async buildSeries(window: DashboardWindow) {
    const [bookingRows, userRows, tripRows, completedRows, seatRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ day: string; count: bigint | number; revenue: unknown }>>(
        Prisma.sql`
          SELECT
            to_char(b."CreatedAt" AT TIME ZONE ${window.timeZone}, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count,
            COALESCE(SUM(b."TotalAmount"), 0) AS revenue
          FROM "BookingsSet" b
          WHERE b."IsDeleted" = false
            AND b."Status" = ${BookingStatus.Confirmed}
            AND b."CreatedAt" >= ${window.currentStart}
            AND b."CreatedAt" < ${window.currentEnd}
          GROUP BY 1
        `,
      ),
      this.prisma.$queryRaw<Array<{ day: string; count: bigint | number }>>(
        Prisma.sql`
          SELECT
            to_char(u."CreatedAt" AT TIME ZONE ${window.timeZone}, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count
          FROM "UsersSet" u
          WHERE u."IsDeleted" = false
            AND u."CreatedAt" >= ${window.currentStart}
            AND u."CreatedAt" < ${window.currentEnd}
          GROUP BY 1
        `,
      ),
      this.prisma.$queryRaw<Array<{ day: string; count: bigint | number }>>(
        Prisma.sql`
          SELECT
            to_char(t."ScheduledAt" AT TIME ZONE ${window.timeZone}, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count
          FROM "TripsSet" t
          WHERE t."IsDeleted" = false
            AND t."ScheduledAt" >= ${window.currentStart}
            AND t."ScheduledAt" < ${window.currentEnd}
          GROUP BY 1
        `,
      ),
      this.prisma.$queryRaw<Array<{ day: string; count: bigint | number }>>(
        Prisma.sql`
          SELECT
            to_char(t."ScheduledAt" AT TIME ZONE ${window.timeZone}, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count
          FROM "TripsSet" t
          WHERE t."IsDeleted" = false
            AND t."Status" = ${TripStatus.Completed}
            AND t."ScheduledAt" >= ${window.currentStart}
            AND t."ScheduledAt" < ${window.currentEnd}
          GROUP BY 1
        `,
      ),
      this.prisma.$queryRaw<Array<{ day: string; seats: bigint | number }>>(
        Prisma.sql`
          SELECT
            to_char(b."CreatedAt" AT TIME ZONE ${window.timeZone}, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(b."SeatCount"), 0)::int AS seats
          FROM "BookingsSet" b
          WHERE b."IsDeleted" = false
            AND b."Status" = ${BookingStatus.Confirmed}
            AND b."CreatedAt" >= ${window.currentStart}
            AND b."CreatedAt" < ${window.currentEnd}
          GROUP BY 1
        `,
      ),
    ]);

    const bookingsByDay = new Map(
      bookingRows.map((row) => [
        row.day,
        { count: Number(row.count), revenue: moneyAmount(row.revenue) },
      ]),
    );
    const usersByDay = new Map(userRows.map((row) => [row.day, Number(row.count)]));
    const tripsByDay = new Map(tripRows.map((row) => [row.day, Number(row.count)]));
    const completedByDay = new Map(completedRows.map((row) => [row.day, Number(row.count)]));
    const seatsByDay = new Map(seatRows.map((row) => [row.day, Number(row.seats)]));

    return [
      {
        key: 'revenue',
        label: 'إيراد الشاتل المؤكد',
        points: window.currentDays.map((day) => ({
          date: day.start,
          value: bookingsByDay.get(day.key)?.revenue ?? 0,
        })),
      },
      {
        key: 'bookings',
        label: 'حجوزات مؤكدة',
        points: window.currentDays.map((day) => ({
          date: day.start,
          value: bookingsByDay.get(day.key)?.count ?? 0,
        })),
      },
      {
        key: 'newUsers',
        label: 'مستخدمون جدد',
        points: window.currentDays.map((day) => ({
          date: day.start,
          value: usersByDay.get(day.key) ?? 0,
        })),
      },
      {
        key: 'trips',
        label: 'الرحلات',
        points: window.currentDays.map((day) => ({
          date: day.start,
          value: tripsByDay.get(day.key) ?? 0,
        })),
      },
      {
        key: 'completedTrips',
        label: 'الرحلات المكتملة',
        points: window.currentDays.map((day) => ({
          date: day.start,
          value: completedByDay.get(day.key) ?? 0,
        })),
      },
      {
        key: 'confirmedSeats',
        label: 'المقاعد المؤكدة',
        points: window.currentDays.map((day) => ({
          date: day.start,
          value: seatsByDay.get(day.key) ?? 0,
        })),
      },
    ];
  }

  private async buildTripBreakdown() {
    const rows = await this.prisma.trip.groupBy({
      by: ['status'],
      where: { isDeleted: false },
      _count: { _all: true },
    });
    return rows
      .map((row) => ({
        label: tripStatusLabel(row.status).toLowerCase(),
        value: row._count._all,
      }))
      .sort((a, b) => b.value - a.value);
  }

  private async buildBookingBreakdown() {
    const rows = await this.prisma.booking.groupBy({
      by: ['status'],
      where: { isDeleted: false },
      _count: { _all: true },
    });
    return rows
      .map((row) => ({
        label: bookingStatusLabel(row.status).toLowerCase(),
        value: row._count._all,
      }))
      .sort((a, b) => b.value - a.value);
  }

  private async buildTopRoutes(window: DashboardWindow) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        routeId: string;
        name: string;
        tripCount: bigint | number;
        confirmedBookingCount: bigint | number;
        confirmedSeatCount: bigint | number;
        confirmedRevenue: unknown;
        remainingSeats: bigint | number;
        completedTripCount: bigint | number;
      }>
    >(Prisma.sql`
      WITH trip_stats AS (
        SELECT
          t."Id",
          t."RouteId",
          t."AvailableSeats",
          t."Status",
          COALESCE(SUM(CASE
            WHEN b."IsDeleted" = false AND b."Status" = ${BookingStatus.Confirmed}
            THEN b."SeatCount" ELSE 0 END), 0)::int AS confirmed_seats,
          COALESCE(SUM(CASE
            WHEN b."IsDeleted" = false AND b."Status" = ${BookingStatus.Confirmed}
            THEN b."TotalAmount" ELSE 0 END), 0) AS confirmed_revenue,
          COALESCE(SUM(CASE
            WHEN b."IsDeleted" = false AND b."Status" = ${BookingStatus.Confirmed}
            THEN 1 ELSE 0 END), 0)::int AS confirmed_bookings
        FROM "TripsSet" t
        LEFT JOIN "BookingsSet" b ON b."TripId" = t."Id"
        WHERE t."IsDeleted" = false
          AND t."ScheduledAt" >= ${window.currentStart}
          AND t."ScheduledAt" < ${window.currentEnd}
        GROUP BY t."Id", t."RouteId", t."AvailableSeats", t."Status"
      )
      SELECT
        r."Id" AS "routeId",
        r."Name" AS name,
        COALESCE(COUNT(ts."Id"), 0)::int AS "tripCount",
        COALESCE(SUM(ts.confirmed_bookings), 0)::int AS "confirmedBookingCount",
        COALESCE(SUM(ts.confirmed_seats), 0)::int AS "confirmedSeatCount",
        COALESCE(SUM(ts.confirmed_revenue), 0) AS "confirmedRevenue",
        COALESCE(SUM(ts."AvailableSeats"), 0)::int AS "remainingSeats",
        COALESCE(SUM(CASE WHEN ts."Status" = ${TripStatus.Completed} THEN 1 ELSE 0 END), 0)::int AS "completedTripCount"
      FROM "RoutesSet" r
      INNER JOIN trip_stats ts ON ts."RouteId" = r."Id"
      WHERE r."IsDeleted" = false
      GROUP BY r."Id", r."Name"
      ORDER BY r."Name" ASC
      LIMIT 50
    `);

    return rows.map((row) => {
      const confirmedSeatCount = Number(row.confirmedSeatCount);
      const remainingSeats = Number(row.remainingSeats);
      const confirmedRevenue = moneyAmount(row.confirmedRevenue);
      const confirmedBookingCount = Number(row.confirmedBookingCount);
      return {
        routeId: row.routeId,
        name: row.name,
        tripCount: Number(row.tripCount),
        bookingCount: confirmedBookingCount,
        revenue: confirmedRevenue,
        confirmedBookingCount,
        confirmedSeatCount,
        confirmedRevenue,
        occupancyPercent: occupancyPercent(confirmedSeatCount, remainingSeats),
        completedTripCount: Number(row.completedTripCount),
      };
    });
  }

  private async buildOperations(window: DashboardWindow, now: Date) {
    const periodConfirmed = {
      ...confirmedBookingWhere,
      createdAt: { gte: window.currentStart, lt: window.currentEnd },
    };
    const soonRange = upcomingHoursRange(now, 3);
    const tripsSoonQuery = tripsSoonListQuery(soonRange.gte, soonRange.lt);
    const [
      tripsToday,
      activeTrips,
      upcomingTrips,
      unassignedTrips,
      upcomingUnassignedTrips,
      tripsSoon,
      completedTripsInPeriod,
      ridesTotal,
      ridesOpen,
      ridesNeedingCaptain,
      ridesWithCaptain,
      groupsTotal,
      groupsOpen,
      groupsNeedingCaptain,
      groupsWithCaptain,
      todayOccupancy,
      todayConfirmed,
      financial,
      rideFinancial,
      groupFinancial,
      launchSnapshot,
      officialRoutes,
      upcomingAssignedTrips,
      routesWithUpcoming,
      scheduledTripsInPeriod,
      upcomingOccupancy,
      periodOccupancy,
      completedOccupancy,
      periodBookingSeats,
      completedFinance,
    ] = await Promise.all([
      this.prisma.trip.count({
        where: {
          isDeleted: false,
          scheduledAt: { gte: window.todayStart, lt: window.todayEnd },
        },
      }),
      this.prisma.trip.count({
        where: { isDeleted: false, status: TripStatus.InProgress },
      }),
      this.prisma.trip.count({
        where: upcomingTripsWhere(now),
      }),
      this.prisma.trip.count({
        where: {
          isDeleted: false,
          driverId: null,
          status: { in: NEEDS_CAPTAIN_STATUSES },
        },
      }),
      this.prisma.trip.count({
        where: upcomingUnassignedTripsWhere(now),
      }),
      this.prisma.trip.count({
        where: {
          isDeleted: false,
          status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
          scheduledAt: { gte: soonRange.gte, lt: soonRange.lt },
        },
      }),
      this.prisma.trip.count({
        where: completedTripsInPeriodWhere(window.currentStart, window.currentEnd),
      }),
      this.prisma.rideRequest.count({ where: { isDeleted: false } }),
      this.prisma.rideRequest.count({
        where: { isDeleted: false, status: RideRequestStatus.Requested },
      }),
      this.prisma.rideRequest.count({
        where: ridesNeedingCaptainWhere(),
      }),
      this.prisma.rideRequest.count({
        where: { isDeleted: false, driverId: { not: null } },
      }),
      this.prisma.groupRequest.count({ where: { isDeleted: false } }),
      this.prisma.groupRequest.count({
        where: {
          isDeleted: false,
          status: { in: [GroupRequestStatus.Draft, GroupRequestStatus.Confirmed] },
        },
      }),
      this.prisma.groupRequest.count({
        where: groupsNeedingCaptainWhere(),
      }),
      this.prisma.groupRequest.count({
        where: { isDeleted: false, driverId: { not: null } },
      }),
      this.occupancyTotals({
        from: window.todayStart,
        to: window.todayEnd,
      }),
      this.prisma.booking.aggregate({
        where: {
          ...confirmedBookingWhere,
          trip: {
            isDeleted: false,
            scheduledAt: { gte: window.todayStart, lt: window.todayEnd },
          },
        },
        _count: { _all: true },
        _sum: { seatCount: true },
      }),
      this.prisma.booking.aggregate({
        where: periodConfirmed,
        _count: { _all: true },
        _sum: {
          totalAmount: true,
          commissionAmount: true,
          captainEarnings: true,
          seatCount: true,
        },
      }),
      this.prisma.rideRequest.aggregate({
        where: {
          isDeleted: false,
          status: RideRequestStatus.Completed,
          completedAt: { gte: window.currentStart, lt: window.currentEnd },
        },
        _count: { _all: true },
        _sum: {
          totalAmount: true,
          commissionAmount: true,
          captainEarnings: true,
        },
      }),
      this.prisma.groupRequest.aggregate({
        where: {
          isDeleted: false,
          status: GroupRequestStatus.Completed,
          completedAt: { gte: window.currentStart, lt: window.currentEnd },
        },
        _count: { _all: true },
        _sum: {
          totalAmount: true,
          commissionAmount: true,
          captainEarnings: true,
        },
      }),
      this.routeDemand.launchPipelineSnapshot(now),
      this.prisma.route.count({ where: { isDeleted: false } }),
      this.prisma.trip.count({
        where: { ...upcomingTripsWhere(now), driverId: { not: null } },
      }),
      this.prisma.trip.groupBy({
        by: ['routeId'],
        where: upcomingTripsWhere(now),
      }),
      this.prisma.trip.count({
        where: {
          isDeleted: false,
          scheduledAt: { gte: window.currentStart, lt: window.currentEnd },
        },
      }),
      this.occupancyTotals({
        fromNow: now,
        statuses: [TripStatus.Scheduled, TripStatus.DriverAssigned],
      }),
      this.occupancyTotals({
        from: window.currentStart,
        to: window.currentEnd,
      }),
      this.occupancyTotals({
        from: window.currentStart,
        to: window.currentEnd,
        statuses: [TripStatus.Completed],
      }),
      this.prisma.booking.aggregate({
        where: periodConfirmed,
        _sum: { seatCount: true },
      }),
      this.prisma.booking.aggregate({
        where: {
          ...confirmedBookingWhere,
          trip: completedTripsInPeriodWhere(window.currentStart, window.currentEnd),
        },
        _count: { _all: true },
        _sum: {
          totalAmount: true,
          commissionAmount: true,
          captainEarnings: true,
          seatCount: true,
        },
      }),
    ]);

    return {
      tripsToday,
      activeTrips,
      upcomingTrips,
      unassignedTrips,
      upcomingUnassignedTrips,
      upcomingAssignedTrips,
      tripsSoon,
      confirmedBookings: todayConfirmed._count._all,
      confirmedOccupiedSeats: todayConfirmed._sum.seatCount ?? 0,
      averageOccupancy: todayOccupancy.occupancyPercent,
      confirmedRevenue: moneyAmount(financial._sum.totalAmount),
      confirmedCommission: moneyAmount(financial._sum.commissionAmount),
      confirmedCaptainEarnings: moneyAmount(financial._sum.captainEarnings),
      periodConfirmedBookings: financial._count._all,
      periodConfirmedSeats: periodBookingSeats._sum.seatCount ?? 0,
      officialRoutes,
      readyCorridors: launchSnapshot.readyCorridors,
      readyCorridorsWithUpcomingTrip: launchSnapshot.readyCorridorsWithUpcomingTrip,
      corridorsWithoutPricing: launchSnapshot.corridorsWithoutPricing,
      routesWithUpcomingTrip: routesWithUpcoming.length,
      scheduledTripsInPeriod,
      upcomingTripsWithConfirmedSeats: upcomingOccupancy.tripsWithConfirmedSeats,
      upcomingConfirmedSeats: upcomingOccupancy.confirmedSeats,
      upcomingCapacity: upcomingOccupancy.capacity,
      upcomingOccupancyPercent: upcomingOccupancy.occupancyPercent,
      periodConfirmedSeatsOnTrips: periodOccupancy.confirmedSeats,
      periodTripCapacity: periodOccupancy.capacity,
      periodOccupancyPercent: periodOccupancy.occupancyPercent,
      completedConfirmedSeats: completedOccupancy.confirmedSeats,
      completedCapacity: completedOccupancy.capacity,
      completedOccupancyPercent: completedOccupancy.occupancyPercent,
      completedRevenue: moneyAmount(completedFinance._sum.totalAmount),
      completedCommission: moneyAmount(completedFinance._sum.commissionAmount),
      completedCaptainEarnings: moneyAmount(completedFinance._sum.captainEarnings),
      rideCompletedCount: rideFinancial._count._all,
      rideCompletedRevenue: moneyAmount(rideFinancial._sum.totalAmount),
      rideCompletedCommission: moneyAmount(rideFinancial._sum.commissionAmount),
      rideCompletedCaptainEarnings: moneyAmount(rideFinancial._sum.captainEarnings),
      groupCompletedCount: groupFinancial._count._all,
      groupCompletedRevenue: moneyAmount(groupFinancial._sum.totalAmount),
      groupCompletedCommission: moneyAmount(groupFinancial._sum.commissionAmount),
      groupCompletedCaptainEarnings: moneyAmount(groupFinancial._sum.captainEarnings),
      timeZone: window.timeZone,
      tripsSoonHours: 3,
      tripsSoonFrom: tripsSoonQuery.fromDateTime,
      tripsSoonTo: tripsSoonQuery.toDateTime,
      tripsSoonQuery,
      completedTripsInPeriod,
      ridesTotal,
      ridesOpen,
      ridesNeedingCaptain,
      ridesWithCaptain,
      groupsTotal,
      groupsOpen,
      groupsNeedingCaptain,
      groupsWithCaptain,
      readyCorridorsWithoutUpcomingTrip: launchSnapshot.readyCorridorsWithoutUpcomingTrip,
      bookingRevenueField: 'Booking.createdAt',
      tripPerformanceField: 'Trip.scheduledAt',
    };
  }

  private async occupancyTotals(filter: {
    from?: Date;
    to?: Date;
    fromNow?: Date;
    statuses?: number[];
  }) {
    const parts: Prisma.Sql[] = [Prisma.sql`t."IsDeleted" = false`];
    if (filter.from) parts.push(Prisma.sql`t."ScheduledAt" >= ${filter.from}`);
    if (filter.to) parts.push(Prisma.sql`t."ScheduledAt" < ${filter.to}`);
    if (filter.fromNow) parts.push(Prisma.sql`t."ScheduledAt" >= ${filter.fromNow}`);
    if (filter.statuses?.length) {
      parts.push(Prisma.sql`t."Status" IN (${Prisma.join(filter.statuses)})`);
    }
    const rows = await this.prisma.$queryRaw<
      Array<{
        occupied: bigint | number;
        remaining: bigint | number;
        tripCount: bigint | number;
        withConfirmedSeats: bigint | number;
      }>
    >(Prisma.sql`
      SELECT
        COALESCE(SUM(s.occupied), 0) AS occupied,
        COALESCE(SUM(s.remaining), 0) AS remaining,
        COUNT(*)::int AS "tripCount",
        COALESCE(SUM(CASE WHEN s.occupied > 0 THEN 1 ELSE 0 END), 0)::int AS "withConfirmedSeats"
      FROM (
        SELECT
          t."AvailableSeats" AS remaining,
          COALESCE(SUM(CASE
            WHEN b."IsDeleted" = false AND b."Status" = ${BookingStatus.Confirmed}
            THEN b."SeatCount" ELSE 0 END), 0) AS occupied
        FROM "TripsSet" t
        LEFT JOIN "BookingsSet" b ON b."TripId" = t."Id"
        WHERE ${Prisma.join(parts, ' AND ')}
        GROUP BY t."Id", t."AvailableSeats"
      ) s
    `);
    return occupancyFromAggregates(
      Number(rows[0]?.occupied ?? 0),
      Number(rows[0]?.remaining ?? 0),
      Number(rows[0]?.tripCount ?? 0),
      Number(rows[0]?.withConfirmedSeats ?? 0),
    );
  }

  private async buildActivity() {
    const [bookings, users, requests, tickets] = await Promise.all([
      this.prisma.booking.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { user: true, trip: { include: { route: true } } },
      }),
      this.prisma.user.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.routeRequest.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { user: true },
      }),
      this.prisma.supportTicket.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { user: true },
      }),
    ]);

    return [
      ...bookings.map((b) => ({
        type: 'booking',
        title: 'حجز جديد على ' + b.trip.route.name,
        subtitle: b.user.phone,
        at: b.createdAt,
      })),
      ...users.map((u) => ({
        type: 'user',
        title: 'مستخدم جديد ' + (u.fullName ?? u.phone),
        subtitle: u.phone,
        at: u.createdAt,
      })),
      ...requests.map((r) => ({
        type: 'routeRequest',
        title: 'طلب خط سير: ' + r.fromAddress + ' ← ' + r.toAddress,
        subtitle: r.user.phone,
        at: r.createdAt,
      })),
      ...tickets.map((t) => ({
        type: 'ticket',
        title: 'تذكرة دعم: ' + t.subject,
        subtitle: t.user.phone,
        at: t.createdAt,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 15);
  }
}

function metric(
  key: string,
  label: string,
  value: number,
  previousValue: number | null,
  format: string,
) {
  return { key, label, value, previousValue, format };
}

function moneyAmount(value: unknown): number {
  if (typeof value === 'string') {
    return normalizeMoney(money(Number(value)));
  }
  return normalizeMoney(money(value as Parameters<typeof money>[0]));
}
