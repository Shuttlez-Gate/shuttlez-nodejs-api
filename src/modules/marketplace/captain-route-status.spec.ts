import { RecurrenceKind, RoutePublishStatus, TripStatus } from '../../common/enums';
import {
  captainRouteLifecycle,
  isRecurringKind,
  tripTimeBucket,
} from './captain-route-status';

describe('captainRouteLifecycle', () => {
  const now = new Date('2026-10-04T12:00:00.000Z');

  it('maps draft / paused / archived without inventing enums', () => {
    expect(
      captainRouteLifecycle({
        publishStatus: RoutePublishStatus.Draft,
        isActive: false,
        now,
      }),
    ).toBe('draft');
    expect(
      captainRouteLifecycle({
        publishStatus: RoutePublishStatus.Published,
        isActive: false,
        nextTripAt: new Date('2026-10-05T07:30:00.000Z'),
        now,
      }),
    ).toBe('paused');
    expect(
      captainRouteLifecycle({
        publishStatus: RoutePublishStatus.Archived,
        isActive: false,
        now,
      }),
    ).toBe('archived');
  });

  it('treats published routes with a future trip as active', () => {
    expect(
      captainRouteLifecycle({
        publishStatus: RoutePublishStatus.Published,
        isActive: true,
        nextTripAt: new Date('2026-10-05T07:30:00.000Z'),
        now,
      }),
    ).toBe('active');
  });

  it('treats published routes with no upcoming trip as expired', () => {
    expect(
      captainRouteLifecycle({
        publishStatus: RoutePublishStatus.Published,
        isActive: true,
        nextTripAt: new Date('2026-10-01T07:30:00.000Z'),
        now,
      }),
    ).toBe('expired');
  });
});

describe('tripTimeBucket', () => {
  const now = new Date('2026-10-04T12:00:00.000Z');

  it('uses scheduledAt + status, not createdAt', () => {
    expect(
      tripTimeBucket(
        { status: TripStatus.Scheduled, scheduledAt: new Date('2026-10-05T07:30:00.000Z') },
        now,
      ),
    ).toBe('upcoming');
    expect(
      tripTimeBucket(
        { status: TripStatus.InProgress, scheduledAt: new Date('2026-10-04T07:30:00.000Z') },
        now,
      ),
    ).toBe('current');
    expect(
      tripTimeBucket(
        { status: TripStatus.Completed, scheduledAt: new Date('2026-10-04T07:30:00.000Z') },
        now,
      ),
    ).toBe('past');
  });
});

describe('isRecurringKind', () => {
  it('does not treat Once as recurring', () => {
    expect(isRecurringKind(RecurrenceKind.Once)).toBe(false);
    expect(isRecurringKind(RecurrenceKind.Weekly)).toBe(true);
  });
});
