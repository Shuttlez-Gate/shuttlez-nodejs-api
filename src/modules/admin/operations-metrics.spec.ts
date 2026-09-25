import { BookingStatus, GroupRequestStatus, RideRequestStatus, TripStatus } from '../../common/enums';
import {
  DEFAULT_OPERATIONAL_TIMEZONE,
  getDashboardWindow,
  inHalfOpenRange,
} from '../../common/utils/operational-clock';
import {
  driverAssignedWhere,
  isConfirmedBookingStatus,
  isUnassignedDriver,
  indexUpcomingTripsByRoute,
  isUpcomingTripSnapshot,
  needsCaptainAssignment,
  upcomingTripsWhere,
  completedTripsInPeriodWhere,
  occupancyPercent,
  parseOptionalBoolean,
  summarizeBookingStatusCounts,
  summarizeConfirmedBookings,
  tripCapacity,
  upcomingUnassignedTripsWhere,
  ridesNeedingCaptainWhere,
  groupsNeedingCaptainWhere,
} from './operations-metrics';

describe('operations-metrics — confirmed booking definition', () => {
  it('includes Confirmed in revenue and occupancy', () => {
    expect(isConfirmedBookingStatus(BookingStatus.Confirmed)).toBe(true);
    const finance = summarizeConfirmedBookings([
      {
        status: BookingStatus.Confirmed,
        seatCount: 2,
        totalAmount: 80,
        commissionAmount: 8,
        captainEarnings: 72,
      },
    ]);
    expect(finance.confirmedBookingCount).toBe(1);
    expect(finance.confirmedRevenue).toBe(80);
    expect(finance.confirmedSeatCount).toBe(2);
  });

  it('excludes Pending from revenue and occupancy', () => {
    const finance = summarizeConfirmedBookings([
      {
        status: BookingStatus.Pending,
        seatCount: 3,
        totalAmount: 120,
        commissionAmount: 12,
        captainEarnings: 108,
      },
    ]);
    expect(isConfirmedBookingStatus(BookingStatus.Pending)).toBe(false);
    expect(finance.confirmedBookingCount).toBe(0);
    expect(finance.confirmedRevenue).toBe(0);
    expect(finance.confirmedSeatCount).toBe(0);
  });

  it('excludes Cancelled from revenue and occupancy', () => {
    const finance = summarizeConfirmedBookings([
      {
        status: BookingStatus.Cancelled,
        seatCount: 1,
        totalAmount: 40,
        commissionAmount: 4,
        captainEarnings: 36,
      },
    ]);
    expect(isConfirmedBookingStatus(BookingStatus.Cancelled)).toBe(false);
    expect(finance.confirmedRevenue).toBe(0);
  });

  it('excludes Expired; there is no Rejected booking status', () => {
    expect(isConfirmedBookingStatus(BookingStatus.Expired)).toBe(false);
    expect(isConfirmedBookingStatus(99)).toBe(false);
    const finance = summarizeConfirmedBookings([
      {
        status: BookingStatus.Expired,
        seatCount: 1,
        totalAmount: 40,
        commissionAmount: 4,
        captainEarnings: 36,
      },
      {
        status: 99,
        seatCount: 2,
        totalAmount: 99,
        commissionAmount: 9,
        captainEarnings: 90,
      },
    ]);
    expect(finance.confirmedRevenue).toBe(0);
    expect(finance.confirmedSeatCount).toBe(0);
  });

  it('excludes deleted Confirmed bookings from revenue', () => {
    const finance = summarizeConfirmedBookings([
      {
        status: BookingStatus.Confirmed,
        isDeleted: true,
        seatCount: 2,
        totalAmount: 80,
        commissionAmount: 8,
        captainEarnings: 72,
      },
    ]);
    expect(finance.confirmedRevenue).toBe(0);
    expect(finance.confirmedBookingCount).toBe(0);
  });
});

describe('operations-metrics — occupancy', () => {
  it('counts 1 booking × 3 seats as 3 occupied seats', () => {
    const finance = summarizeConfirmedBookings([
      {
        status: BookingStatus.Confirmed,
        seatCount: 3,
        totalAmount: 90,
        commissionAmount: 9,
        captainEarnings: 81,
      },
    ]);
    expect(finance.confirmedBookingCount).toBe(1);
    expect(finance.confirmedSeatCount).toBe(3);
    expect(tripCapacity(7, finance.confirmedSeatCount)).toBe(10);
    expect(occupancyPercent(finance.confirmedSeatCount, 7)).toBe(30);
  });

  it('excludes Pending seats from occupancy percent', () => {
    const finance = summarizeConfirmedBookings([
      {
        status: BookingStatus.Confirmed,
        seatCount: 2,
        totalAmount: 80,
        commissionAmount: 8,
        captainEarnings: 72,
      },
      {
        status: BookingStatus.Pending,
        seatCount: 4,
        totalAmount: 160,
        commissionAmount: 16,
        captainEarnings: 144,
      },
    ]);
    expect(finance.confirmedSeatCount).toBe(2);
    expect(occupancyPercent(finance.confirmedSeatCount, 8)).toBe(20);
  });
});

describe('operations-metrics — driver assignment', () => {
  it('treats driverId = null as unassigned', () => {
    expect(isUnassignedDriver(null)).toBe(true);
    expect(driverAssignedWhere(false)).toEqual({ driverId: null });
  });

  it('treats driverId != null as assigned', () => {
    expect(isUnassignedDriver('driver-1')).toBe(false);
    expect(driverAssignedWhere(true)).toEqual({ driverId: { not: null } });
  });

  it('parses driverAssigned query flag', () => {
    expect(parseOptionalBoolean('false')).toBe(false);
    expect(parseOptionalBoolean('0')).toBe(false);
    expect(parseOptionalBoolean('true')).toBe(true);
    expect(parseOptionalBoolean(undefined)).toBeUndefined();
  });

  it('ignores invalid boolean query values instead of treating them as true', () => {
    expect(parseOptionalBoolean('abc')).toBeUndefined();
    expect(parseOptionalBoolean('xyz')).toBeUndefined();
    expect(parseOptionalBoolean('upcoming')).toBeUndefined();
  });

  it('treats a Scheduled trip without driver as needing captain assignment', () => {
    expect(needsCaptainAssignment(null, TripStatus.Scheduled)).toBe(true);
  });

  it('does not treat a Completed trip without driver as an assignment issue', () => {
    expect(needsCaptainAssignment(null, TripStatus.Completed)).toBe(false);
    expect(needsCaptainAssignment(null, TripStatus.Cancelled)).toBe(false);
  });

  it('does not treat DriverAssigned status as needing assignment', () => {
    expect(needsCaptainAssignment(null, TripStatus.DriverAssigned)).toBe(false);
    expect(needsCaptainAssignment('driver-1', TripStatus.DriverAssigned)).toBe(false);
  });

  it('does not treat InProgress without driver as the scheduled assignment queue', () => {
    expect(needsCaptainAssignment(null, TripStatus.InProgress)).toBe(false);
  });
});

describe('operations-metrics — upcoming and completed period', () => {
  it('includes a future Scheduled trip in upcoming and excludes a past trip', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const where = upcomingTripsWhere(now);
    expect(where.scheduledAt.gte.getTime()).toBe(now.getTime());
    expect(where.status.in).toEqual([TripStatus.Scheduled, TripStatus.DriverAssigned]);
    expect(where.isDeleted).toBe(false);
    const future = new Date('2026-09-25T11:00:00.000Z');
    const pastScheduled = new Date('2026-09-25T09:00:00.000Z');
    expect(future.getTime() >= where.scheduledAt.gte.getTime()).toBe(true);
    expect(pastScheduled.getTime() >= where.scheduledAt.gte.getTime()).toBe(false);
  });

  it('scopes completed trips to Trip.scheduledAt in the selected period', () => {
    const start = new Date('2026-09-01T21:00:00.000Z');
    const end = new Date('2026-09-25T21:00:00.000Z');
    const where = completedTripsInPeriodWhere(start, end);
    expect(where.status).toBe(TripStatus.Completed);
    expect(where.scheduledAt.gte).toBe(start);
    expect(where.scheduledAt.lt).toBe(end);
    expect(where.isDeleted).toBe(false);
  });

  it('counts a completed trip inside the selected operational window and excludes one outside', () => {
    const cairo = DEFAULT_OPERATIONAL_TIMEZONE;
    const now = new Date('2026-09-25T10:00:00.000Z');
    const window = getDashboardWindow(now, 7, cairo);
    const where = completedTripsInPeriodWhere(window.currentStart, window.currentEnd);
    const inside = new Date(window.currentStart.getTime() + 3_600_000);
    const outside = new Date(window.currentStart.getTime() - 3_600_000);
    expect(inHalfOpenRange(inside, where.scheduledAt.gte, where.scheduledAt.lt)).toBe(true);
    expect(inHalfOpenRange(outside, where.scheduledAt.gte, where.scheduledAt.lt)).toBe(false);
    expect(inHalfOpenRange(window.currentEnd, where.scheduledAt.gte, where.scheduledAt.lt)).toBe(
      false,
    );
  });

  it('uses the Cairo operational-day boundary, not UTC midnight, for completed-in-period', () => {
    const cairo = DEFAULT_OPERATIONAL_TIMEZONE;
    const now = new Date('2026-09-25T10:00:00.000Z');
    const window = getDashboardWindow(now, 7, cairo);
    const cairoTodayStart = new Date('2026-09-24T21:00:00.000Z');
    const justBeforeCairoToday = new Date('2026-09-24T20:59:59.000Z');
    expect(window.todayStart.toISOString()).toBe(cairoTodayStart.toISOString());
    expect(inHalfOpenRange(cairoTodayStart, window.todayStart, window.todayEnd)).toBe(true);
    expect(inHalfOpenRange(justBeforeCairoToday, window.todayStart, window.todayEnd)).toBe(false);
    expect(inHalfOpenRange(cairoTodayStart, window.currentStart, window.currentEnd)).toBe(true);
  });
});

describe('operations-metrics — action queues', () => {
  it('includes a future unassigned Scheduled trip and excludes a past one', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const where = upcomingUnassignedTripsWhere(now);
    expect(where.isDeleted).toBe(false);
    expect(where.driverId).toBeNull();
    expect(where.status).toBe(TripStatus.Scheduled);
    const future = new Date('2026-09-25T11:00:00.000Z');
    const past = new Date('2026-09-25T09:00:00.000Z');
    expect(future.getTime() >= where.scheduledAt.gte.getTime()).toBe(true);
    expect(past.getTime() >= where.scheduledAt.gte.getTime()).toBe(false);
  });

  it('counts rides needing captain as Requested with no driver', () => {
    const where = ridesNeedingCaptainWhere();
    expect(where.isDeleted).toBe(false);
    expect(where.driverId).toBeNull();
    expect(where.status).toBe(RideRequestStatus.Requested);
  });

  it('counts groups needing captain as Draft or Confirmed with no driver', () => {
    const where = groupsNeedingCaptainWhere();
    expect(where.isDeleted).toBe(false);
    expect(where.driverId).toBeNull();
    expect(where.status.in).toEqual([GroupRequestStatus.Draft, GroupRequestStatus.Confirmed]);
  });

  it('drops a future trip from the unassigned queue once driverId is set', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const where = upcomingUnassignedTripsWhere(now);
    expect(where.driverId).toBeNull();
    expect(isUnassignedDriver('captain-1')).toBe(false);
    expect(needsCaptainAssignment('captain-1', TripStatus.Scheduled)).toBe(false);
    expect(needsCaptainAssignment('captain-1', TripStatus.DriverAssigned)).toBe(false);
  });
});

describe('operations-metrics — booking status counts and revenue', () => {
  const rows = [
    { status: BookingStatus.Pending, seatCount: 2, totalAmount: 80, commissionAmount: 8, captainEarnings: 72 },
    { status: BookingStatus.Confirmed, seatCount: 3, totalAmount: 120, commissionAmount: 12, captainEarnings: 108 },
    { status: BookingStatus.Cancelled, seatCount: 1, totalAmount: 40, commissionAmount: 4, captainEarnings: 36 },
    { status: BookingStatus.Expired, seatCount: 1, totalAmount: 40, commissionAmount: 4, captainEarnings: 36 },
  ];

  it('counts pending/confirmed/cancelled/expired separately and occupies seats from Confirmed only', () => {
    const counts = summarizeBookingStatusCounts(rows);
    expect(counts.pendingBookingCount).toBe(1);
    expect(counts.confirmedBookingCount).toBe(1);
    expect(counts.cancelledBookingCount).toBe(1);
    expect(counts.expiredBookingCount).toBe(1);
    const finance = summarizeConfirmedBookings(rows);
    expect(finance.confirmedSeatCount).toBe(3);
    expect(finance.confirmedRevenue).toBe(120);
  });

  it('does not treat Pending, Cancelled, or Expired as confirmed revenue', () => {
    expect(
      summarizeConfirmedBookings(rows.filter((r) => r.status !== BookingStatus.Confirmed))
        .confirmedRevenue,
    ).toBe(0);
  });

  it('marks future Scheduled/DriverAssigned as upcoming and past as not', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, new Date('2026-09-25T11:00:00.000Z'), now)).toBe(
      true,
    );
    expect(
      isUpcomingTripSnapshot(TripStatus.DriverAssigned, new Date('2026-09-25T11:00:00.000Z'), now),
    ).toBe(true);
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, new Date('2026-09-25T09:00:00.000Z'), now)).toBe(
      false,
    );
    expect(isUpcomingTripSnapshot(TripStatus.Completed, new Date('2026-09-25T11:00:00.000Z'), now)).toBe(
      false,
    );
  });

  it('counts two upcoming trips on the same official route without N+1 grouping', () => {
    const index = indexUpcomingTripsByRoute([
      {
        id: 't1',
        routeId: 'route-a',
        scheduledAt: new Date('2026-09-25T12:00:00.000Z'),
        driverId: null,
      },
      {
        id: 't2',
        routeId: 'route-a',
        scheduledAt: new Date('2026-09-26T08:00:00.000Z'),
        driverId: 'd1',
      },
    ]);
    expect(index.get('route-a')?.count).toBe(2);
    expect(index.get('route-a')?.unassignedCount).toBe(1);
    expect(index.get('route-a')?.id).toBe('t1');
  });
});
