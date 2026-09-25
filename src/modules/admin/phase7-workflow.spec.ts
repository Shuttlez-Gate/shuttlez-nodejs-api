import { BookingStatus, TripStatus } from '../../common/enums';
import { resolveApplyDemandPrice, resolveRequiredAvailableSeats } from './apply-demand-price';
import {
  isCountableConfirmedBooking,
  isUnassignedDriver,
  isUpcomingTripSnapshot,
  needsCaptainAssignment,
  summarizeConfirmedBookings,
  upcomingUnassignedTripsWhere,
} from './operations-metrics';
import { isLaunchEligibleCorridor } from './ready-without-trip';

describe('phase 7 — pricing launch eligibility', () => {
  it('missing pricing is not launch eligible', () => {
    expect(
      isLaunchEligibleCorridor({
        launchStatus: 'READY',
        pricingLinked: false,
        routeId: 'r1',
      }),
    ).toBe(false);
  });

  it('pricing + READY is launch eligible', () => {
    expect(
      isLaunchEligibleCorridor({
        launchStatus: 'READY',
        pricingLinked: true,
        routeId: 'r1',
      }),
    ).toBe(true);
  });
});

describe('phase 7 — upcoming classification', () => {
  const now = new Date('2026-09-25T10:00:00.000Z');
  const future = new Date('2026-09-25T12:00:00.000Z');

  it('future Scheduled without captain is upcoming unassigned', () => {
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, future, now)).toBe(true);
    expect(needsCaptainAssignment(null, TripStatus.Scheduled)).toBe(true);
    const where = upcomingUnassignedTripsWhere(now);
    expect(where.driverId).toBeNull();
    expect(where.status).toBe(TripStatus.Scheduled);
    expect(future.getTime() >= where.scheduledAt.gte.getTime()).toBe(true);
  });

  it('future Scheduled with captain is not upcoming unassigned', () => {
    expect(isUpcomingTripSnapshot(TripStatus.Scheduled, future, now)).toBe(true);
    expect(isUnassignedDriver('captain-1')).toBe(false);
    expect(needsCaptainAssignment('captain-1', TripStatus.Scheduled)).toBe(false);
  });

  it('future Cancelled is not upcoming', () => {
    expect(isUpcomingTripSnapshot(TripStatus.Cancelled, future, now)).toBe(false);
  });

  it('future InProgress is not upcoming under the current definition', () => {
    expect(isUpcomingTripSnapshot(TripStatus.InProgress, future, now)).toBe(false);
  });

  it('Completed is not upcoming', () => {
    expect(isUpcomingTripSnapshot(TripStatus.Completed, future, now)).toBe(false);
  });
});

describe('phase 7 — assignment facts', () => {
  it('assign sets driverId; unassign clears it for the unassigned metric', () => {
    expect(isUnassignedDriver(null)).toBe(true);
    expect(isUnassignedDriver('driver-1')).toBe(false);
    expect(needsCaptainAssignment(null, TripStatus.Scheduled)).toBe(true);
    expect(needsCaptainAssignment('driver-1', TripStatus.DriverAssigned)).toBe(false);
  });
});

describe('phase 7 — trip price integrity', () => {
  it('rejects missing, zero, and negative prices', () => {
    expect(resolveApplyDemandPrice(undefined)).toBeNull();
    expect(resolveApplyDemandPrice(0)).toBeNull();
    expect(resolveApplyDemandPrice(-1)).toBeNull();
    expect(resolveApplyDemandPrice(50)).toBe(50);
    expect(resolveRequiredAvailableSeats(0)).toBeNull();
    expect(resolveRequiredAvailableSeats(4)).toBe(4);
  });
});

describe('phase 7 — admin booking status impact', () => {
  it('Pending → Confirmed includes seats and revenue; Confirmed → Cancelled excludes them without rewriting snapshots', () => {
    const pending = {
      status: BookingStatus.Pending,
      seatCount: 2,
      totalAmount: 80,
      commissionAmount: 8,
      captainEarnings: 72,
    };
    expect(isCountableConfirmedBooking(pending)).toBe(false);
    const confirmed = { ...pending, status: BookingStatus.Confirmed };
    expect(isCountableConfirmedBooking(confirmed)).toBe(true);
    expect(summarizeConfirmedBookings([confirmed]).confirmedRevenue).toBe(80);
    expect(confirmed.commissionAmount).toBe(8);
    const cancelled = { ...confirmed, status: BookingStatus.Cancelled };
    expect(isCountableConfirmedBooking(cancelled)).toBe(false);
    expect(summarizeConfirmedBookings([cancelled]).confirmedRevenue).toBe(0);
    expect(cancelled.commissionAmount).toBe(8);
  });
});
