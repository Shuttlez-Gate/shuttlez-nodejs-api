import { BookingStatus, TripStatus } from '../../common/enums';
import { parseTripStatuses } from '../../common/utils/enums-map';
import {
  inHalfOpenRange,
  operationalDayBounds,
} from '../../common/utils/operational-clock';
import {
  occupancyFromAggregates,
  summarizeOfficialRouteOperations,
} from './management-metrics';
import {
  isCountableConfirmedBooking,
  isUpcomingTripSnapshot,
  occupancyPercent,
  parseOptionalBoolean,
  summarizeConfirmedBookings,
} from './operations-metrics';
import { isLaunchEligibleCorridor } from './ready-without-trip';

describe('semantic invariants — launch', () => {
  it('READY + pricing is launch-eligible; READY without pricing is not', () => {
    expect(
      isLaunchEligibleCorridor({
        launchStatus: 'READY',
        pricingLinked: true,
        routeId: 'r1',
      }),
    ).toBe(true);
    expect(
      isLaunchEligibleCorridor({
        launchStatus: 'READY',
        pricingLinked: false,
        routeId: 'r1',
      }),
    ).toBe(false);
  });

  it('FULL with pricing is never launch-eligible', () => {
    expect(
      isLaunchEligibleCorridor({
        launchStatus: 'FULL',
        pricingLinked: true,
        routeId: 'r1',
      }),
    ).toBe(false);
  });

  it('ALMOST_READY is not calculator launch eligibility', () => {
    expect(
      isLaunchEligibleCorridor({
        launchStatus: 'ALMOST_READY',
        pricingLinked: true,
        routeId: 'r1',
      }),
    ).toBe(false);
  });

  it('READY_TO_LAUNCH planning state is not calculator launch eligibility', () => {
    expect(
      isLaunchEligibleCorridor({
        launchStatus: 'READY_TO_LAUNCH',
        pricingLinked: true,
        routeId: 'r1',
      }),
    ).toBe(false);
  });
});

describe('semantic invariants — trip upcoming', () => {
  const now = new Date('2026-09-25T10:00:00.000Z');

  it('Scheduled and DriverAssigned in the future are upcoming', () => {
    const future = new Date('2026-09-25T11:00:00.000Z');
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, future, now)).toBe(true);
    expect(isUpcomingTripSnapshot(TripStatus.DriverAssigned, future, now)).toBe(true);
  });

  it('Completed, deleted, and past trips are never upcoming', () => {
    const future = new Date('2026-09-25T11:00:00.000Z');
    const past = new Date('2026-09-25T09:00:00.000Z');
    expect(isUpcomingTripSnapshot(TripStatus.Completed, future, now)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, past, now)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, future, now, true)).toBe(false);
  });
});

describe('semantic invariants — booking revenue and seats', () => {
  it('confirmed seats and revenue never include Pending, Cancelled, Expired, or deleted', () => {
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
        seatCount: 9,
        totalAmount: 900,
        commissionAmount: 90,
        captainEarnings: 810,
      },
      {
        status: BookingStatus.Cancelled,
        seatCount: 3,
        totalAmount: 120,
        commissionAmount: 12,
        captainEarnings: 108,
      },
      {
        status: BookingStatus.Expired,
        seatCount: 1,
        totalAmount: 40,
        commissionAmount: 4,
        captainEarnings: 36,
      },
      {
        status: BookingStatus.Confirmed,
        isDeleted: true,
        seatCount: 5,
        totalAmount: 200,
        commissionAmount: 20,
        captainEarnings: 180,
      },
    ]);
    expect(finance.confirmedSeatCount).toBe(2);
    expect(finance.confirmedRevenue).toBe(80);
    expect(isCountableConfirmedBooking({ status: BookingStatus.Pending })).toBe(false);
    expect(isCountableConfirmedBooking({ status: BookingStatus.Confirmed, isDeleted: true })).toBe(
      false,
    );
  });
});

describe('semantic invariants — occupancy', () => {
  it('uses remaining + confirmed, and aggregate SUM/SUM not average of percents', () => {
    expect(occupancyPercent(2, 8)).toBe(20);
    const totals = occupancyFromAggregates(10, 90);
    expect(totals.occupancyPercent).toBe(10);
    expect(totals.occupancyPercent).not.toBe(50);
  });
});

describe('semantic invariants — Trip.routeId', () => {
  it('associates bookings only through trips that share the routeId', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const summary = summarizeOfficialRouteOperations(
      'route-a',
      [
        {
          id: 't-a',
          routeId: 'route-a',
          status: TripStatus.Completed,
          scheduledAt: new Date('2026-09-20T08:00:00.000Z'),
          availableSeats: 6,
        },
        {
          id: 't-b',
          routeId: 'route-b',
          status: TripStatus.Completed,
          scheduledAt: new Date('2026-09-20T08:00:00.000Z'),
          availableSeats: 6,
        },
      ],
      [
        { tripId: 't-a', status: BookingStatus.Confirmed, seatCount: 2, totalAmount: 80 },
        { tripId: 't-b', status: BookingStatus.Confirmed, seatCount: 9, totalAmount: 900 },
      ],
      now,
    );
    expect(summary.confirmedBookingCount).toBe(1);
    expect(summary.confirmedRevenue).toBe(80);
  });
});

describe('semantic invariants — time and query flags', () => {
  it('keeps Cairo 00:00 inside the day and next-day 00:00 outside [start, end)', () => {
    const bounds = operationalDayBounds('2026-09-25', 'Africa/Cairo')!;
    expect(inHalfOpenRange(bounds.start, bounds.start, bounds.end)).toBe(true);
    expect(inHalfOpenRange(new Date(bounds.end.getTime() - 1), bounds.start, bounds.end)).toBe(
      true,
    );
    expect(inHalfOpenRange(bounds.end, bounds.start, bounds.end)).toBe(false);
  });

  it('ignores unknown trip status and boolean query values', () => {
    expect(parseTripStatuses('unknown')).toBeUndefined();
    expect(parseOptionalBoolean('abc')).toBeUndefined();
    expect(parseOptionalBoolean('xyz')).toBeUndefined();
  });
});
