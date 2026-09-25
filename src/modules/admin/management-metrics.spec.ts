import { BookingStatus, TripStatus } from '../../common/enums';
import {
  occupancyFromAggregates,
  summarizeLaunchPipeline,
  summarizeOfficialRouteOperations,
  upcomingAssignedCount,
  isPeriodConfirmedRevenueRow,
} from './management-metrics';

const now = new Date('2026-09-25T10:00:00.000Z');
const routeA = 'route-a';
const routeB = 'route-b';

describe('management metrics — occupancy aggregate', () => {
  it('uses SUM(confirmed seats) / SUM(capacity), not an average of trip percents', () => {
    const totals = occupancyFromAggregates(10, 90);
    expect(totals.capacity).toBe(100);
    expect(totals.occupancyPercent).toBe(10);
    const misleadingAverageOfPercents = (100 + 0) / 2;
    expect(totals.occupancyPercent).not.toBe(misleadingAverageOfPercents);
  });

  it('returns null occupancy when aggregate capacity is zero', () => {
    expect(occupancyFromAggregates(0, 0).occupancyPercent).toBeNull();
    expect(occupancyFromAggregates(0, 0).capacity).toBeNull();
  });
});

describe('management metrics — official route aggregation', () => {
  it('counts only trips and bookings attached by Trip.routeId', () => {
    const trips = [
      {
        id: 'u1',
        routeId: routeA,
        status: TripStatus.Scheduled,
        scheduledAt: new Date('2026-09-26T08:00:00.000Z'),
        driverId: null,
        availableSeats: 10,
      },
      {
        id: 'u2',
        routeId: routeA,
        status: TripStatus.DriverAssigned,
        scheduledAt: new Date('2026-09-27T08:00:00.000Z'),
        driverId: 'd1',
        availableSeats: 8,
      },
      {
        id: 'c1',
        routeId: routeA,
        status: TripStatus.Completed,
        scheduledAt: new Date('2026-09-20T08:00:00.000Z'),
        driverId: 'd1',
        availableSeats: 6,
      },
      {
        id: 'other',
        routeId: routeB,
        status: TripStatus.Completed,
        scheduledAt: new Date('2026-09-20T08:00:00.000Z'),
        driverId: 'd2',
        availableSeats: 4,
      },
    ];
    const bookings = [
      { tripId: 'u1', status: BookingStatus.Confirmed, seatCount: 2, totalAmount: 80 },
      { tripId: 'u2', status: BookingStatus.Confirmed, seatCount: 3, totalAmount: 120 },
      { tripId: 'c1', status: BookingStatus.Confirmed, seatCount: 4, totalAmount: 160 },
      { tripId: 'other', status: BookingStatus.Confirmed, seatCount: 9, totalAmount: 900 },
      { tripId: 'u1', status: BookingStatus.Pending, seatCount: 5, totalAmount: 200 },
    ];
    const summary = summarizeOfficialRouteOperations(routeA, trips, bookings, now);
    expect(summary.upcomingTripCount).toBe(2);
    expect(summary.upcomingUnassignedCount).toBe(1);
    expect(summary.completedTripCount).toBe(1);
    expect(summary.confirmedBookingCount).toBe(3);
    expect(summary.confirmedSeatCount).toBe(9);
    expect(summary.confirmedRevenue).toBe(360);
    expect(summary.tripCount).toBe(3);
  });
});

describe('management metrics — current-state launch pipeline', () => {
  it('counts READY priced corridors and READY without upcoming separately', () => {
    const snapshot = summarizeLaunchPipeline(
      [
        { launchStatus: 'READY', pricingLinked: true, pricingAvailable: true, routeId: routeA },
        { launchStatus: 'READY', pricingLinked: true, pricingAvailable: true, routeId: routeB },
        { launchStatus: 'ALMOST_READY', pricingLinked: true, pricingAvailable: false, routeId: 'r3' },
      ],
      [routeA],
    );
    expect(snapshot.readyCorridors).toBe(2);
    expect(snapshot.readyCorridorsWithUpcomingTrip).toBe(1);
    expect(snapshot.readyCorridorsWithoutUpcomingTrip).toBe(1);
    expect(snapshot.corridorsWithoutPricing).toBe(1);
  });
});

describe('management metrics — upcoming assignment split', () => {
  it('derives assigned upcoming as upcoming minus unassigned', () => {
    expect(upcomingAssignedCount(5, 2)).toBe(3);
    expect(upcomingAssignedCount(2, 2)).toBe(0);
  });
});

describe('management metrics — period confirmed revenue inclusion', () => {
  it('includes confirmed non-deleted and excludes pending, cancelled, expired, deleted', () => {
    expect(isPeriodConfirmedRevenueRow({ status: BookingStatus.Confirmed })).toBe(true);
    expect(isPeriodConfirmedRevenueRow({ status: BookingStatus.Confirmed, isDeleted: false })).toBe(
      true,
    );
    expect(isPeriodConfirmedRevenueRow({ status: BookingStatus.Pending })).toBe(false);
    expect(isPeriodConfirmedRevenueRow({ status: BookingStatus.Cancelled })).toBe(false);
    expect(isPeriodConfirmedRevenueRow({ status: BookingStatus.Expired })).toBe(false);
    expect(isPeriodConfirmedRevenueRow({ status: BookingStatus.Confirmed, isDeleted: true })).toBe(
      false,
    );
  });
});
