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
  return 'past';
}
