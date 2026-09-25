import { BookingStatus, TripStatus } from '../../common/enums';
import {
  adminBookingStatusWrite,
  adminBookingStatusWrittenKeys,
  captainAssignmentWrite,
  captainUnassignmentWrite,
  lastCaptainWriteWins,
} from './admin-mutation-contracts';
import {
  isCountableConfirmedBooking,
  isUpcomingTripSnapshot,
  needsCaptainAssignment,
  occupancyPercent,
  summarizeConfirmedBookings,
} from './operations-metrics';
import {
  occupancyFromAggregates,
  summarizeLaunchPipeline,
  summarizeOfficialRouteOperations,
} from './management-metrics';
import {
  countReadyRoutesWithoutUpcomingTrip,
  isLaunchEligibleCorridor,
} from './ready-without-trip';
import { bookingIntegrityFindings, tripIntegrityFindings } from './production-integrity';

const now = new Date('2026-09-25T10:00:00.000Z');
const future = new Date('2026-09-25T12:00:00.000Z');
const past = new Date('2026-09-25T09:00:00.000Z');
const routeA = 'route-a';

describe('phase 9 — route launch continuity', () => {
  it('treats READY + pricing + no upcoming as the actionable without-upcoming set', () => {
    expect(
      isLaunchEligibleCorridor({ launchStatus: 'READY', pricingLinked: true, routeId: routeA }),
    ).toBe(true);
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [{ launchStatus: 'READY', pricingLinked: true, routeId: routeA }],
        [],
        now,
      ),
    ).toBe(1);
  });

  it('drops a READY priced corridor from without-upcoming after a qualifying upcoming trip exists', () => {
    const afterLaunch = countReadyRoutesWithoutUpcomingTrip(
      [{ launchStatus: 'READY', pricingLinked: true, routeId: routeA }],
      [
        {
          routeId: routeA,
          status: TripStatus.Scheduled,
          scheduledAt: future,
        },
      ],
      now,
    );
    expect(afterLaunch).toBe(0);
    const pipeline = summarizeLaunchPipeline(
      [{ launchStatus: 'READY', pricingLinked: true, routeId: routeA, pricingAvailable: true }],
      [routeA],
    );
    expect(pipeline.readyCorridorsWithoutUpcomingTrip).toBe(0);
    expect(pipeline.readyCorridorsWithUpcomingTrip).toBe(1);
  });

  it('does not change launch eligibility when an InProgress trip exists', () => {
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [{ launchStatus: 'READY', pricingLinked: true, routeId: routeA }],
        [{ routeId: routeA, status: TripStatus.InProgress, scheduledAt: future }],
        now,
      ),
    ).toBe(1);
  });
});

describe('phase 9 — official route snapshot', () => {
  it('aggregates pricing-independent trip facts through Trip.routeId only', () => {
    const snapshot = summarizeOfficialRouteOperations(
      routeA,
      [
        {
          id: 'up-unassigned',
          routeId: routeA,
          status: TripStatus.Scheduled,
          scheduledAt: future,
          driverId: null,
          availableSeats: 8,
        },
        {
          id: 'completed',
          routeId: routeA,
          status: TripStatus.Completed,
          scheduledAt: past,
          driverId: 'd1',
          availableSeats: 4,
        },
        {
          id: 'other-route',
          routeId: 'route-b',
          status: TripStatus.Scheduled,
          scheduledAt: future,
          driverId: null,
          availableSeats: 10,
        },
      ],
      [
        { tripId: 'up-unassigned', status: BookingStatus.Confirmed, seatCount: 2, totalAmount: 80 },
        { tripId: 'completed', status: BookingStatus.Confirmed, seatCount: 4, totalAmount: 160 },
        { tripId: 'other-route', status: BookingStatus.Confirmed, seatCount: 9, totalAmount: 900 },
        { tripId: 'completed', status: BookingStatus.Pending, seatCount: 3, totalAmount: 120 },
      ],
      now,
    );
    expect(snapshot.routeId).toBe(routeA);
    expect(snapshot.upcomingTripCount).toBe(1);
    expect(snapshot.upcomingUnassignedCount).toBe(1);
    expect(snapshot.completedTripCount).toBe(1);
    expect(snapshot.confirmedBookingCount).toBe(2);
    expect(snapshot.confirmedSeatCount).toBe(6);
    expect(snapshot.confirmedRevenue).toBe(240);
    expect(snapshot.occupancyPercent).toBe(occupancyPercent(6, 12));
  });
});

describe('phase 9 — trip statuses', () => {
  it('keeps Scheduled/DriverAssigned future as upcoming and excludes InProgress/Completed/Cancelled', () => {
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, future, now)).toBe(true);
    expect(isUpcomingTripSnapshot(TripStatus.DriverAssigned, future, now)).toBe(true);
    expect(isUpcomingTripSnapshot(TripStatus.InProgress, future, now)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Completed, future, now)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Cancelled, future, now)).toBe(false);
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, past, now)).toBe(false);
  });
});

describe('phase 9 — booking mutation ownership', () => {
  it('moves Pending → Confirmed → Cancelled by status only and never writes inventory or snapshots', () => {
    const inventory = { availableSeats: 6 };
    const snapshot = {
      TotalAmount: 80,
      SeatCount: 2,
      commissionRate: 0.1,
      commissionAmount: 8,
      captainEarnings: 72,
    };
    const confirm = adminBookingStatusWrite(BookingStatus.Confirmed, now);
    expect(adminBookingStatusWrittenKeys()).toEqual(['status', 'updatedAt']);
    expect(Object.keys(confirm).sort()).toEqual(['status', 'updatedAt']);
    expect(confirm.status).toBe(BookingStatus.Confirmed);
    expect(isCountableConfirmedBooking({ status: BookingStatus.Pending })).toBe(false);
    expect(isCountableConfirmedBooking({ status: confirm.status })).toBe(true);
    const cancel = adminBookingStatusWrite(BookingStatus.Cancelled, now);
    expect(cancel.status).toBe(BookingStatus.Cancelled);
    expect(isCountableConfirmedBooking({ status: cancel.status })).toBe(false);
    expect(inventory.availableSeats).toBe(6);
    expect(snapshot).toEqual({
      TotalAmount: 80,
      SeatCount: 2,
      commissionRate: 0.1,
      commissionAmount: 8,
      captainEarnings: 72,
    });
  });
});

describe('phase 9 — captain assignment', () => {
  it('assign then unassign uses Trip.driverId and last write wins; unassign re-enters the captain exception', () => {
    const assigned = captainAssignmentWrite(TripStatus.Scheduled, 'ahmed');
    expect(assigned).toEqual({ driverId: 'ahmed', status: TripStatus.DriverAssigned });
    const reassigned = captainAssignmentWrite(assigned.status, 'mohamed');
    expect(lastCaptainWriteWins([assigned.driverId, reassigned.driverId])).toBe('mohamed');
    const unassigned = captainUnassignmentWrite(reassigned.status);
    expect(unassigned).toEqual({ driverId: null, status: TripStatus.Scheduled });
    expect(needsCaptainAssignment(unassigned.driverId, unassigned.status)).toBe(true);
  });
});

describe('phase 9 — confirmed revenue and occupancy', () => {
  it('sums confirmed non-deleted TotalAmount only', () => {
    const finance = summarizeConfirmedBookings([
      { status: BookingStatus.Confirmed, seatCount: 2, totalAmount: 80, commissionAmount: 8, captainEarnings: 72 },
      { status: BookingStatus.Pending, seatCount: 4, totalAmount: 160, commissionAmount: 16, captainEarnings: 144 },
      { status: BookingStatus.Cancelled, seatCount: 1, totalAmount: 40, commissionAmount: 4, captainEarnings: 36 },
      {
        status: BookingStatus.Confirmed,
        isDeleted: true,
        seatCount: 5,
        totalAmount: 200,
        commissionAmount: 20,
        captainEarnings: 180,
      },
    ]);
    expect(finance.confirmedRevenue).toBe(80);
    expect(finance.confirmedSeatCount).toBe(2);
    expect(occupancyFromAggregates(2, 8).occupancyPercent).toBe(20);
  });
});

describe('phase 9 — soft delete and diagnostics', () => {
  it('excludes deleted trips from the route snapshot and does not repair integrity findings', () => {
    const snapshot = summarizeOfficialRouteOperations(
      routeA,
      [
        {
          id: 'live',
          routeId: routeA,
          status: TripStatus.Scheduled,
          scheduledAt: future,
          availableSeats: 8,
        },
        {
          id: 'deleted',
          routeId: routeA,
          status: TripStatus.Scheduled,
          scheduledAt: future,
          availableSeats: 8,
          isDeleted: true,
        },
      ],
      [
        { tripId: 'live', status: BookingStatus.Confirmed, seatCount: 2, totalAmount: 80 },
        { tripId: 'deleted', status: BookingStatus.Confirmed, seatCount: 9, totalAmount: 900 },
      ],
      now,
    );
    expect(snapshot.upcomingTripCount).toBe(1);
    expect(snapshot.confirmedRevenue).toBe(80);
    expect(tripIntegrityFindings({ routeId: null, pricePerSeat: 0 }).map((f) => f.kind)).toEqual([
      'routeId',
      'pricePerSeat',
    ]);
    expect(bookingIntegrityFindings({ tripId: null, seatCount: 0 }).map((f) => f.kind)).toEqual([
      'tripId',
      'seatCount',
    ]);
    expect(tripIntegrityFindings({ routeId: null, isDeleted: true })).toEqual([]);
  });
});
