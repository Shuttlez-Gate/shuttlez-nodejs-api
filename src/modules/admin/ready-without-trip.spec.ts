import { TripStatus } from '../../common/enums';
import {
  countReadyRoutesWithoutUpcomingTrip,
  isLaunchEligibleCorridor,
  isUpcomingTripFact,
} from './ready-without-trip';

const now = new Date('2026-09-25T10:00:00.000Z');
const routeA = 'route-a';
const routeB = 'route-b';

function readyCorridor(routeId = routeA) {
  return { launchStatus: 'READY', pricingLinked: true, routeId };
}

describe('ready corridors without upcoming trip', () => {
  it('excludes a READY priced corridor that already has an upcoming trip', () => {
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [readyCorridor()],
        [
          {
            routeId: routeA,
            status: TripStatus.Scheduled,
            scheduledAt: new Date('2026-09-25T12:00:00.000Z'),
          },
        ],
        now,
      ),
    ).toBe(0);
  });

  it('includes a READY priced corridor with no upcoming trip', () => {
    expect(countReadyRoutesWithoutUpcomingTrip([readyCorridor()], [], now)).toBe(1);
  });

  it('includes a READY priced corridor that only has a completed historical trip', () => {
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [readyCorridor()],
        [
          {
            routeId: routeA,
            status: TripStatus.Completed,
            scheduledAt: new Date('2026-09-20T08:00:00.000Z'),
          },
        ],
        now,
      ),
    ).toBe(1);
  });

  it('includes a READY priced corridor whose only trip is cancelled', () => {
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [readyCorridor()],
        [
          {
            routeId: routeA,
            status: TripStatus.Cancelled,
            scheduledAt: new Date('2026-09-26T08:00:00.000Z'),
          },
        ],
        now,
      ),
    ).toBe(1);
  });

  it('does not count a corridor that is not calculator READY', () => {
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [{ launchStatus: 'ALMOST_READY', pricingLinked: true, routeId: routeA }],
        [],
        now,
      ),
    ).toBe(0);
    expect(isLaunchEligibleCorridor({ launchStatus: 'FULL', pricingLinked: true, routeId: routeA })).toBe(
      false,
    );
  });

  it('does not count READY without pricingLinked', () => {
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [{ launchStatus: 'READY', pricingLinked: false, routeId: routeA }],
        [],
        now,
      ),
    ).toBe(0);
  });

  it('does not treat a past Scheduled trip as upcoming', () => {
    const past = {
      routeId: routeA,
      status: TripStatus.Scheduled,
      scheduledAt: new Date('2026-09-25T09:00:00.000Z'),
    };
    expect(isUpcomingTripFact(past, now)).toBe(false);
    expect(countReadyRoutesWithoutUpcomingTrip([readyCorridor()], [past], now)).toBe(1);
    expect(
      isUpcomingTripFact(
        {
          routeId: routeB,
          status: TripStatus.DriverAssigned,
          scheduledAt: new Date('2026-09-25T11:00:00.000Z'),
        },
        now,
      ),
    ).toBe(true);
  });

  it('does not treat InProgress as upcoming even when scheduled in the future', () => {
    expect(
      isUpcomingTripFact(
        {
          routeId: routeA,
          status: TripStatus.InProgress,
          scheduledAt: new Date('2026-09-25T12:00:00.000Z'),
        },
        now,
      ),
    ).toBe(false);
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [readyCorridor()],
        [
          {
            routeId: routeA,
            status: TripStatus.InProgress,
            scheduledAt: new Date('2026-09-25T12:00:00.000Z'),
          },
        ],
        now,
      ),
    ).toBe(1);
  });

  it('does not treat a deleted future Scheduled trip as upcoming', () => {
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [readyCorridor()],
        [
          {
            routeId: routeA,
            status: TripStatus.Scheduled,
            scheduledAt: new Date('2026-09-25T12:00:00.000Z'),
            isDeleted: true,
          },
        ],
        now,
      ),
    ).toBe(1);
  });

  it('counts unique official routeIds, not corridor labels', () => {
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [readyCorridor(routeA), readyCorridor(routeA), readyCorridor(routeB)],
        [],
        now,
      ),
    ).toBe(2);
  });

  it('does not classify a READY route with two upcoming trips as without a trip', () => {
    expect(
      countReadyRoutesWithoutUpcomingTrip(
        [readyCorridor(routeA)],
        [
          {
            routeId: routeA,
            status: TripStatus.Scheduled,
            scheduledAt: new Date('2026-09-25T12:00:00.000Z'),
          },
          {
            routeId: routeA,
            status: TripStatus.DriverAssigned,
            scheduledAt: new Date('2026-09-26T08:00:00.000Z'),
          },
        ],
        now,
      ),
    ).toBe(0);
  });
});
