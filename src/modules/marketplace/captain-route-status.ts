import { RecurrenceKind, RoutePublishStatus, TripStatus } from '../../common/enums';

export type CaptainRouteLifecycle =
  | 'draft'
  | 'active'
  | 'paused'
  | 'archived'
  | 'expired';

export function captainRouteLifecycle(input: {
  publishStatus: number;
  isActive: boolean;
  nextTripAt?: Date | null;
  now?: Date;
}): CaptainRouteLifecycle {
  const now = input.now ?? new Date();
  if (input.publishStatus === RoutePublishStatus.Archived) {
    return 'archived';
  }
  if (input.publishStatus === RoutePublishStatus.Draft) {
    return 'draft';
  }
  if (!input.isActive) {
    return 'paused';
  }
  if (!input.nextTripAt || input.nextTripAt.getTime() < now.getTime()) {
    return 'expired';
  }
  return 'active';
}

export function tripTimeBucket(
  trip: { status: number; scheduledAt: Date; completedAt?: Date | null },
  now: Date,
): 'current' | 'upcoming' | 'past' {
  const status = trip.status;
  if (status === TripStatus.Completed || status === TripStatus.Cancelled || trip.completedAt) {
    return 'past';
  }
  if (status === TripStatus.InProgress) {
    return 'current';
  }
  if (trip.scheduledAt.getTime() > now.getTime()) {
    return 'upcoming';
  }
  return 'current';
}

export function isRecurringKind(kind?: number | null): boolean {
  return kind === RecurrenceKind.Weekly || kind === RecurrenceKind.DateRange;
}
