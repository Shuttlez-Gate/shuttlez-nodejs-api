import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { BookingStatus, TripStatus } from '../../common/enums';
import { money } from '../../common/utils/money';
import { bookingStatusLabel, tripStatusLabel } from '../../common/utils/enums-map';

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async get(daysInput?: string | number) {
    const days = Math.min(180, Math.max(7, Number(daysInput) || 30));
    const now = new Date();
    const rangeStart = utcDate(now, -(days - 1));
    const previousStart = utcDate(now, -(days * 2 - 1));

    const [
      metrics,
      series,
      tripStatusBreakdown,
      bookingStatusBreakdown,
      topRoutes,
      recentActivity,
    ] = await Promise.all([
      this.buildMetrics(rangeStart, previousStart),
      this.buildSeries(rangeStart, days),
      this.buildTripBreakdown(),
      this.buildBookingBreakdown(),
      this.buildTopRoutes(),
      this.buildActivity(),
    ]);

    return {
      metrics,
      series,
      tripStatusBreakdown,
      bookingStatusBreakdown,
      topRoutes,
      recentActivity,
    };
  }

  private async buildMetrics(rangeStart: Date, previousStart: Date) {
    const users = { isDeleted: false } as const;
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
      newBookings,
      previousBookings,
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
      this.prisma.user.count({ where: { ...users, createdAt: { gte: rangeStart } } }),
      this.prisma.user.count({
        where: { ...users, createdAt: { gte: previousStart, lt: rangeStart } },
      }),
      this.prisma.driver.count({ where: { isDeleted: false } }),
      this.prisma.driver.count({ where: { isDeleted: false, isOnline: true } }),
      this.prisma.route.count({ where: { isDeleted: false, isActive: true } }),
      this.prisma.route.count({ where: { isDeleted: false } }),
      this.prisma.trip.count({
        where: {
          isDeleted: false,
          status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
        },
      }),
      this.prisma.trip.count({ where: { isDeleted: false, status: TripStatus.Completed } }),
      this.prisma.booking.count({ where: { isDeleted: false } }),
      this.prisma.booking.count({ where: { isDeleted: false, createdAt: { gte: rangeStart } } }),
      this.prisma.booking.count({
        where: { isDeleted: false, createdAt: { gte: previousStart, lt: rangeStart } },
      }),
      this.prisma.booking.aggregate({
        where: {
          isDeleted: false,
          status: BookingStatus.Confirmed,
          createdAt: { gte: rangeStart },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.booking.aggregate({
        where: {
          isDeleted: false,
          status: BookingStatus.Confirmed,
          createdAt: { gte: previousStart, lt: rangeStart },
        },
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

    const revenue = money(revenueAgg._sum.totalAmount);
    const previousRevenue = money(previousRevenueAgg._sum.totalAmount);

    return [
      metric('revenue', 'الإيرادات', revenue, previousRevenue, 'currency'),
      metric('bookings', 'الحجوزات', newBookings, previousBookings, 'number'),
      metric('newUsers', 'مستخدمون جدد', newUsers, previousNewUsers, 'number'),
      metric('totalUsers', 'إجمالي المستخدمين', totalUsers, null, 'number'),
      metric('totalBookings', 'إجمالي الحجوزات', totalBookings, null, 'number'),
      metric('upcomingTrips', 'رحلات قادمة', upcomingTrips, null, 'number'),
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
      metric('walletBalance', 'أرصدة المحافظ', money(walletBalance._sum.balance), null, 'currency'),
    ];
  }

  private async buildSeries(rangeStart: Date, days: number) {
    const [bookingRows, userRows, tripRows] = await Promise.all([
      this.prisma.booking.findMany({
        where: { isDeleted: false, createdAt: { gte: rangeStart } },
        select: { createdAt: true, totalAmount: true, status: true },
      }),
      this.prisma.user.findMany({
        where: { isDeleted: false, createdAt: { gte: rangeStart } },
        select: { createdAt: true },
      }),
      this.prisma.trip.findMany({
        where: { isDeleted: false, scheduledAt: { gte: rangeStart } },
        select: { scheduledAt: true },
      }),
    ]);

    const buckets = Array.from({ length: days }, (_, offset) => {
      const date = new Date(rangeStart);
      date.setUTCDate(rangeStart.getUTCDate() + offset);
      return date;
    });

    const dayKey = (value: Date) => value.toISOString().slice(0, 10);
    const points = (selector: (day: Date) => number) =>
      buckets.map((date) => ({ date, value: selector(date) }));

    return [
      {
        key: 'revenue',
        label: 'الإيرادات',
        points: points((day) =>
          bookingRows
            .filter((b) => b.status === BookingStatus.Confirmed && dayKey(b.createdAt) === dayKey(day))
            .reduce((sum, b) => sum + money(b.totalAmount), 0),
        ),
      },
      {
        key: 'bookings',
        label: 'الحجوزات',
        points: points(
          (day) => bookingRows.filter((b) => dayKey(b.createdAt) === dayKey(day)).length,
        ),
      },
      {
        key: 'newUsers',
        label: 'مستخدمون جدد',
        points: points(
          (day) => userRows.filter((u) => dayKey(u.createdAt) === dayKey(day)).length,
        ),
      },
      {
        key: 'trips',
        label: 'الرحلات',
        points: points(
          (day) => tripRows.filter((t) => dayKey(t.scheduledAt) === dayKey(day)).length,
        ),
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

  private async buildTopRoutes() {
    const routes = await this.prisma.route.findMany({
      where: { isDeleted: false },
      select: {
        id: true,
        name: true,
        _count: { select: { trips: { where: { isDeleted: false } } } },
      },
    });
    const bookings = await this.prisma.booking.findMany({
      where: { isDeleted: false },
      select: {
        totalAmount: true,
        status: true,
        trip: { select: { routeId: true } },
      },
    });
    const byRoute = new Map<string, { bookingCount: number; revenue: number }>();
    for (const booking of bookings) {
      const routeId = booking.trip.routeId;
      const current = byRoute.get(routeId) ?? { bookingCount: 0, revenue: 0 };
      current.bookingCount += 1;
      if (booking.status === BookingStatus.Confirmed) {
        current.revenue += money(booking.totalAmount);
      }
      byRoute.set(routeId, current);
    }
    return routes
      .map((route) => {
        const stats = byRoute.get(route.id) ?? { bookingCount: 0, revenue: 0 };
        return {
          routeId: route.id,
          name: route.name,
          tripCount: route._count.trips,
          bookingCount: stats.bookingCount,
          revenue: stats.revenue,
        };
      })
      .sort((a, b) => b.bookingCount - a.bookingCount || b.tripCount - a.tripCount)
      .slice(0, 8);
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

function utcDate(now: Date, dayOffset: number) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset));
}
