import { BookingStatus, TripStatus } from '../../common/enums';

export type RiderHistoryBucket = 'current' | 'upcoming' | 'past';

const CAIRO_TZ = 'Africa/Cairo';

/** YYYY-MM-DD in Africa/Cairo. Egypt is UTC+2 year round. */
export function cairoDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Rider history bucket from the trip appointment, not the booking creation time.
 * Confirmed / Booked / DriverAssigned are not current.
 * InProgress is current only on the same Cairo calendar day as [now].
 */
export function riderHistoryBucket(input: {
  bookingStatus: number;
  tripStatus: number;
  scheduledAt: Date;
  now?: Date;
}): RiderHistoryBucket {
  const now = input.now ?? new Date();
  if (
    input.bookingStatus === BookingStatus.Cancelled ||
    input.bookingStatus === BookingStatus.Expired ||
    input.tripStatus === TripStatus.Cancelled
  ) {
    return 'past';
  }
  if (input.tripStatus === TripStatus.Completed) return 'past';

  const sameDay = cairoDateKey(input.scheduledAt) === cairoDateKey(now);
  if (input.tripStatus === TripStatus.InProgress && sameDay) return 'current';
  if (input.scheduledAt.getTime() > now.getTime()) return 'upcoming';
  // معاد النهاردة عدّى والرحلة لسه مش مكتملة ولا ملغية: تفضل حالية عند الراكب.
  if (sameDay) return 'current';
  return 'past';
}

function sameCairoDay(left: Date | null, right: Date): boolean {
  if (!left) return false;
  return cairoDateKey(left) === cairoDateKey(right);
}

function createdOnOrAfterToday(createdAt: Date, now: Date): boolean {
  return cairoDateKey(createdAt) >= cairoDateKey(now);
}

/** Matches rideBucketSql. Status values are RideRequestStatus. */
export function rideHistoryBucket(input: {
  status: number;
  scheduledFor: Date | null;
  startedAt: Date | null;
  createdAt: Date;
  now?: Date;
}): RiderHistoryBucket {
  const now = input.now ?? new Date();
  const onSchedule =
    input.scheduledFor != null || (input.status === 3 && input.startedAt != null);
  const appointment = input.scheduledFor ?? input.startedAt;
  const today = sameCairoDay(appointment, now) && input.status === 3;
  const createdToday = createdOnOrAfterToday(input.createdAt, now);
  if (input.status !== 4 && input.status !== 5) {
    if ((onSchedule && today) || (!onSchedule && createdToday && input.status === 3)) {
      return 'current';
    }
    if (
      (onSchedule && !today && appointment != null && appointment.getTime() > now.getTime()) ||
      (!onSchedule && createdToday && input.status !== 3)
    ) {
      return 'upcoming';
    }
  }
  return 'past';
}

/** Matches groupBucketSql. Status 4 is in progress, 5 completed, 6 cancelled. */
export function groupHistoryBucket(input: {
  status: number;
  startedAt: Date | null;
  createdAt: Date;
  now?: Date;
}): RiderHistoryBucket {
  const now = input.now ?? new Date();
  const started = input.status === 4 && input.startedAt != null;
  const startedToday = started && sameCairoDay(input.startedAt, now);
  const createdToday = createdOnOrAfterToday(input.createdAt, now);
  if (input.status !== 5 && input.status !== 6) {
    if (startedToday || (!started && createdToday && input.status === 4)) return 'current';
    if (
      (started && !startedToday && input.startedAt != null && input.startedAt.getTime() > now.getTime()) ||
      (!started && createdToday && input.status !== 4)
    ) {
      return 'upcoming';
    }
  }
  return 'past';
}
