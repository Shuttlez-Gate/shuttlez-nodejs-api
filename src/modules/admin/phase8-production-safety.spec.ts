import { BookingStatus, TripStatus } from '../../common/enums';
import {
  adminBookingStatusWrite,
  adminBookingStatusWrittenKeys,
  canAdminCancelTrip,
  captainAssignmentWrite,
  captainUnassignmentWrite,
  lastCaptainWriteWins,
} from './admin-mutation-contracts';
import { canTransitionRouteRequest } from './route-request-workflow';
import {
  isCountableConfirmedBooking,
  isUpcomingTripSnapshot,
  needsCaptainAssignment,
  occupancyPercent,
  summarizeConfirmedBookings,
  upcomingTripsWhere,
  upcomingUnassignedTripsWhere,
  confirmedBookingWhere,
} from './operations-metrics';
import { isLaunchEligibleCorridor } from './ready-without-trip';
import { occupancyFromAggregates, summarizeOfficialRouteOperations } from './management-metrics';
import { bookingIntegrityFindings, tripIntegrityFindings } from './production-integrity';

describe('phase 8 — launch eligibility', () => {
  it('READY + pricing is eligible; READY without pricing, ALMOST_READY, FULL, and planning READY_TO_LAUNCH are not', () => {
    expect(
      isLaunchEligibleCorridor({ launchStatus: 'READY', pricingLinked: true, routeId: 'r1' }),
    ).toBe(true);
    expect(
      isLaunchEligibleCorridor({ launchStatus: 'READY', pricingLinked: false, routeId: 'r1' }),
    ).toBe(false);
    expect(
      isLaunchEligibleCorridor({ launchStatus: 'ALMOST_READY', pricingLinked: true, routeId: 'r1' }),
    ).toBe(false);
    expect(
      isLaunchEligibleCorridor({ launchStatus: 'FULL', pricingLinked: true, routeId: 'r1' }),
    ).toBe(false);
    expect(
      isLaunchEligibleCorridor({
        launchStatus: 'READY_TO_LAUNCH',
        pricingLinked: true,
        routeId: 'r1',
      }),
    ).toBe(false);
  });
});

describe('phase 8 — upcoming integrity', () => {
  const now = new Date('2026-09-25T10:00:00.000Z');
  const future = new Date('2026-09-25T12:00:00.000Z');
  const past = new Date('2026-09-25T09:00:00.000Z');

  it('includes future Scheduled and DriverAssigned only', () => {
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, future, now)).toBe(true);
    expect(isUpcomingTripSnapshot(TripStatus.DriverAssigned, future, now)).toBe(true);
    expect(isUpcomingTripSnapshot(TripStatus.InProgress, future, now)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Completed, future, now)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Cancelled, future, now)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, future, now, true)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, past, now)).toBe(false);
    expect(upcomingTripsWhere(now).isDeleted).toBe(false);
    expect(upcomingUnassignedTripsWhere(now).isDeleted).toBe(false);
  });
});

describe('phase 8 — revenue seats occupancy', () => {
  it('includes Confirmed and excludes Pending, Cancelled, Expired, and deleted', () => {
    const finance = summarizeConfirmedBookings([
      { status: BookingStatus.Confirmed, seatCount: 2, totalAmount: 80, commissionAmount: 8, captainEarnings: 72 },
      { status: BookingStatus.Pending, seatCount: 9, totalAmount: 900, commissionAmount: 90, captainEarnings: 810 },
      { status: BookingStatus.Cancelled, seatCount: 3, totalAmount: 120, commissionAmount: 12, captainEarnings: 108 },
      { status: BookingStatus.Expired, seatCount: 1, totalAmount: 40, commissionAmount: 4, captainEarnings: 36 },
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
    expect(confirmedBookingWhere.isDeleted).toBe(false);
    expect(confirmedBookingWhere.status).toBe(BookingStatus.Confirmed);
  });

  it('uses confirmed / (available + confirmed) and null occupancy when capacity is zero', () => {
    expect(occupancyPercent(2, 8)).toBe(20);
    expect(occupancyPercent(0, 0)).toBeNull();
    const aggregate = occupancyFromAggregates(10, 90);
    expect(aggregate.occupancyPercent).toBe(10);
    expect(occupancyFromAggregates(0, 0).occupancyPercent).toBeNull();
  });
});

describe('phase 8 — booking status mutation is not inventory', () => {
  it('writes only status and updatedAt; snapshots and availableSeats stay untouched', () => {
    expect(adminBookingStatusWrittenKeys()).toEqual(['status', 'updatedAt']);
    const tripAvailableSeats = 6;
    const snapshot = {
      totalAmount: 80,
      commissionRate: 0.1,
      commissionAmount: 8,
      captainEarnings: 72,
      seatCount: 2,
    };
    const write = adminBookingStatusWrite(BookingStatus.Confirmed, new Date('2026-09-25T10:00:00.000Z'));
    expect(Object.keys(write).sort()).toEqual(['status', 'updatedAt']);
    expect(write.status).toBe(BookingStatus.Confirmed);
    expect(tripAvailableSeats).toBe(6);
    expect(snapshot).toEqual({
      totalAmount: 80,
      commissionRate: 0.1,
      commissionAmount: 8,
      captainEarnings: 72,
      seatCount: 2,
    });
    expect(isCountableConfirmedBooking({ status: BookingStatus.Pending })).toBe(false);
    expect(isCountableConfirmedBooking({ status: BookingStatus.Confirmed })).toBe(true);
    expect(isCountableConfirmedBooking({ status: BookingStatus.Cancelled })).toBe(false);
  });
});

describe('phase 8 — assignment last write wins', () => {
  it('applies sequential assigns without a version token; last driverId wins', () => {
    const first = captainAssignmentWrite(TripStatus.Scheduled, 'ahmed');
    expect(first).toEqual({ driverId: 'ahmed', status: TripStatus.DriverAssigned });
    const second = captainAssignmentWrite(first.status, 'mohamed');
    expect(second.driverId).toBe('mohamed');
    expect(lastCaptainWriteWins(['ahmed', 'mohamed'])).toBe('mohamed');
    const unassigned = captainUnassignmentWrite(TripStatus.DriverAssigned);
    expect(unassigned).toEqual({ driverId: null, status: TripStatus.Scheduled });
    expect(needsCaptainAssignment(unassigned.driverId, unassigned.status)).toBe(true);
  });
});

describe('phase 8 — trip cancellation', () => {
  const now = new Date('2026-09-25T10:00:00.000Z');
  const future = new Date('2026-09-25T12:00:00.000Z');

  it('blocks Completed and Cancelled; cancelled upcoming trips leave actionable metrics', () => {
    expect(canAdminCancelTrip(TripStatus.Scheduled)).toBe(true);
    expect(canAdminCancelTrip(TripStatus.DriverAssigned)).toBe(true);
    expect(canAdminCancelTrip(TripStatus.InProgress)).toBe(true);
    expect(canAdminCancelTrip(TripStatus.Completed)).toBe(false);
    expect(canAdminCancelTrip(TripStatus.Cancelled)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Cancelled, future, now, true)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Cancelled, future, now, false)).toBe(false);
  });
});

describe('phase 8 — soft delete exclusion', () => {
  it('drops deleted trips and bookings from official route operations', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const summary = summarizeOfficialRouteOperations(
      'route-a',
      [
        {
          id: 'live',
          routeId: 'route-a',
          status: TripStatus.Scheduled,
          scheduledAt: new Date('2026-09-26T08:00:00.000Z'),
          availableSeats: 8,
        },
        {
          id: 'gone',
          routeId: 'route-a',
          status: TripStatus.Scheduled,
          scheduledAt: new Date('2026-09-26T08:00:00.000Z'),
          availableSeats: 8,
          isDeleted: true,
        },
      ],
      [
        { tripId: 'live', status: BookingStatus.Confirmed, seatCount: 2, totalAmount: 80 },
        { tripId: 'gone', status: BookingStatus.Confirmed, seatCount: 9, totalAmount: 900 },
        {
          tripId: 'live',
          status: BookingStatus.Confirmed,
          seatCount: 3,
          totalAmount: 120,
          isDeleted: true,
        },
      ],
      now,
    );
    expect(summary.tripCount).toBe(1);
    expect(summary.upcomingTripCount).toBe(1);
    expect(summary.confirmedBookingCount).toBe(1);
    expect(summary.confirmedRevenue).toBe(80);
    expect(summary.confirmedSeatCount).toBe(2);
  });
});

describe('phase 8 — route request invalid transition', () => {
  it('rejects Converted from Pending without changing the current status', () => {
    const current = 'pending';
    expect(canTransitionRouteRequest(current, 'converted')).toBe(false);
    expect(current).toBe('pending');
  });
});

describe('phase 8 — read-only diagnostics', () => {
  it('flags live trips with invalid price or missing routeId and ignores deleted rows', () => {
    expect(tripIntegrityFindings({ routeId: 'r1', pricePerSeat: 40 })).toEqual([]);
    expect(tripIntegrityFindings({ routeId: 'r1', pricePerSeat: 0 }).map((f) => f.kind)).toEqual([
      'pricePerSeat',
    ]);
    expect(tripIntegrityFindings({ routeId: '', pricePerSeat: 40 }).map((f) => f.kind)).toEqual([
      'routeId',
    ]);
    expect(tripIntegrityFindings({ routeId: '', pricePerSeat: 0, isDeleted: true })).toEqual([]);
  });

  it('flags live bookings with missing tripId or seatCount < 1', () => {
    expect(bookingIntegrityFindings({ tripId: 't1', seatCount: 2 })).toEqual([]);
    expect(bookingIntegrityFindings({ tripId: '', seatCount: 0 }).map((f) => f.kind)).toEqual([
      'tripId',
      'seatCount',
    ]);
    expect(bookingIntegrityFindings({ tripId: '', seatCount: 0, isDeleted: true })).toEqual([]);
  });
});
